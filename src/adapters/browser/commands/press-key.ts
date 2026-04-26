import { attach, evaluate, type CdpAttachOptions, type CdpSession } from "../cdp.ts";
import { runAction, type ActionCheck } from "../actions/action-loop.ts";
import type { NetworkMatcher } from "../actions/network-expect.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

type SupportedKey =
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "Enter"
  | "Escape"
  | "Tab";

interface PressKeyArgs extends CdpAttachOptions {
  selector?: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  key: string;
  repeat?: number;
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

interface KeyTargetSummary {
  tagName: string;
  id: string | null;
  classes: string[];
  ariaLabel: string | null;
  role: string | null;
  inputType: string | null;
  isContentEditable: boolean;
  beforeValue: string | null;
  activeBefore: boolean;
}

interface PrepareKeyResult {
  ok: true;
  target: KeyTargetSummary;
}

interface CurrentState {
  url: string;
  title: string;
  readyState: string;
  capturedAt: string;
}

export async function pressKeyCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as PressKeyArgs;
  assertPressKeyInputs(args);

  const key = normalizeSupportedKey(args.key);
  const repeat = normalizeRepeat(args.repeat);
  const keyToken = `frontier-${invocation.invocationId}`;
  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  let pressedTarget: KeyTargetSummary | null = null;
  try {
    const networkMatcher = buildNetworkMatcher(args);
    const result = await runAction({
      session,
      ...(networkMatcher ? { expectNetwork: networkMatcher } : {}),
      networkTimeoutMs: 5000,
      expectStable: { quietMs: 300, timeoutMs: 5000 },
      expectDomExpression: buildExpectationScript(args, keyToken),
      noToast: ["error", "warning"],
      action: async () => {
        try {
          await session.client.Page.bringToFront();
        } catch {
          /* some targets reject bringToFront */
        }
        const prepared = await evaluate<
          PrepareKeyResult | { ok: false; reason: string }
        >(session, {
          expression: buildPrepareKeyScript(args, keyToken),
          awaitPromise: false,
          returnByValue: true,
        });
        if (!prepared.ok) throw new Error(prepared.reason);
        pressedTarget = prepared.target;
        for (let index = 0; index < repeat; index += 1) {
          await dispatchKey(session, key);
        }
      },
    });

    const failedChecks = result.checks.filter((check) => check.status === "failed");
    const currentState = await captureCurrentState(session);
    const outputUrl = summarizeOutputUrl(currentState.url);
    const actionSummary = `pressed ${key}${repeat > 1 ? ` x${repeat}` : ""} on ${describeTarget(pressedTarget)}`;
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `${actionSummary} at ${outputUrl}`
        : `press-key failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        url: outputUrl,
        title: currentState.title,
        readyState: currentState.readyState,
        helperInstalled: session.helperInstalled,
        requested: requestedKeyPress(args, key, repeat),
        pressedTarget,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        capturedAt: currentState.capturedAt,
        ...(result.network ? { network: result.network } : {}),
      },
      ...(pressedTarget
        ? {
            sideEffects: [
              {
                class: "shared_write",
                target: outputUrl,
                summary: actionSummary,
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

function assertPressKeyInputs(args: PressKeyArgs): void {
  if (
    typeof args.selector !== "string" &&
    typeof args.text !== "string" &&
    typeof args.ariaLabel !== "string"
  ) {
    throw new Error(
      "press-key requires at least one locator: selector, text, or ariaLabel",
    );
  }
  if (typeof args.key !== "string" || args.key.trim().length === 0) {
    throw new Error("press-key requires `arguments.key`");
  }
  normalizeSupportedKey(args.key);
}

function normalizeSupportedKey(raw: string): SupportedKey {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "arrowdown":
      return "ArrowDown";
    case "arrowleft":
      return "ArrowLeft";
    case "arrowright":
      return "ArrowRight";
    case "arrowup":
      return "ArrowUp";
    case "enter":
      return "Enter";
    case "escape":
    case "esc":
      return "Escape";
    case "tab":
      return "Tab";
    default:
      throw new Error(
        "press-key currently supports only ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Enter, Escape, or Tab",
      );
  }
}

function normalizeRepeat(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(20, Math.max(1, Math.round(value)));
}

async function dispatchKey(
  session: CdpSession,
  key: SupportedKey,
): Promise<void> {
  const metadata = describeDispatchKey(key);
  if (key === "Enter") {
    await session.client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: metadata.key,
      code: metadata.code,
      text: "\r",
      unmodifiedText: "\r",
      windowsVirtualKeyCode: metadata.windowsVirtualKeyCode,
      nativeVirtualKeyCode: metadata.windowsVirtualKeyCode,
    });
    await session.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: metadata.key,
      code: metadata.code,
      windowsVirtualKeyCode: metadata.windowsVirtualKeyCode,
      nativeVirtualKeyCode: metadata.windowsVirtualKeyCode,
    });
    return;
  }
  await session.client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: metadata.key,
    code: metadata.code,
    windowsVirtualKeyCode: metadata.windowsVirtualKeyCode,
    nativeVirtualKeyCode: metadata.windowsVirtualKeyCode,
  });
  await session.client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: metadata.key,
    code: metadata.code,
    windowsVirtualKeyCode: metadata.windowsVirtualKeyCode,
    nativeVirtualKeyCode: metadata.windowsVirtualKeyCode,
  });
}

function describeDispatchKey(
  key: SupportedKey,
): { key: string; code: string; windowsVirtualKeyCode: number } {
  switch (key) {
    case "ArrowDown":
      return { key, code: "ArrowDown", windowsVirtualKeyCode: 40 };
    case "ArrowLeft":
      return { key, code: "ArrowLeft", windowsVirtualKeyCode: 37 };
    case "ArrowRight":
      return { key, code: "ArrowRight", windowsVirtualKeyCode: 39 };
    case "ArrowUp":
      return { key, code: "ArrowUp", windowsVirtualKeyCode: 38 };
    case "Enter":
      return { key, code: "Enter", windowsVirtualKeyCode: 13 };
    case "Escape":
      return { key, code: "Escape", windowsVirtualKeyCode: 27 };
    case "Tab":
      return { key, code: "Tab", windowsVirtualKeyCode: 9 };
  }
}

function buildNetworkMatcher(args: PressKeyArgs): NetworkMatcher | null {
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

function buildPrepareKeyScript(args: PressKeyArgs, keyToken: string): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    keyToken,
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      const tag = String(el.tagName || '').toLowerCase();
      const type = lower(el.getAttribute && el.getAttribute('type'));
      if (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (el.isContentEditable) return 'textbox';
      if (tag === 'input') {
        if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
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
    const isDisabled = (el) =>
      Boolean(
        el &&
          (('disabled' in el && el.disabled) ||
            lower(el.getAttribute && el.getAttribute('aria-disabled')) === 'true'),
      );
    const isFocusable = (el) => {
      if (!el || !isVisible(el) || isDisabled(el)) return false;
      if (typeof el.focus !== 'function') return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (el.isContentEditable) return true;
      if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
      if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
      return ['button', 'checkbox', 'combobox', 'link', 'listbox', 'radio', 'textbox'].includes(
        implicitRole(el),
      );
    };
    const readValue = (el) => {
      if (!el) return null;
      if (el.isContentEditable) return normalize(el.textContent || '') || null;
      if ('value' in el && typeof el.value === 'string') return el.value;
      return normalize(el.textContent || '') || null;
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
      if (!isFocusable(el)) return false;
      const role = implicitRole(el);
      if (payload.role && role !== lower(payload.role)) return false;
      const ariaLabel = normalize(el.getAttribute && el.getAttribute('aria-label'));
      if (payload.ariaLabel && !ariaLabel.includes(normalize(payload.ariaLabel))) {
        return false;
      }
      if (payload.text) {
        const associatedText = readAssociatedText(el).toLowerCase();
        if (!associatedText.includes(lower(payload.text))) return false;
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
        'select',
        'button',
        'a[href]',
        '[role]',
        '[tabindex]',
        '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[aria-label]',
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
        reason: 'no focusable element matched the provided key target',
      };
    }
    const wasActive = document.activeElement === target;
    try {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_error) {
      /* non-fatal */
    }
    try {
      if (typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    } catch (_error) {
      try {
        target.focus();
      } catch (_innerError) {
        return {
          ok: false,
          reason: 'matched element could not be focused',
        };
      }
    }
    try {
      target.setAttribute('data-frontier-key-token', payload.keyToken);
    } catch (_error) {
      /* non-fatal */
    }
    return {
      ok: true,
      target: {
        tagName: String(target.tagName || '').toLowerCase(),
        id: target.id || null,
        classes: String(target.className || '')
          .split(/\\s+/)
          .filter(Boolean)
          .slice(0, 8),
        ariaLabel: normalize(target.getAttribute && target.getAttribute('aria-label')) || null,
        role: implicitRole(target) || null,
        inputType:
          normalize(target.getAttribute && target.getAttribute('type')).toLowerCase() || null,
        isContentEditable: Boolean(target.isContentEditable),
        beforeValue: readValue(target),
        activeBefore: wasActive,
      },
    };
  })()`;
}

function buildExpectationScript(args: PressKeyArgs, keyToken: string): string {
  const payload = JSON.stringify({
    keyToken,
    expectValue:
      typeof args.expectValue === "string" && args.expectValue.length > 0
        ? args.expectValue
        : null,
    expectUrlIncludes:
      typeof args.expectUrlIncludes === "string" && args.expectUrlIncludes.length > 0
        ? args.expectUrlIncludes
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
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const failures = [];
    const observed = {
      url: location.href,
      targetValue: null,
      expectSelectorFound: null,
      expectSelectorMissingFound: null,
      pageTextMatched: null,
    };
    const target = document.querySelector(
      '[data-frontier-key-token="' + String(payload.keyToken || '') + '"]',
    );
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
          reason: 'invalid expectSelectorMissing: ' + ((error && error.message) || error),
        };
      }
      if (observed.expectSelectorMissingFound) {
        failures.push('selector expected to be missing is still present');
      }
    }
    if (payload.expectPageTextIncludes) {
      const pageText = normalize(document.body && document.body.innerText);
      observed.pageTextMatched = pageText.includes(normalize(payload.expectPageTextIncludes));
      if (!observed.pageTextMatched) {
        failures.push('page text did not include expected substring');
      }
    }
    if (payload.expectValue) {
      if (!target) {
        failures.push('target not found for expectValue');
      } else {
        const value =
          target.isContentEditable
            ? normalize(target.textContent || '')
            : ('value' in target && typeof target.value === 'string')
              ? target.value
              : normalize(target.textContent || '');
        observed.targetValue = value;
        if (value !== payload.expectValue) {
          failures.push('target value did not match expected value');
        }
      }
    }
    return failures.length === 0
      ? { ok: true, observed }
      : { ok: false, reason: failures.join('; '), observed };
  })()`;
}

async function captureCurrentState(session: CdpSession): Promise<CurrentState> {
  return evaluate<CurrentState>(session, {
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

function requestedKeyPress(
  args: PressKeyArgs,
  key: SupportedKey,
  repeat: number,
): Record<string, unknown> {
  return {
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    key,
    repeat,
    expectValue: args.expectValue ?? null,
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectPageTextIncludesLength:
      typeof args.expectPageTextIncludes === "string"
        ? args.expectPageTextIncludes.length
        : null,
  };
}

function describeTarget(target: KeyTargetSummary | null): string {
  if (!target) return "target";
  const role = target.role ? `[${target.role}]` : "";
  const id = target.id ? `#${target.id}` : "";
  const classes =
    target.classes.length > 0 ? `.${target.classes.slice(0, 2).join(".")}` : "";
  return `${target.tagName}${id}${classes}${role}`;
}

function summarizeFailedChecks(checks: ActionCheck[]): string {
  return checks.map((check) => `${check.name}: ${check.detail ?? check.status}`).join("; ");
}

function suggestedNextActions(
  args: PressKeyArgs,
  failedChecks: ActionCheck[],
): string[] {
  if (failedChecks.length === 0) return [];
  const actions = [
    "frontier adapter invoke browser current-tab --mode read --json",
    "frontier adapter invoke browser inspect-dom --mode read --json",
  ];
  if (typeof args.networkUrlRegex === "string" && args.networkUrlRegex.length > 0) {
    actions.push("frontier adapter invoke browser inspect-network --mode read --json");
  }
  return actions;
}

function summarizeOutputUrl(url: string): string {
  if (!url.startsWith("data:")) return url;
  const comma = url.indexOf(",");
  if (comma <= 0) return "data:";
  return `${url.slice(0, comma)},…`;
}
