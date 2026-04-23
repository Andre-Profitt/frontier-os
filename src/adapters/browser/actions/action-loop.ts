// Generic action/verify loop primitive.
//
// Composes:
//   1. toastWatcher.start() before the action
//   2. Optional network expectation subscription (in parallel with step 3)
//   3. The action itself (a click, a type, a programmatic change)
//   4. Await network match if expected
//   5. waitStable via the page-side helper (SPA settling)
//   6. Optional DOM predicate check (page-side function returning {ok, reason})
//   7. Drain the toast watcher, check no error/warning toasts
//   8. On any verification failure, run the rollback closure and mark
//      rolledBack=true; the check that failed is reported in `checks`
//
// The primitive is adapter-agnostic — any browser-composing adapter can
// use it. salesforce set-filter is the first caller.

import { evaluate, type CdpSession } from "../cdp.ts";
import {
  awaitNetworkMatch,
  type NetworkMatcher,
  type NetworkMatchResult,
} from "./network-expect.ts";

export interface ActionDomPredicateResult {
  ok: boolean;
  reason?: string;
  observed?: unknown;
}

export interface ActionLoopOptions {
  session: CdpSession;
  /** The action itself — typically a click or programmatic mutation. */
  action: () => Promise<void>;
  /** Network expectation. Awaited in parallel with the action. */
  expectNetwork?: NetworkMatcher;
  /** Network expectation timeout in ms. Default 10_000. */
  networkTimeoutMs?: number;
  /** Stability detection via the page-side helper. Default quietMs=500,timeoutMs=8000. */
  expectStable?: { quietMs?: number; timeoutMs?: number };
  /** Page-side JS expression that evaluates to {ok, reason, observed}. Runs after waitStable. */
  expectDomExpression?: string;
  /** Toast classes that, if observed, cause the action to be rolled back. Default ['error','warning']. */
  noToast?: Array<"error" | "warning">;
  /** Called on any verification failure. Default: no-op (caller handles cleanup). */
  rollback?: () => Promise<void>;
  /** Skip the stability wait entirely (for tests that don't need it). */
  skipStability?: boolean;
}

export interface ActionCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
}

export interface ToastEntry {
  kind: string;
  text: string;
  at: number;
}

export interface ActionLoopResult {
  ok: boolean;
  checks: ActionCheck[];
  network?: NetworkMatchResult;
  toasts: ToastEntry[];
  rolledBack: boolean;
  durationMs: number;
}

const DEFAULT_NO_TOAST: Array<"error" | "warning"> = ["error", "warning"];
const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;

export async function runAction(
  opts: ActionLoopOptions,
): Promise<ActionLoopResult> {
  const started = Date.now();
  const checks: ActionCheck[] = [];
  const noToast = opts.noToast ?? DEFAULT_NO_TOAST;

  // 1. Start the toast watcher via the page-side helper.
  try {
    await evaluate(opts.session, {
      expression:
        "(() => { window.__frontier && window.__frontier.toastWatcher && window.__frontier.toastWatcher.start(); return true; })()",
      returnByValue: true,
      awaitPromise: false,
    });
  } catch (err) {
    // If the helper isn't installed this fails silently — we just skip
    // the toast check and mark it skipped.
    checks.push({
      name: "toast-watcher-start",
      status: "skipped",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Register network expectation BEFORE the action so we don't miss it.
  let networkPromise: Promise<NetworkMatchResult> | null = null;
  if (opts.expectNetwork) {
    networkPromise = awaitNetworkMatch(
      opts.session,
      opts.expectNetwork,
      opts.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
    );
  }

  // 3. Run the action.
  let actionErr: Error | null = null;
  try {
    await opts.action();
    checks.push({ name: "action", status: "passed" });
  } catch (err) {
    actionErr = err instanceof Error ? err : new Error(String(err));
    checks.push({
      name: "action",
      status: "failed",
      detail: actionErr.message,
    });
  }

  // 4. Await network match.
  let network: NetworkMatchResult | undefined;
  if (networkPromise) {
    try {
      network = await networkPromise;
      checks.push({
        name: "network",
        status: "passed",
        detail: `${network.method} ${network.url} → ${network.status}`,
      });
    } catch (err) {
      checks.push({
        name: "network",
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    checks.push({ name: "network", status: "skipped" });
  }

  // 5. waitStable.
  if (!opts.skipStability && actionErr === null) {
    const stableOpts = opts.expectStable ?? {};
    const quietMs = stableOpts.quietMs ?? 500;
    const timeoutMs = stableOpts.timeoutMs ?? 8000;
    try {
      await evaluate<{ quietFor: number; totalMs: number } | null>(
        opts.session,
        {
          expression: `window.__frontier && window.__frontier.waitStable ? window.__frontier.waitStable({ quietMs: ${quietMs}, timeoutMs: ${timeoutMs} }) : null`,
          awaitPromise: true,
          returnByValue: true,
          timeout: timeoutMs + 2000,
        },
      );
      checks.push({ name: "stable", status: "passed" });
    } catch (err) {
      checks.push({
        name: "stable",
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    checks.push({ name: "stable", status: "skipped" });
  }

  // 6. DOM predicate.
  if (opts.expectDomExpression && actionErr === null) {
    try {
      const predResult = await evaluate<ActionDomPredicateResult>(
        opts.session,
        {
          expression: opts.expectDomExpression,
          awaitPromise: true,
          returnByValue: true,
        },
      );
      if (predResult && predResult.ok) {
        checks.push({ name: "dom-predicate", status: "passed" });
      } else {
        checks.push({
          name: "dom-predicate",
          status: "failed",
          detail: predResult?.reason ?? "predicate returned ok=false",
        });
      }
    } catch (err) {
      checks.push({
        name: "dom-predicate",
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (!opts.expectDomExpression) {
    checks.push({ name: "dom-predicate", status: "skipped" });
  }

  // 7. Drain toast watcher.
  let toasts: ToastEntry[] = [];
  try {
    toasts = await evaluate<ToastEntry[]>(opts.session, {
      expression:
        "window.__frontier && window.__frontier.toastWatcher ? window.__frontier.toastWatcher.drain() : []",
      returnByValue: true,
      awaitPromise: false,
    });
  } catch (err) {
    checks.push({
      name: "toast-drain",
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const badToasts = toasts.filter((t) =>
    (noToast as string[]).includes(t.kind),
  );
  if (badToasts.length > 0) {
    checks.push({
      name: "no-toast",
      status: "failed",
      detail: `${badToasts.length} blocked toasts: ${badToasts.map((t) => `[${t.kind}] ${t.text}`).join("; ")}`,
    });
  } else {
    checks.push({ name: "no-toast", status: "passed" });
  }

  // 8. Summarize + roll back on any failure.
  const ok = checks.every(
    (c) => c.status === "passed" || c.status === "skipped",
  );
  let rolledBack = false;
  if (!ok && opts.rollback) {
    try {
      await opts.rollback();
      rolledBack = true;
    } catch (rollbackErr) {
      checks.push({
        name: "rollback",
        status: "failed",
        detail:
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr),
      });
    }
  }

  const result: ActionLoopResult = {
    ok,
    checks,
    toasts,
    rolledBack,
    durationMs: Date.now() - started,
  };
  if (network) result.network = network;
  return result;
}
