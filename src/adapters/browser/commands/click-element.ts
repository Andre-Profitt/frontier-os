import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { runAction, type ActionCheck } from "../actions/action-loop.ts";
import type { NetworkMatcher } from "../actions/network-expect.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface ClickElementArgs extends CdpAttachOptions {
  selector?: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  withHelper?: boolean;
  networkUrlRegex?: string;
  networkMethod?: string;
  acceptFailedNetwork?: boolean;
  expectUrlIncludes?: string;
  expectSelector?: string;
  expectSelectorMissing?: string;
  expectTargetTextIncludes?: string;
  expectTargetAriaLabelIncludes?: string;
}

interface ClickTargetSummary {
  tagName: string;
  id: string | null;
  classes: string[];
  text: string | null;
  ariaLabel: string | null;
  role: string | null;
}

export async function clickElementCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as ClickElementArgs;
  assertClickLocator(args);

  const clickToken = `frontier-${invocation.invocationId}`;
  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  let clickedTarget: ClickTargetSummary | null = null;
  try {
    const networkMatcher = buildNetworkMatcher(args);
    const result = await runAction({
      session,
      ...(networkMatcher ? { expectNetwork: networkMatcher } : {}),
      networkTimeoutMs: 5000,
      expectStable: { quietMs: 300, timeoutMs: 5000 },
      ...(buildExpectationScript(args, clickToken)
        ? { expectDomExpression: buildExpectationScript(args, clickToken)! }
        : {}),
      noToast: ["error", "warning"],
      action: async () => {
        const out = await evaluate<
          { ok: true; target: ClickTargetSummary } | { ok: false; reason: string }
        >(session, {
          expression: buildClickScript(args, clickToken),
          awaitPromise: false,
          returnByValue: true,
        });
        if (!out.ok) throw new Error(out.reason);
        clickedTarget = out.target;
      },
    });

    const failedChecks = result.checks.filter((check) => check.status === "failed");
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `clicked ${describeTarget(clickedTarget)} on ${session.target.url}`
        : `click-element failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        url: session.target.url,
        helperInstalled: session.helperInstalled,
        requested: requestedLocator(args),
        clickedTarget,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        ...(result.network ? { network: result.network } : {}),
      },
      ...(clickedTarget
        ? {
            sideEffects: [
              {
                class: "shared_write",
                target: session.target.url,
                summary: `clicked ${describeTarget(clickedTarget)}`,
              },
            ],
          }
        : {}),
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

function assertClickLocator(args: ClickElementArgs): void {
  if (
    typeof args.selector !== "string" &&
    typeof args.text !== "string" &&
    typeof args.ariaLabel !== "string"
  ) {
    throw new Error(
      "click-element requires at least one locator: selector, text, or ariaLabel",
    );
  }
}

function buildNetworkMatcher(args: ClickElementArgs): NetworkMatcher | null {
  if (typeof args.networkUrlRegex !== "string" || args.networkUrlRegex.length === 0) {
    return null;
  }
  const urlRegex = parseRegexLike(args.networkUrlRegex);
  const matcher: NetworkMatcher = {
    urlRegex,
    acceptLoadingFailed: args.acceptFailedNetwork === true,
  };
  if (typeof args.networkMethod === "string" && args.networkMethod.length > 0) {
    matcher.method = args.networkMethod;
  }
  return matcher;
}

function parseRegexLike(source: string): RegExp {
  const trimmed = source.trim();
  const literal = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
  if (literal) {
    const pattern = literal[1] ?? "";
    const rawFlags = literal[2] ?? "";
    return new RegExp(pattern, sanitizeRegexFlags(rawFlags));
  }
  return new RegExp(trimmed, "");
}

function sanitizeRegexFlags(flags: string): string {
  return [...new Set(flags.split("").filter((flag) => flag !== "g" && flag !== "y"))].join(
    "",
  );
}

function buildClickScript(args: ClickElementArgs, clickToken: string): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    clickToken,
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const matches = (el) => {
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaLabel = normalize(el.getAttribute('aria-label'));
      const text = normalize(
        ('value' in el && typeof el.value === 'string' ? el.value : '') ||
          el.textContent ||
          '',
      );
      if (payload.role && role !== String(payload.role).toLowerCase()) return false;
      if (payload.ariaLabel && !ariaLabel.includes(normalize(payload.ariaLabel))) {
        return false;
      }
      if (payload.text && !text.includes(normalize(payload.text))) return false;
      return true;
    };

    let candidates = [];
    if (payload.selector) {
      try {
        const matched = document.querySelector(payload.selector);
        if (matched) candidates = [matched];
      } catch (error) {
        return {
          ok: false,
          reason: 'invalid selector: ' + ((error && error.message) || error),
        };
      }
    } else {
      const selectors = [
        'button',
        'a[href]',
        '[role="button"]',
        '[role="link"]',
        'input[type="button"]',
        'input[type="submit"]',
        '[aria-label]',
        '[data-testid]',
        '[onclick]',
      ];
      const seen = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          candidates.push(element);
        }
      }
    }

    const target = candidates.find((candidate) => isVisible(candidate) && matches(candidate));
    if (!target) {
      return {
        ok: false,
        reason: 'no visible element matched the provided click locator',
      };
    }
    if ('disabled' in target && target.disabled) {
      return {
        ok: false,
        reason: 'matched element is disabled',
      };
    }
    try {
      target.setAttribute('data-frontier-click-token', payload.clickToken);
    } catch (_error) {
      /* non-fatal */
    }
    try {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_error) {
      /* non-fatal */
    }
    try {
      target.click();
    } catch (error) {
      return {
        ok: false,
        reason: 'click failed: ' + ((error && error.message) || error),
      };
    }
    return {
      ok: true,
      target: {
        tagName: String(target.tagName || '').toLowerCase(),
        id: target.id || null,
        classes: String(target.className || '')
          .split(/\\s+/)
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 8),
        text: normalize(
          ('value' in target && typeof target.value === 'string' ? target.value : '') ||
            target.textContent ||
            '',
        ) || null,
        ariaLabel: normalize(target.getAttribute('aria-label')) || null,
        role: target.getAttribute('role') || null,
      },
    };
  })()`;
}

