import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { runAction, type ActionCheck } from "../actions/action-loop.ts";
import type { NetworkMatcher } from "../actions/network-expect.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface EnterTextArgs extends CdpAttachOptions {
  selector?: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  value: string;
  clearFirst?: boolean;
  withHelper?: boolean;
  networkUrlRegex?: string;
  networkMethod?: string;
  acceptFailedNetwork?: boolean;
  expectValue?: string;
  expectUrlIncludes?: string;
  expectSelector?: string;
  expectSelectorMissing?: string;
  expectPageTextIncludes?: string;
}

interface TextTargetSummary {
  tagName: string;
  id: string | null;
  classes: string[];
  ariaLabel: string | null;
  role: string | null;
  inputType: string | null;
  isContentEditable: boolean;
  beforeValueLength: number;
}

interface PrepareTextResult {
  ok: true;
  target: TextTargetSummary;
  previousValue: string;
}

export async function enterTextCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as EnterTextArgs;
  assertEnterTextInputs(args);

  const textToken = `frontier-${invocation.invocationId}`;
  const clearFirst = args.clearFirst ?? true;
  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  let enteredTarget: TextTargetSummary | null = null;
  let previousValue = "";
  try {
    const outputUrl = summarizeOutputUrl(session.target.url);
    const networkMatcher = buildNetworkMatcher(args);
    const result = await runAction({
      session,
      ...(networkMatcher ? { expectNetwork: networkMatcher } : {}),
      networkTimeoutMs: 5000,
      expectStable: { quietMs: 300, timeoutMs: 5000 },
      expectDomExpression: buildExpectationScript(args, textToken, clearFirst),
      noToast: ["error", "warning"],
      rollback: async () => {
        await evaluate(session, {
          expression: buildAssignValueScript(textToken, previousValue),
          awaitPromise: false,
          returnByValue: true,
        });
      },
      action: async () => {
        const prepared = await evaluate<
          PrepareTextResult | { ok: false; reason: string }
        >(session, {
          expression: buildPrepareTextScript(args, textToken, clearFirst),
          awaitPromise: false,
          returnByValue: true,
        });
        if (!prepared.ok) throw new Error(prepared.reason);
        enteredTarget = prepared.target;
        previousValue = prepared.previousValue;

        if (args.value.length === 0) {
          await evaluate(session, {
            expression: buildAssignValueScript(textToken, ""),
            awaitPromise: false,
            returnByValue: true,
          });
          return;
        }
        await session.client.Input.insertText({ text: args.value });
      },
    });

    const failedChecks = result.checks.filter((check) => check.status === "failed");
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `entered ${args.value.length} chars into ${describeTarget(enteredTarget)} on ${outputUrl}`
        : `enter-text failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        url: outputUrl,
        helperInstalled: session.helperInstalled,
        requested: requestedLocator(args, clearFirst),
        enteredTextLength: args.value.length,
        enteredTarget,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        ...(result.network ? { network: result.network } : {}),
      },
      ...(enteredTarget
        ? {
            sideEffects: [
              {
                class: "shared_write",
                target: outputUrl,
                summary: `entered ${args.value.length} chars into ${describeTarget(enteredTarget)}`,
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

function assertEnterTextInputs(args: EnterTextArgs): void {
  if (
    typeof args.selector !== "string" &&
    typeof args.text !== "string" &&
    typeof args.ariaLabel !== "string"
  ) {
    throw new Error(
      "enter-text requires at least one locator: selector, text, or ariaLabel",
    );
  }
  if (typeof args.value !== "string") {
    throw new Error("enter-text requires `arguments.value` (string)");
  }
}

function buildNetworkMatcher(args: EnterTextArgs): NetworkMatcher | null {
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

function buildPrepareTextScript(
  args: EnterTextArgs,
  textToken: string,
  clearFirst: boolean,
): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    textToken,
    clearFirst,
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const implicitRole = (el) => {
      const explicit = normalize(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit.toLowerCase();
      const tag = String(el.tagName || '').toLowerCase();
      const type = normalize(el.getAttribute && el.getAttribute('type')).toLowerCase();
      if (tag === 'textarea') return 'textbox';
      if (el.isContentEditable) return 'textbox';
      if (tag === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type || 'text')) {
        return 'textbox';
      }
      return '';
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isEditable = (el) => {
      if (!el || !isVisible(el)) return false;
      if ('disabled' in el && el.disabled) return false;
      if ('readOnly' in el && el.readOnly) return false;
      const tag = String(el.tagName || '').toLowerCase();
      const type = normalize(el.getAttribute && el.getAttribute('type')).toLowerCase();
      if (el.isContentEditable) return true;
      if (tag === 'textarea') return true;
      if (tag !== 'input') return implicitRole(el) === 'textbox';
      return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type || 'text');
    };
    const readValue = (el) => {
      if (!el) return '';
      if (el.isContentEditable) return normalize(el.textContent || '');
      if ('value' in el && typeof el.value === 'string') return el.value;
      return normalize(el.textContent || '');
    };
    const readAssociatedText = (el) => {
      const values = [];
      const push = (value) => {
        const normalized = normalize(value);
        if (normalized) values.push(normalized);
      };
      push(el.getAttribute && el.getAttribute('aria-label'));
      push(el.getAttribute && el.getAttribute('placeholder'));
      push(el.getAttribute && el.getAttribute('name'));
      push(el.getAttribute && el.getAttribute('title'));
      push(el.id);
      push(readValue(el));
      if (el.labels && el.labels.length > 0) {
        for (const label of el.labels) push(label.textContent || '');
      }
      const ancestorLabel = el.closest && el.closest('label');
      if (ancestorLabel) push(ancestorLabel.textContent || '');
      return values.join(' | ');
    };
    const matches = (el) => {
      if (!isEditable(el)) return false;
      const role = implicitRole(el);
      if (payload.role && role !== normalize(payload.role).toLowerCase()) return false;
      const ariaLabel = normalize(el.getAttribute && el.getAttribute('aria-label'));
      const labelText = readAssociatedText(el);
      if (payload.ariaLabel && !ariaLabel.includes(normalize(payload.ariaLabel))) {
        return false;
      }
      if (payload.text && !labelText.toLowerCase().includes(normalize(payload.text).toLowerCase())) {
        return false;
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
        'input',
        'textarea',
        '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[role="textbox"]',
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

    const target = candidates.find((candidate) => matches(candidate));
    if (!target) {
      return {
        ok: false,
        reason: 'no visible editable element matched the provided text-entry locator',
      };
    }
    const previousValue = readValue(target);
    try {
      target.setAttribute('data-frontier-text-token', payload.textToken);
    } catch (_error) {
      /* non-fatal */
    }
    try {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_error) {
      /* non-fatal */
    }
    try {
      target.focus();
    } catch (error) {
      return {
        ok: false,
        reason: 'focus failed: ' + ((error && error.message) || error),
      };
    }
    try {
      if (payload.clearFirst) {
        if (target.isContentEditable) {
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.selectNodeContents(target);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else if ('setSelectionRange' in target && typeof target.setSelectionRange === 'function') {
          const current = readValue(target);
          target.setSelectionRange(0, current.length);
        }
      } else if ('setSelectionRange' in target && typeof target.setSelectionRange === 'function') {
        const current = readValue(target);
        target.setSelectionRange(current.length, current.length);
      } else if (target.isContentEditable) {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    } catch (_error) {
      /* non-fatal */
    }
    return {
      ok: true,
      previousValue,
      target: {
        tagName: String(target.tagName || '').toLowerCase(),
        id: target.id || null,
        classes: String(target.className || '')
          .split(/\\s+/)
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 8),
        ariaLabel: normalize(target.getAttribute && target.getAttribute('aria-label')) || null,
        role: implicitRole(target) || null,
        inputType: normalize(target.getAttribute && target.getAttribute('type')).toLowerCase() || null,
        isContentEditable: Boolean(target.isContentEditable),
        beforeValueLength: previousValue.length,
      },
    };
  })()`;
}

