import { attach, evaluate, type CdpAttachOptions, type CdpSession } from "../cdp.ts";
import { runAction, type ActionCheck } from "../actions/action-loop.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface NavigateArgs extends CdpAttachOptions {
  url: string;
  withHelper?: boolean;
  expectUrlIncludes?: string;
  expectTitleIncludes?: string;
  expectSelector?: string;
  expectSelectorMissing?: string;
  expectPageTextIncludes?: string;
  timeoutMs?: number;
}

interface NavigatedState {
  url: string;
  title: string;
  readyState: string;
  capturedAt: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;

export async function navigateCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as NavigateArgs;
  assertNavigateArgs(args);

  const timeoutMs = clampTimeout(args.timeoutMs);
  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  const fromUrl = session.target.url;
  let finalState: NavigatedState | null = null;
  try {
    const { Page } = session.client;
    await Page.enable();
    const rollback = async (): Promise<void> => {
      try {
        const history = await Page.getNavigationHistory();
        const previous = history.entries[history.currentIndex - 1];
        if (previous) {
          await Page.navigateToHistoryEntry({ entryId: previous.id });
          await waitForNavigation(session, previous.url, timeoutMs);
          return;
        }
      } catch {
        /* fall through */
      }
      await Page.navigate({ url: fromUrl });
      await waitForNavigation(session, fromUrl, timeoutMs);
    };

    const result = await runAction({
      session,
      expectStable: { quietMs: 300, timeoutMs: Math.min(timeoutMs, 8000) },
      expectDomExpression: buildExpectationScript(args),
      noToast: ["error", "warning"],
      rollback,
      action: async () => {
        const out = await Page.navigate({ url: args.url });
        if (typeof out.errorText === "string" && out.errorText.length > 0) {
          throw new Error(out.errorText);
        }
        await waitForNavigation(
          session,
          typeof args.expectUrlIncludes === "string" && args.expectUrlIncludes.length > 0
            ? args.expectUrlIncludes
            : args.url,
          timeoutMs,
        );
      },
    });

    finalState = await captureCurrentState(session);
    const failedChecks = result.checks.filter((check) => check.status === "failed");
    const outputUrl = summarizeOutputUrl(finalState.url);
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `navigated to ${outputUrl}`
        : `navigate failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        fromUrl: summarizeOutputUrl(fromUrl),
        url: outputUrl,
        title: finalState.title,
        readyState: finalState.readyState,
        helperInstalled: session.helperInstalled,
        requested: {
          url: summarizeOutputUrl(args.url),
          expectUrlIncludes: args.expectUrlIncludes ?? null,
          expectTitleIncludes: args.expectTitleIncludes ?? null,
          expectSelector: args.expectSelector ?? null,
          expectSelectorMissing: args.expectSelectorMissing ?? null,
          expectPageTextIncludesLength:
            typeof args.expectPageTextIncludes === "string"
              ? args.expectPageTextIncludes.length
              : null,
          timeoutMs,
        },
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        capturedAt: finalState.capturedAt,
      },
      sideEffects: [
        {
          class: "shared_write",
          target: outputUrl,
          summary: `navigate target tab from ${summarizeOutputUrl(fromUrl)} to ${outputUrl}`,
        },
      ],
      verification: {
        status: result.ok ? "passed" : "failed",
        checks: ["policy", "trace_grade"],
      },
      suggestedNextActions: suggestedNextActions(args, failedChecks),
    });
  } finally {
    await session.close();
  }
}

function assertNavigateArgs(args: NavigateArgs): void {
  if (typeof args.url !== "string" || args.url.trim().length === 0) {
    throw new Error("navigate requires `arguments.url` (non-empty string)");
  }
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  const rounded = Math.round(value);
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, rounded));
}

async function waitForNavigation(
  session: CdpSession,
  expectedUrl: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await captureCurrentState(session);
      if (
        urlMatchesExpectation(state.url, expectedUrl) &&
        state.readyState !== "loading"
      ) {
        return;
      }
    } catch {
      /* retry through transient navigation states */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`navigation timeout after ${timeoutMs}ms`);
}

async function captureCurrentState(session: CdpSession): Promise<NavigatedState> {
  return evaluate<NavigatedState>(session, {
    expression: `
      (() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        capturedAt: new Date().toISOString(),
      }))()
    `,
    awaitPromise: false,
    returnByValue: true,
  });
}

function urlMatchesExpectation(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (expected.startsWith("data:")) return actual.startsWith("data:");
  return actual.includes(expected);
}

function buildExpectationScript(args: NavigateArgs): string {
  const payload = JSON.stringify({
    expectUrlIncludes:
      typeof args.expectUrlIncludes === "string" && args.expectUrlIncludes.length > 0
        ? args.expectUrlIncludes
        : null,
    expectTitleIncludes:
      typeof args.expectTitleIncludes === "string" && args.expectTitleIncludes.length > 0
        ? args.expectTitleIncludes
        : null,
    expectSelector:
      typeof args.expectSelector === "string" && args.expectSelector.length > 0
        ? args.expectSelector
        : null,
    expectSelectorMissing:
      typeof args.expectSelectorMissing === "string" && args.expectSelectorMissing.length > 0
        ? args.expectSelectorMissing
        : null,
    expectPageTextIncludes:
      typeof args.expectPageTextIncludes === "string" && args.expectPageTextIncludes.length > 0
        ? args.expectPageTextIncludes
        : null,
    requestedUrl: args.url,
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const failures = [];
    const observed = {
      url: location.href,
      title: document.title,
      expectSelectorFound: null,
      expectSelectorMissingFound: null,
      pageTextMatched: null,
    };

    const urlMatched =
      location.href === payload.requestedUrl ||
      (String(payload.requestedUrl || '').startsWith('data:')
        ? location.href.startsWith('data:')
        : location.href.includes(payload.requestedUrl));
    if (!urlMatched) {
      failures.push('location did not reach requested URL');
    }
    if (payload.expectUrlIncludes && !location.href.includes(payload.expectUrlIncludes)) {
      failures.push('url did not include expected substring');
    }
    if (
      payload.expectTitleIncludes &&
      !normalize(document.title).includes(normalize(payload.expectTitleIncludes))
    ) {
      failures.push('title did not include expected substring');
    }
    if (payload.expectSelector) {
      try {
        observed.expectSelectorFound = Boolean(document.querySelector(payload.expectSelector));
      } catch (error) {
        return {
          ok: false,
          reason: 'invalid expectSelector: ' + ((error && error.message) || error),
        };
      }
      if (!observed.expectSelectorFound) failures.push('expected selector not found');
    }
    if (payload.expectSelectorMissing) {
      try {
        observed.expectSelectorMissingFound = Boolean(
          document.querySelector(payload.expectSelectorMissing),
        );
      } catch (error) {
        return {
          ok: false,
          reason:
            'invalid expectSelectorMissing: ' + ((error && error.message) || error),
        };
      }
      if (observed.expectSelectorMissingFound) {
        failures.push('selector should be absent after navigation');
      }
    }
    if (payload.expectPageTextIncludes) {
      const pageText = normalize(document.body && document.body.innerText || '');
      observed.pageTextMatched = pageText.includes(normalize(payload.expectPageTextIncludes));
      if (!observed.pageTextMatched) {
        failures.push('page text did not include expected substring');
      }
    }
    return failures.length === 0
      ? { ok: true, observed }
      : { ok: false, reason: failures.join('; '), observed };
  })()`;
}

