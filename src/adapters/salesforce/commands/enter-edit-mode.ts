import { attach, evaluate, type CdpAttachOptions } from "../../browser/cdp.ts";
import { runAction } from "../../browser/actions/action-loop.ts";
import type { NetworkMatcher } from "../../browser/actions/network-expect.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface EnterEditModeArgs extends CdpAttachOptions {
  urlHint?: string;
  selector?: string;
  buttonText?: string;
  ariaLabel?: string;
  withHelper?: boolean;
  networkUrlRegex?: string;
  networkMethod?: string;
  acceptFailedNetwork?: boolean;
  expectEditSelector?: string;
}

interface EditControlSummary {
  tagName: string;
  id: string | null;
  classes: string[];
  text: string | null;
  ariaLabel: string | null;
  title: string | null;
}

const DEFAULT_URL_MATCH = /salesforce|lightning|force\.com/i;
const DEFAULT_BUTTON_TEXT = "Edit";

export async function enterEditModeCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as EnterEditModeArgs;

  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  if (args.target === undefined) {
    if (args.urlHint) {
      const hint = args.urlHint;
      attachOpts.matchUrl = (url: string) => url.includes(hint);
    } else {
      attachOpts.matchUrl = (url: string) => DEFAULT_URL_MATCH.test(url);
    }
  }
  attachOpts.installHelper = args.withHelper ?? true;

  let session;
  try {
    session = await attach(attachOpts);
  } catch (firstErr) {
    if (args.target === undefined && !args.urlHint) {
      delete attachOpts.matchUrl;
      session = await attach(attachOpts);
    } else {
      throw firstErr;
    }
  }

  let clickedControl: EditControlSummary | null = null;
  try {
    const urlBefore = session.target.url;
    const networkMatcher = buildNetworkMatcher(args);
    const result = await runAction({
      session,
      ...(networkMatcher ? { expectNetwork: networkMatcher } : {}),
      networkTimeoutMs: 8000,
      expectStable: { quietMs: 500, timeoutMs: 8000 },
      expectDomExpression: buildVerifyScript(args, urlBefore),
      noToast: ["error", "warning"],
      rollback: async () => {
        try {
          await session.client.Page.navigate({ url: urlBefore });
        } catch {
          /* best effort */
        }
      },
      action: async () => {
        const out = await evaluate<
          { ok: true; control: EditControlSummary } | { ok: false; reason: string }
        >(session, {
          expression: buildEnterEditScript(args),
          awaitPromise: false,
          returnByValue: true,
        });
        if (!out.ok) throw new Error(out.reason);
        clickedControl = out.control;
      },
    });

    const failedChecks = result.checks.filter((check) => check.status === "failed");
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `entered edit mode on ${session.target.url}`
        : `enter-edit-mode failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        url: session.target.url,
        helperInstalled: session.helperInstalled,
        requested: requestedLocator(args),
        clickedControl,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        ...(result.network ? { network: result.network } : {}),
      },
      ...(clickedControl
        ? {
            sideEffects: [
              {
                class: "shared_write",
                target: session.target.url,
                summary: `entered edit mode via ${describeControl(clickedControl)}`,
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

function buildNetworkMatcher(args: EnterEditModeArgs): NetworkMatcher | null {
  if (
    typeof args.networkUrlRegex !== "string" ||
    args.networkUrlRegex.trim().length === 0
  ) {
    return null;
  }
  const matcher: NetworkMatcher = {
    urlRegex: parseRegexLike(args.networkUrlRegex),
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

function buildEnterEditScript(args: EnterEditModeArgs): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    buttonText: args.buttonText ?? DEFAULT_BUTTON_TEXT,
    ariaLabel: args.ariaLabel ?? null,
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
    const controlSummary = (el) => ({
      tagName: String(el.tagName || '').toLowerCase(),
      id: el.id || null,
      classes: String(el.className || '')
        .split(/\\s+/)
        .map((value) => value.trim())
        .filter(Boolean),
      text: normalize(el.textContent || '') || null,
      ariaLabel: normalize(el.getAttribute('aria-label')) || null,
      title: normalize(el.getAttribute('title')) || null,
    });
    const labelFor = (el) => {
      const aria = normalize(el.getAttribute('aria-label'));
      const title = normalize(el.getAttribute('title'));
      const text = normalize(el.textContent || '');
      return [aria, title, text].filter(Boolean).join(' | ');
    };
    const matches = (el) => {
      if (!isVisible(el)) return false;
      if ('disabled' in el && el.disabled) return false;
      const label = labelFor(el).toLowerCase();
      const textNeedle = normalize(payload.buttonText).toLowerCase();
      if (textNeedle && !label.includes(textNeedle)) return false;
      if (payload.ariaLabel) {
        const aria = normalize(el.getAttribute('aria-label')).toLowerCase();
        if (!aria.includes(normalize(payload.ariaLabel).toLowerCase())) return false;
      }
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
        '[aria-label]',
        '[title]',
        'lightning-button',
        'lightning-button-icon',
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

    const control = candidates.find((candidate) => matches(candidate));
    if (!control) {
      return {
        ok: false,
        reason:
          'no visible edit control matched the provided locator or default "Edit" label',
      };
    }
    try {
      control.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_error) {
      /* best effort */
    }
    try {
      control.click();
    } catch (error) {
      return {
        ok: false,
        reason: 'edit click failed: ' + ((error && error.message) || error),
      };
    }
    return { ok: true, control: controlSummary(control) };
  })()`;
}