function buildAssignValueScript(textToken: string, value: string): string {
  const payload = JSON.stringify({ textToken, value });
  return `(() => {
    const payload = ${payload};
    const target = document.querySelector(
      '[data-frontier-text-token="' + payload.textToken + '"]',
    );
    if (!target) {
      return { ok: false, reason: 'typed target token not found' };
    }
    try {
      target.focus && target.focus();
      if (target.isContentEditable) {
        target.textContent = payload.value;
      } else if ('value' in target) {
        target.value = payload.value;
      } else {
        target.textContent = payload.value;
      }
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'value assignment failed: ' + ((error && error.message) || error),
      };
    }
  })()`;
}

function buildExpectationScript(
  args: EnterTextArgs,
  textToken: string,
  clearFirst: boolean,
): string {
  const payload = JSON.stringify({
    expectedValue:
      typeof args.expectValue === "string" ? args.expectValue : args.value,
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectPageTextIncludes: args.expectPageTextIncludes ?? null,
    textToken,
    clearFirst,
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const failures = [];
    const observed = {
      url: location.href,
      targetFound: false,
      targetValueLength: 0,
      expectSelectorFound: null,
      expectSelectorMissingFound: null,
      pageTextMatched: null,
    };
    if (payload.expectUrlIncludes && !location.href.includes(payload.expectUrlIncludes)) {
      failures.push('url did not include expected substring');
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
        failures.push('expected selector not found');
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
        failures.push('selector should be absent after text entry');
      }
    }
    const target = document.querySelector(
      '[data-frontier-text-token="' + payload.textToken + '"]',
    );
    observed.targetFound = Boolean(target);
    const readValue = (el) => {
      if (!el) return '';
      if (el.isContentEditable) return normalize(el.textContent || '');
      if ('value' in el && typeof el.value === 'string') return el.value;
      return normalize(el.textContent || '');
    };
    const observedValue = target ? readValue(target) : '';
    observed.targetValueLength = observedValue.length;
    const expectedValue = normalize(payload.expectedValue);
    if (!target) {
      failures.push('typed target not found for verification');
    } else if (payload.clearFirst) {
      if (normalize(observedValue) !== expectedValue) {
        failures.push('target value did not match expected text');
      }
    } else if (!normalize(observedValue).includes(expectedValue)) {
      failures.push('target value did not include expected text');
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

function requestedLocator(
  args: EnterTextArgs,
  clearFirst: boolean,
): Record<string, unknown> {
  return {
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    clearFirst,
    expectValueLength:
      typeof args.expectValue === "string" ? args.expectValue.length : args.value.length,
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectPageTextIncludesLength:
      typeof args.expectPageTextIncludes === "string"
        ? args.expectPageTextIncludes.length
        : null,
  };
}

function describeTarget(target: TextTargetSummary | null): string {
  if (!target) return "element";
  const tag = target.tagName || "element";
  const id = target.id ? `#${target.id}` : "";
  return `${tag}${id}`;
}

function summarizeOutputUrl(url: string): string {
  if (!url.startsWith("data:")) return url;
  const comma = url.indexOf(",");
  const prefix = comma >= 0 ? url.slice(0, comma) : url;
  return `${prefix},…`;
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
  args: EnterTextArgs,
  failedChecks: ActionCheck[],
): string[] {
  if (failedChecks.length === 0) return [];
  const suggestions: string[] = [];
  if (
    typeof args.expectSelector !== "string" &&
    typeof args.expectSelectorMissing !== "string" &&
    typeof args.expectUrlIncludes !== "string" &&
    typeof args.expectPageTextIncludes !== "string" &&
    typeof args.networkUrlRegex !== "string"
  ) {
    suggestions.push(
      "add expectSelector, expectPageTextIncludes, or networkUrlRegex so the text entry verifies a real post-type effect",
    );
  }
  if (failedChecks.some((check) => check.name === "network")) {
    suggestions.push("confirm the expected request fired or tighten networkUrlRegex");
  }
  if (failedChecks.some((check) => check.name === "dom-predicate")) {
    suggestions.push("check the text-entry selector/value expectation against the live page");
  }
  return suggestions;
}