function buildExpectationScript(
  args: ClickElementArgs,
  clickToken: string,
): string | null {
  const expectations = {
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectTargetTextIncludes: args.expectTargetTextIncludes ?? null,
    expectTargetAriaLabelIncludes: args.expectTargetAriaLabelIncludes ?? null,
  };
  if (Object.values(expectations).every((value) => value === null)) {
    return null;
  }
  const payload = JSON.stringify({ ...expectations, clickToken });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const failures = [];
    const observed = {
      url: location.href,
      targetFound: false,
      targetText: null,
      targetAriaLabel: null,
      expectSelectorFound: null,
      expectSelectorMissingFound: null,
    };

    if (payload.expectUrlIncludes && !location.href.includes(payload.expectUrlIncludes)) {
      failures.push(
        'url did not include "' + payload.expectUrlIncludes + '" (got ' + location.href + ')',
      );
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
      if (!observed.expectSelectorFound) {
        failures.push('expected selector not found: ' + payload.expectSelector);
      }
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
        failures.push(
          'selector should be absent after click: ' + payload.expectSelectorMissing,
        );
      }
    }

    const target = document.querySelector(
      '[data-frontier-click-token="' + payload.clickToken + '"]',
    );
    observed.targetFound = Boolean(target);
    observed.targetText = target
      ? normalize(
          ('value' in target && typeof target.value === 'string' ? target.value : '') ||
            target.textContent ||
            '',
        ) || null
      : null;
    observed.targetAriaLabel = target
      ? normalize(target.getAttribute('aria-label')) || null
      : null;

    if (payload.expectTargetTextIncludes) {
      if (
        !observed.targetText ||
        !observed.targetText.includes(normalize(payload.expectTargetTextIncludes))
      ) {
        failures.push(
          'target text did not include "' + payload.expectTargetTextIncludes + '"',
        );
      }
    }

    if (payload.expectTargetAriaLabelIncludes) {
      if (
        !observed.targetAriaLabel ||
        !observed.targetAriaLabel.includes(
          normalize(payload.expectTargetAriaLabelIncludes),
        )
      ) {
        failures.push(
          'target aria-label did not include "' +
            payload.expectTargetAriaLabelIncludes +
            '"',
        );
      }
    }

    return failures.length === 0
      ? { ok: true, observed }
      : { ok: false, reason: failures.join('; '), observed };
  })()`;
}

function requestedLocator(args: ClickElementArgs): Record<string, unknown> {
  return {
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectTargetTextIncludes: args.expectTargetTextIncludes ?? null,
    expectTargetAriaLabelIncludes: args.expectTargetAriaLabelIncludes ?? null,
  };
}

function describeTarget(target: ClickTargetSummary | null): string {
  if (!target) return "element";
  const tag = target.tagName || "element";
  const id = target.id ? `#${target.id}` : "";
  const text = target.text ? ` "${target.text.slice(0, 48)}"` : "";
  return `${tag}${id}${text}`;
}

function summarizeFailedChecks(checks: ActionCheck[]): string {
  if (checks.length === 0) return "verification failed";
  return checks
    .map((check) =>
      check.detail ? `${check.name}: ${check.detail}` : check.name,
    )
    .join("; ");
}

function suggestedNextActions(
  args: ClickElementArgs,
  failedChecks: ActionCheck[],
): string[] {
  if (failedChecks.length === 0) return [];
  const suggestions: string[] = [];
  if (
    typeof args.expectSelector !== "string" &&
    typeof args.expectSelectorMissing !== "string" &&
    typeof args.expectUrlIncludes !== "string" &&
    typeof args.expectTargetTextIncludes !== "string" &&
    typeof args.expectTargetAriaLabelIncludes !== "string" &&
    typeof args.networkUrlRegex !== "string"
  ) {
    suggestions.push(
      "add expectSelector, expectUrlIncludes, or networkUrlRegex so the click verifies a real post-click effect",
    );
  }
  if (failedChecks.some((check) => check.name === "network")) {
    suggestions.push("confirm the expected request fired or tighten networkUrlRegex");
  }
  if (failedChecks.some((check) => check.name === "dom-predicate")) {
    suggestions.push("check the post-click selector/url expectation against the live page");
  }
  return suggestions;
}