function summarizeFailedChecks(checks: ActionCheck[]): string {
  if (checks.length === 0) return "verification failed";
  return checks
    .map((check) =>
      check.detail ? `${check.name}: ${check.detail}` : check.name,
    )
    .join("; ");
}

function summarizeOutputUrl(url: string): string {
  if (!url.startsWith("data:")) return url;
  const comma = url.indexOf(",");
  const prefix = comma >= 0 ? url.slice(0, comma) : url;
  return `${prefix},…`;
}

function suggestedNextActions(
  args: NavigateArgs,
  failedChecks: ActionCheck[],
): string[] {
  if (failedChecks.length === 0) return [];
  const suggestions: string[] = [];
  if (
    typeof args.expectTitleIncludes !== "string" &&
    typeof args.expectSelector !== "string" &&
    typeof args.expectSelectorMissing !== "string" &&
    typeof args.expectPageTextIncludes !== "string" &&
    typeof args.expectUrlIncludes !== "string"
  ) {
    suggestions.push(
      "add expectTitleIncludes, expectSelector, or expectPageTextIncludes so navigation verifies the intended destination surface",
    );
  }
  if (failedChecks.some((check) => check.name === "dom-predicate")) {
    suggestions.push("check the post-navigation URL/title/selector expectation against the live destination");
  }
  return suggestions;
}