function buildVerifyScript(
  args: EnterEditModeArgs,
  initialUrl: string,
): string {
  const payload = JSON.stringify({
    expectEditSelector: args.expectEditSelector ?? null,
    initialUrl,
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
    if (payload.expectEditSelector) {
      try {
        const matched = document.querySelector(payload.expectEditSelector);
        if (matched && isVisible(matched)) {
          return {
            ok: true,
            observed: {
              marker: 'selector',
              selector: payload.expectEditSelector,
            },
          };
        }
      } catch (error) {
        return {
          ok: false,
          reason: 'invalid expectEditSelector: ' + ((error && error.message) || error),
        };
      }
    }

    const body = document.body;
    const bodyEditMode =
      (body && body.dataset && (
        body.dataset.frontierEditMode === 'true' ||
        body.dataset.frontierEditState === 'on' ||
        body.dataset.frontierDashboardEditing === 'true'
      )) || false;

    const structuralMarkers = [
      '[data-frontier-edit-mode="true"]',
      '[data-frontier-edit-state="on"]',
      '[data-frontier-dashboard-editing="true"]',
      '[data-edit-mode="true"]',
      '[data-dashboard-editing="true"]',
    ];
    const structuralMatch = structuralMarkers.find((selector) => {
      const element = document.querySelector(selector);
      return Boolean(element && isVisible(element));
    }) || null;

    const controls = Array.from(
      document.querySelectorAll('button, [role="button"], a[href], [aria-label], [title]')
    );
    const editControlVisible = controls.some((control) => {
      if (!isVisible(control)) return false;
      const label = normalize(
        control.getAttribute('aria-label') ||
        control.getAttribute('title') ||
        control.textContent ||
        ''
      ).toLowerCase();
      return (
        label.includes('save') ||
        label.includes('cancel') ||
        label.includes('done')
      );
    });

    const navigated =
      typeof payload.initialUrl === 'string' &&
      payload.initialUrl.length > 0 &&
      location.href !== payload.initialUrl &&
      (/\\/edit\\b/i.test(location.href) ||
        /dashboarddesigner/i.test(location.href) ||
        /builder/i.test(location.href));

    if (bodyEditMode || structuralMatch || editControlVisible || navigated) {
      return {
        ok: true,
        observed: {
          bodyEditMode,
          structuralMatch,
          editControlVisible,
          navigated,
          currentUrl: location.href,
        },
      };
    }

    return {
      ok: false,
      reason:
        'page did not expose an edit-mode marker (expected save/cancel controls, edit marker selector, or edit URL transition)',
      observed: {
        bodyEditMode,
        structuralMatch,
        editControlVisible,
        navigated,
        currentUrl: location.href,
      },
    };
  })()`;
}

function requestedLocator(args: EnterEditModeArgs): Record<string, unknown> {
  return {
    selector: args.selector ?? null,
    buttonText: args.buttonText ?? DEFAULT_BUTTON_TEXT,
    ariaLabel: args.ariaLabel ?? null,
    expectEditSelector: args.expectEditSelector ?? null,
  };
}

function describeControl(control: EditControlSummary | null): string {
  if (!control) return "edit control";
  const label = control.ariaLabel ?? control.title ?? control.text ?? control.tagName;
  return `${label} (${control.tagName})`;
}

function summarizeFailedChecks(
  failedChecks: Array<{ name: string; detail?: string }>,
): string {
  if (failedChecks.length === 0) return "unknown verification failure";
  return failedChecks
    .map((check) => `${check.name}${check.detail ? `: ${check.detail}` : ""}`)
    .join("; ");
}

function suggestedNextActions(
  args: EnterEditModeArgs,
  failedChecks: Array<{ name: string }>,
): string[] {
  const actions: string[] = [];
  if (failedChecks.some((check) => check.name === "action")) {
    actions.push(
      typeof args.selector === "string" && args.selector.length > 0
        ? "confirm the provided selector points at the dashboard Edit control"
        : 'pass { selector: "..." } for dashboards whose Edit button label is not plain "Edit"',
    );
  }
  if (failedChecks.some((check) => check.name === "dom-predicate")) {
    actions.push(
      'pass { expectEditSelector: "..." } when the dashboard exposes a custom edit-state marker',
    );
  }
  if (failedChecks.some((check) => check.name === "network")) {
    actions.push(
      "relax or remove networkUrlRegex if edit mode does not issue a matching request",
    );
  }
  if (actions.length === 0) {
    actions.push(
      "retry against a live dashboard tab or pass { urlHint: '...' } to target the intended tab",
    );
  }
  return actions;
}
