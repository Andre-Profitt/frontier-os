import { attach, evaluate, type CdpAttachOptions, type CdpSession } from "../cdp.ts";
import { runAction, type ActionCheck } from "../actions/action-loop.ts";
import type { NetworkMatcher } from "../actions/network-expect.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface SelectOptionArgs extends CdpAttachOptions {
  selector?: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  query?: string;
  commitKey?: string;
  optionLabel?: string;
  optionValue?: string;
  optionLoadTimeoutMs?: number;
  withHelper?: boolean;
  networkUrlRegex?: string;
  networkMethod?: string;
  acceptFailedNetwork?: boolean;
  expectValue?: string;
  expectLabel?: string;
  expectUrlIncludes?: string;
  expectSelector?: string;
  expectSelectorMissing?: string;
  expectPageTextIncludes?: string;
}

interface SelectTargetSummary {
  controlKind: "native" | "custom";
  tagName: string;
  id: string | null;
  classes: string[];
  ariaLabel: string | null;
  role: string | null;
  isMultiple: boolean;
  beforeValue: string | null;
  beforeLabel: string | null;
}

interface SelectedOptionSummary {
  id: string | null;
  value: string;
  label: string;
  index: number;
}

interface KeyboardCommitPlanSummary {
  navigationKey: "ArrowDown" | "ArrowUp";
  navigationCount: number;
  commitKey: "Enter";
  targetValue: string;
  targetLabel: string;
}

type QueryPlanMode = "none" | "trusted" | "page";

interface QueryPlanSummary {
  mode: QueryPlanMode;
  text: string | null;
  opened?: boolean;
  commitKey?: "Enter" | null;
}

interface PrepareSelectResult {
  ok: true;
  target: SelectTargetSummary;
  previousIndex: number;
  queryPlan: QueryPlanSummary;
}

interface CompleteSelectResult {
  ok: true;
  selected?: SelectedOptionSummary;
  keyboardPlan?: KeyboardCommitPlanSummary;
}

interface PrepareRestoreResult {
  ok: true;
  queryPlan: QueryPlanSummary;
}

interface RestoreSelectionResult {
  ok: true;
  keyboardPlan?: KeyboardCommitPlanSummary;
}

export async function selectOptionCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as SelectOptionArgs;
  assertSelectOptionInputs(args);

  const selectToken = `frontier-${invocation.invocationId}`;
  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  let selectedTarget: SelectTargetSummary | null = null;
  let selectedOption: SelectedOptionSummary | null = null;
  let previousIndex = -1;
  try {
    const outputUrl = summarizeOutputUrl(session.target.url);
    const networkMatcher = buildNetworkMatcher(args);
    const result = await runAction({
      session,
      ...(networkMatcher ? { expectNetwork: networkMatcher } : {}),
      networkTimeoutMs: 5000,
      expectStable: { quietMs: 300, timeoutMs: 5000 },
      expectDomExpression: buildExpectationScript(args, selectToken),
      noToast: ["error", "warning"],
      rollback: async () => {
        const prepared = await evaluate<
          PrepareRestoreResult | { ok: false; reason: string }
        >(session, {
          expression: buildPrepareRestoreSelectionScript(selectToken, previousIndex),
          awaitPromise: true,
          returnByValue: true,
        });
        if (!prepared.ok) throw new Error(prepared.reason);
        await applyTrustedQueryPlan(session, prepared.queryPlan);
        const restored = await evaluate<
          RestoreSelectionResult | { ok: false; reason: string }
        >(
          session,
          {
            expression: buildFinishRestoreSelectionScript(
              selectToken,
              previousIndex,
              prepared.queryPlan,
            ),
            awaitPromise: true,
            returnByValue: true,
          },
        );
        if (!restored.ok) throw new Error(restored.reason);
        if (restored.keyboardPlan) {
          await applyKeyboardCommitPlan(session, restored.keyboardPlan);
          const finalized = await evaluate<
            RestoreSelectionResult | { ok: false; reason: string }
          >(session, {
            expression: buildFinalizeRestoreKeyboardCommitScript(selectToken),
            awaitPromise: true,
            returnByValue: true,
          });
          if (!finalized.ok) throw new Error(finalized.reason);
        }
      },
      action: async () => {
        const prepared = await evaluate<
          PrepareSelectResult | { ok: false; reason: string }
        >(session, {
          expression: buildPrepareSelectScript(args, selectToken),
          awaitPromise: true,
          returnByValue: true,
        });
        if (!prepared.ok) throw new Error(prepared.reason);
        selectedTarget = prepared.target;
        previousIndex = prepared.previousIndex;
        await applyTrustedQueryPlan(session, prepared.queryPlan);
        const completed = await evaluate<
          CompleteSelectResult | { ok: false; reason: string }
        >(session, {
          expression: buildCompleteSelectScript(args, selectToken, prepared.queryPlan.mode),
          awaitPromise: true,
          returnByValue: true,
        });
        if (!completed.ok) throw new Error(completed.reason);
        if (completed.keyboardPlan) {
          await applyKeyboardCommitPlan(session, completed.keyboardPlan);
          const finalized = await evaluate<
            CompleteSelectResult | { ok: false; reason: string }
          >(session, {
            expression: buildFinalizeKeyboardCommitScript(args, selectToken),
            awaitPromise: true,
            returnByValue: true,
          });
          if (!finalized.ok) throw new Error(finalized.reason);
          if (!finalized.selected) {
            throw new Error("keyboard commit did not return a finalized selection");
          }
          selectedOption = finalized.selected;
          return;
        }
        if (!completed.selected) {
          throw new Error("selection commit did not return a finalized selection");
        }
        selectedOption = completed.selected;
      },
    });

    const failedChecks = result.checks.filter((check) => check.status === "failed");
    const selected = selectedOption as SelectedOptionSummary | null;
    const selectedSummary = selected
      ? `selected "${selected.label}" on ${describeTarget(selectedTarget)}`
      : "selected option";
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `${selectedSummary} at ${outputUrl}`
        : `select-option failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        url: outputUrl,
        helperInstalled: session.helperInstalled,
        requested: requestedSelection(args),
        selectedTarget,
        selectedOption: selected,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        ...(result.network ? { network: result.network } : {}),
      },
      ...(selected
        ? {
            sideEffects: [
              {
                class: "shared_write",
                target: outputUrl,
                summary: `${selectedSummary}`,
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

function assertSelectOptionInputs(args: SelectOptionArgs): void {
  if (
    typeof args.selector !== "string" &&
    typeof args.text !== "string" &&
    typeof args.ariaLabel !== "string"
  ) {
    throw new Error(
      "select-option requires at least one locator: selector, text, or ariaLabel",
    );
  }
  if (
    typeof args.optionLabel !== "string" &&
    typeof args.optionValue !== "string"
  ) {
    throw new Error(
      "select-option requires `arguments.optionLabel` or `arguments.optionValue`",
    );
  }
  if (
    typeof args.commitKey === "string" &&
    args.commitKey.trim().length > 0 &&
    args.commitKey.trim().toLowerCase() !== "enter"
  ) {
    throw new Error(
      "select-option currently supports only `arguments.commitKey=\"Enter\"`",
    );
  }
}

async function applyTrustedQueryPlan(
  session: CdpSession,
  queryPlan: QueryPlanSummary,
): Promise<void> {
  if (queryPlan.mode !== "trusted" || typeof queryPlan.text !== "string") return;
  await session.client.Input.insertText({ text: queryPlan.text });
}

async function applyKeyboardCommitPlan(
  session: CdpSession,
  plan: KeyboardCommitPlanSummary,
): Promise<void> {
  for (let index = 0; index < plan.navigationCount; index += 1) {
    await dispatchKey(session, plan.navigationKey);
  }
  await dispatchKey(session, plan.commitKey);
}

async function dispatchKey(
  session: CdpSession,
  key: "ArrowDown" | "ArrowUp" | "Enter",
): Promise<void> {
  const metadata = describeDispatchKey(key);
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
  key: "ArrowDown" | "ArrowUp" | "Enter",
): { key: string; code: string; windowsVirtualKeyCode: number } {
  switch (key) {
    case "ArrowDown":
      return { key, code: "ArrowDown", windowsVirtualKeyCode: 40 };
    case "ArrowUp":
      return { key, code: "ArrowUp", windowsVirtualKeyCode: 38 };
    case "Enter":
      return { key, code: "Enter", windowsVirtualKeyCode: 13 };
  }
}

function buildNetworkMatcher(args: SelectOptionArgs): NetworkMatcher | null {
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

function buildPrepareSelectScript(args: SelectOptionArgs, selectToken: string): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    query: args.query ?? null,
    commitKey: args.commitKey ?? null,
    optionLabel: args.optionLabel ?? null,
    optionValue: args.optionValue ?? null,
    optionLoadTimeoutMs: args.optionLoadTimeoutMs ?? null,
    selectToken,
  });
  return `(async () => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const optionLoadTimeoutMs = Number.isFinite(Number(payload.optionLoadTimeoutMs))
      ? Math.max(250, Math.round(Number(payload.optionLoadTimeoutMs)))
      : 3000;
    const isDisabled = (el) =>
      Boolean(
        el &&
          (('disabled' in el && el.disabled) ||
            lower(el.getAttribute && el.getAttribute('aria-disabled')) === 'true'),
      );
    const emitClick = (el) => {
      if (!el) return;
      const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        try {
          el.dispatchEvent(new MouseEvent(type, eventInit));
        } catch (_error) {
          /* non-fatal */
        }
      }
      try {
        el.click();
      } catch (_error) {
        /* non-fatal */
      }
    };
    const isEditableField = (el) => {
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return true;
      if (el.isContentEditable) return true;
      return lower(el.getAttribute && el.getAttribute('role')) === 'textbox';
    };
    const editableFieldForControl = (control) => {
      if (!control) return null;
      if (isEditableField(control)) return control;
      return (
        control.querySelector &&
        control.querySelector(
          'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
        )
      ) || null;
    };
    const focusEditableField = (field) => {
      if (!field) return false;
      try {
        field.scrollIntoView({ block: 'center', inline: 'center' });
        field.focus && field.focus();
      } catch (_error) {
        return false;
      }
      try {
        if (field.isContentEditable) {
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.selectNodeContents(field);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else if ('setSelectionRange' in field && typeof field.setSelectionRange === 'function') {
          const current =
            'value' in field && typeof field.value === 'string'
              ? field.value
              : normalize(field.textContent || '');
          field.setSelectionRange(0, current.length);
        }
      } catch (_error) {
        /* non-fatal */
      }
      return true;
    };
    const visibleListboxCandidates = [];
    const pushCandidate = (value) => {
      if (!value || visibleListboxCandidates.includes(value)) return;
      visibleListboxCandidates.push(value);
    };
    const optionIndexFor = (option) => {
      if (!option) return -1;
      const listbox = option.closest && option.closest('[role="listbox"]');
      if (!listbox) return -1;
      return Array.from(listbox.querySelectorAll('[role="option"]')).indexOf(option);
    };
    const findListboxForControl = (control, includeHidden = false) => {
      visibleListboxCandidates.length = 0;
      if (!control) return null;
      if (implicitRole(control) === 'listbox') pushCandidate(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) pushCandidate(document.getElementById(id));
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      if (activeId) {
        const active = document.getElementById(activeId);
        pushCandidate(active && active.closest ? active.closest('[role="listbox"]') : null);
      }
      pushCandidate(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          pushCandidate(listbox);
        }
      }
      if (visibleListboxCandidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) {
          pushCandidate(listbox);
        }
      }
      return (
        visibleListboxCandidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const readSelectedOption = (control) => {
      if (!control) return { id: null, value: '', label: '', index: -1 };
      if (controlKind(control) === 'native') {
        const index = Number.isInteger(control.selectedIndex) ? control.selectedIndex : -1;
        const option = index >= 0 ? control.options[index] : null;
        return {
          id: option ? option.id || null : null,
          value: option ? String(option.value ?? '') : '',
          label: option ? normalize(option.textContent || option.label || '') : '',
          index,
        };
      }
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      let option = activeId ? document.getElementById(activeId) : null;
      if (!option) {
        const listbox = findListboxForControl(control, true);
        if (listbox) {
          option =
            Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]')).find(Boolean) ||
            Array.from(listbox.querySelectorAll('[role="option"]')).find((candidate) =>
              lower(candidate.getAttribute && candidate.getAttribute('data-selected')) === 'true',
            ) ||
            null;
        }
      }
      let value = option ? readOptionValue(option) : '';
      let label = option ? readOptionLabel(option) : '';
      if (!value) {
        value = normalize(
          control.getAttribute && control.getAttribute('data-frontier-selected-value'),
        );
      }
      if (!label) {
        label = normalize(
          control.getAttribute && control.getAttribute('data-frontier-selected-label'),
        );
      }
      if (!value && 'value' in control && typeof control.value === 'string') value = control.value;
      if (!label && 'value' in control && typeof control.value === 'string') {
        label = normalize(control.value);
      }
      return {
        id: option ? option.id || null : null,
        value,
        label,
        index: option ? optionIndexFor(option) : -1,
      };
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const readAssociatedText = (el) => {
      const values = [];
      const push = (value) => {
        const normalized = normalize(value);
        if (normalized) values.push(normalized);
      };
      push(el.getAttribute && el.getAttribute('aria-label'));
      push(el.getAttribute && el.getAttribute('name'));
      push(el.getAttribute && el.getAttribute('title'));
      push(el.id);
      const selected = readSelectedOption(el);
      push(selected.label);
      if (el.labels && el.labels.length > 0) {
        for (const label of el.labels) push(label.textContent || '');
      }
      const ancestorLabel = el.closest && el.closest('label');
      if (ancestorLabel) push(ancestorLabel.textContent || '');
      return values.join(' | ');
    };
    const matches = (el) => {
      if (!el) return false;
      const role = implicitRole(el);
      if (!role || !['combobox', 'listbox'].includes(role)) return false;
      if (!isVisible(el)) return false;
      if (isDisabled(el)) return false;
      if (payload.role && role !== lower(payload.role)) return false;
      const ariaLabel = normalize(el.getAttribute && el.getAttribute('aria-label'));
      if (payload.ariaLabel && !ariaLabel.includes(normalize(payload.ariaLabel))) {
        return false;
      }
      if (payload.text) {
        const labelText = readAssociatedText(el).toLowerCase();
        if (!labelText.includes(lower(payload.text))) return false;
      }
      return true;
    };
    const findOption = (control) => {
      const role = implicitRole(control);
      const options =
        controlKind(control) === 'native'
          ? Array.from(control.options || [])
          : Array.from(
              (findListboxForControl(control, true) || control).querySelectorAll('[role="option"]'),
            ).filter((option) => includeOption(option));
      const exact = options.find((option) => {
        if (payload.optionValue && readOptionValue(option) !== String(payload.optionValue)) {
          return false;
        }
        if (payload.optionLabel && lower(readOptionLabel(option)) !== lower(payload.optionLabel)) {
          return false;
        }
        return true;
      });
      if (exact) return exact;
      return options.find((option) => {
        if (payload.optionValue && readOptionValue(option) !== String(payload.optionValue)) {
          return false;
        }
        if (payload.optionLabel && !lower(readOptionLabel(option)).includes(lower(payload.optionLabel))) {
          return false;
        }
        return true;
      }) || null;
    };
    const includeOption = (option) => {
      if (!option) return false;
      if (controlKind(option) === 'native') return true;
      if (isDisabled(option)) return false;
      return isVisible(option);
    };
    const openCustomControl = (control) => {
      if (!control || controlKind(control) !== 'custom') return;
      if (implicitRole(control) === 'listbox') return;
      try {
        control.scrollIntoView({ block: 'center', inline: 'center' });
        control.focus && control.focus();
      } catch (_error) {
        /* non-fatal */
      }
      emitClick(control);
    };
    const queryText = normalize(payload.query || payload.optionLabel || payload.optionValue || '');

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
      candidates = Array.from(
        document.querySelectorAll(
          'select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-controls]',
        ),
      );
    }

    const target = candidates.find((candidate) => matches(candidate));
    if (!target) {
      return {
        ok: false,
        reason: 'no visible select, combobox, or listbox matched the provided locator',
      };
    }
    if (controlKind(target) === 'native' && target.multiple) {
      return {
        ok: false,
        reason: 'multiple select controls are not supported yet',
      };
    }
    const previous = readSelectedOption(target);
    let queryPlan = {
      mode: 'none',
      text: null,
      commitKey: lower(payload.commitKey) === 'enter' ? 'Enter' : null,
    };
    if (controlKind(target) === 'custom') {
      openCustomControl(target);
      if (queryText) {
        const editor = editableFieldForControl(target);
        queryPlan = {
          mode: editor && focusEditableField(editor) ? 'trusted' : 'page',
          text: queryText,
          commitKey: lower(payload.commitKey) === 'enter' ? 'Enter' : null,
        };
      }
    }
    try {
      target.setAttribute('data-frontier-select-token', payload.selectToken);
      target.setAttribute('data-frontier-select-mode', controlKind(target));
      target.setAttribute('data-frontier-previous-option-id', previous.id || '');
      target.setAttribute('data-frontier-previous-value', previous.value || '');
      target.setAttribute('data-frontier-previous-label', previous.label || '');
      target.setAttribute('data-frontier-commit-key', queryPlan.commitKey || '');
      target.scrollIntoView({ block: 'center', inline: 'center' });
      if (queryPlan.mode !== 'trusted') {
        target.focus && target.focus();
      }
    } catch (_error) {
      /* non-fatal */
    }
    return {
      ok: true,
      previousIndex: previous.index,
      queryPlan,
      target: {
        controlKind: controlKind(target),
        tagName: String(target.tagName || '').toLowerCase(),
        id: target.id || null,
        classes: String(target.className || '')
          .split(/\\s+/)
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 8),
        ariaLabel: normalize(target.getAttribute && target.getAttribute('aria-label')) || null,
        role: implicitRole(target) || null,
        isMultiple: controlKind(target) === 'native' ? Boolean(target.multiple) : false,
        beforeValue: previous.value || null,
        beforeLabel: previous.label || null,
      },
    };
  })()`;
}

function buildCompleteSelectScript(
  args: SelectOptionArgs,
  selectToken: string,
  queryMode: QueryPlanMode,
): string {
  const payload = JSON.stringify({
    selectToken,
    queryMode,
    query: args.query ?? null,
    commitKey: args.commitKey ?? null,
    optionLabel: args.optionLabel ?? null,
    optionValue: args.optionValue ?? null,
    optionLoadTimeoutMs: args.optionLoadTimeoutMs ?? null,
  });
  return `(async () => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const optionLoadTimeoutMs = Number.isFinite(Number(payload.optionLoadTimeoutMs))
      ? Math.max(250, Math.round(Number(payload.optionLoadTimeoutMs)))
      : 3000;
    const isDisabled = (el) =>
      Boolean(
        el &&
          (('disabled' in el && el.disabled) ||
            lower(el.getAttribute && el.getAttribute('aria-disabled')) === 'true'),
      );
    const emitClick = (el) => {
      if (!el) return;
      const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        try {
          el.dispatchEvent(new MouseEvent(type, eventInit));
        } catch (_error) {
          /* non-fatal */
        }
      }
      try {
        el.click();
      } catch (_error) {
        /* non-fatal */
      }
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isEditableField = (el) => {
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return true;
      if (el.isContentEditable) return true;
      return lower(el.getAttribute && el.getAttribute('role')) === 'textbox';
    };
    const editableFieldForControl = (control) => {
      if (!control) return null;
      if (isEditableField(control)) return control;
      return (
        control.querySelector &&
        control.querySelector(
          'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
        )
      ) || null;
    };
    const writeEditableValue = (field, control, value) => {
      if (!field) return false;
      try {
        field.focus && field.focus();
        if (field.isContentEditable) {
          field.textContent = value;
        } else if ('value' in field) {
          field.value = value;
        } else {
          field.textContent = value;
        }
        for (const type of ['input', 'change']) {
          field.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
        }
        if (control && field !== control && 'value' in control && typeof control.value === 'string') {
          control.value = value;
        }
        if (control && field !== control && control.setAttribute) {
          control.setAttribute('data-frontier-query', value);
        }
        return true;
      } catch (_error) {
        return false;
      }
    };
    const optionIndexFor = (option) => {
      if (!option) return -1;
      const listbox = option.closest && option.closest('[role="listbox"]');
      if (!listbox) return -1;
      return Array.from(listbox.querySelectorAll('[role="option"]')).indexOf(option);
    };
    const findListboxForControl = (control, includeHidden = false) => {
      if (!control) return null;
      const candidates = [];
      const push = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };
      if (implicitRole(control) === 'listbox') push(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) push(document.getElementById(id));
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      if (activeId) {
        const active = document.getElementById(activeId);
        push(active && active.closest ? active.closest('[role="listbox"]') : null);
      }
      push(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          push(listbox);
        }
      }
      if (candidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) push(listbox);
      }
      return (
        candidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const includeOption = (option) => {
      if (!option) return false;
      if (controlKind(option) === 'native') return true;
      if (isDisabled(option)) return false;
      return isVisible(option);
    };
    const findOption = (control) => {
      const options =
        controlKind(control) === 'native'
          ? Array.from(control.options || [])
          : Array.from(
              (findListboxForControl(control, true) || control).querySelectorAll('[role="option"]'),
            ).filter((option) => includeOption(option));
      const exact = options.find((option) => {
        if (payload.optionValue && readOptionValue(option) !== String(payload.optionValue)) {
          return false;
        }
        if (payload.optionLabel && lower(readOptionLabel(option)) !== lower(payload.optionLabel)) {
          return false;
        }
        return true;
      });
      if (exact) return exact;
      return options.find((option) => {
        if (payload.optionValue && readOptionValue(option) !== String(payload.optionValue)) {
          return false;
        }
        if (payload.optionLabel && !lower(readOptionLabel(option)).includes(lower(payload.optionLabel))) {
          return false;
        }
        return true;
      }) || null;
    };
    const waitForMatchingOption = async (control) => {
      let option = findOption(control);
      if (option) return option;
      const queryText = normalize(payload.query || payload.optionLabel || payload.optionValue || '');
      if (payload.queryMode === 'page' && queryText && controlKind(control) === 'custom') {
        const editor = editableFieldForControl(control);
        if (editor) {
          const wrote = writeEditableValue(editor, control, queryText);
          if (wrote) await wait(0);
        }
      }
      const started = Date.now();
      while (Date.now() - started < optionLoadTimeoutMs) {
        await wait(50);
        option = findOption(control);
        if (option) return option;
      }
      return null;
    };
    const isSelectedOption = (option) =>
      lower(option?.getAttribute && option.getAttribute('aria-selected')) === 'true' ||
      lower(option?.getAttribute && option.getAttribute('data-selected')) === 'true';
    const buildKeyboardPlan = (control, option) => {
      if (controlKind(control) !== 'custom') return null;
      if (lower(payload.commitKey) !== 'enter') return null;
      const listbox = findListboxForControl(control, true);
      const options = Array.from(
        (listbox || control).querySelectorAll('[role="option"]'),
      ).filter((candidate) => includeOption(candidate));
      const targetIndex = options.indexOf(option);
      if (targetIndex < 0) return null;
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      const activeOption = activeId ? document.getElementById(activeId) : null;
      let activeIndex = options.indexOf(activeOption);
      if (activeIndex < 0) {
        activeIndex = options.findIndex((candidate) => isSelectedOption(candidate));
      }
      if (activeIndex < 0 && isSelectedOption(option)) {
        activeIndex = targetIndex;
      }
      const delta = activeIndex >= 0 ? targetIndex - activeIndex : targetIndex + 1;
      return {
        navigationKey: delta < 0 ? 'ArrowUp' : 'ArrowDown',
        navigationCount: Math.abs(delta),
        commitKey: 'Enter',
        targetValue: readOptionValue(option),
        targetLabel: readOptionLabel(option),
      };
    };
    const selectCustomOption = (option) => {
      if (!option) return;
      try {
        option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch (_error) {
        /* non-fatal */
      }
      emitClick(option);
    };
    const readSelectedOption = (control) => {
      if (!control) return { id: null, value: '', label: '', index: -1 };
      if (controlKind(control) === 'native') {
        const index = Number.isInteger(control.selectedIndex) ? control.selectedIndex : -1;
        const option = index >= 0 ? control.options[index] : null;
        return {
          id: option ? option.id || null : null,
          value: option ? String(option.value ?? '') : '',
          label: option ? normalize(option.textContent || option.label || '') : '',
          index,
        };
      }
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      let option = activeId ? document.getElementById(activeId) : null;
      if (!option) {
        const listbox = findListboxForControl(control, true);
        if (listbox) {
          option =
            Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]')).find(Boolean) ||
            Array.from(listbox.querySelectorAll('[role="option"]')).find((candidate) =>
              lower(candidate.getAttribute && candidate.getAttribute('data-selected')) === 'true',
            ) ||
            null;
        }
      }
      return {
        id: option ? option.id || null : null,
        value: option ? readOptionValue(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-value')),
        label: option ? readOptionLabel(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-label')),
        index: option ? optionIndexFor(option) : -1,
      };
    };
    const target = document.querySelector(
      '[data-frontier-select-token="' + payload.selectToken + '"]',
    );
    if (!target) {
      return { ok: false, reason: 'selected target token not found' };
    }
    const option =
      controlKind(target) === 'custom'
        ? await waitForMatchingOption(target)
        : findOption(target);
    if (!option) {
      const queryText = normalize(payload.query || payload.optionLabel || payload.optionValue || '');
      return {
        ok: false,
        reason: queryText
          ? 'no option matched the requested label/value after combobox search'
          : 'no option matched the requested label/value',
      };
    }
    try {
      target.focus && target.focus();
      if (controlKind(target) === 'native') {
        const index = Array.from(target.options).indexOf(option);
        target.selectedIndex = index;
        target.value = String(option.value ?? '');
      } else if (payload.commitKey) {
        const keyboardPlan = buildKeyboardPlan(target, option);
        if (!keyboardPlan) {
          return {
            ok: false,
            reason: 'keyboard commit plan could not be built for the matched option',
          };
        }
        return { ok: true, keyboardPlan };
      } else {
        selectCustomOption(option);
      }
      const selected = readSelectedOption(target);
      target.setAttribute('data-frontier-selected-value', selected.value || '');
      target.setAttribute('data-frontier-selected-label', selected.label || '');
      if (controlKind(target) === 'native') {
        target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
      return { ok: true, selected };
    } catch (error) {
      return {
        ok: false,
        reason: 'selection commit failed: ' + ((error && error.message) || error),
      };
    }
  })()`;
}

function buildFinalizeKeyboardCommitScript(
  args: SelectOptionArgs,
  selectToken: string,
): string {
  const payload = JSON.stringify({
    selectToken,
    optionLabel: args.optionLabel ?? null,
    optionValue: args.optionValue ?? null,
    optionLoadTimeoutMs: args.optionLoadTimeoutMs ?? null,
  });
  return `(async () => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const optionIndexFor = (option) => {
      if (!option) return -1;
      const listbox = option.closest && option.closest('[role="listbox"]');
      if (!listbox) return -1;
      return Array.from(listbox.querySelectorAll('[role="option"]')).indexOf(option);
    };
    const findListboxForControl = (control, includeHidden = false) => {
      if (!control) return null;
      const candidates = [];
      const push = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };
      if (implicitRole(control) === 'listbox') push(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) push(document.getElementById(id));
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      if (activeId) {
        const active = document.getElementById(activeId);
        push(active && active.closest ? active.closest('[role="listbox"]') : null);
      }
      push(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          push(listbox);
        }
      }
      if (candidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) push(listbox);
      }
      return (
        candidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const readSelectedOption = (control) => {
      if (!control) return { id: null, value: '', label: '', index: -1 };
      if (controlKind(control) === 'native') {
        const index = Number.isInteger(control.selectedIndex) ? control.selectedIndex : -1;
        const option = index >= 0 ? control.options[index] : null;
        return {
          id: option ? option.id || null : null,
          value: option ? String(option.value ?? '') : '',
          label: option ? normalize(option.textContent || option.label || '') : '',
          index,
        };
      }
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      let option = activeId ? document.getElementById(activeId) : null;
      if (!option) {
        const listbox = findListboxForControl(control, true);
        if (listbox) {
          option =
            Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]')).find(Boolean) ||
            Array.from(listbox.querySelectorAll('[role="option"]')).find((candidate) =>
              lower(candidate.getAttribute && candidate.getAttribute('data-selected')) === 'true',
            ) ||
            null;
        }
      }
      return {
        id: option ? option.id || null : null,
        value: option ? readOptionValue(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-value')),
        label: option ? readOptionLabel(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-label')),
        index: option ? optionIndexFor(option) : -1,
      };
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const target = document.querySelector(
      '[data-frontier-select-token="' + payload.selectToken + '"]',
    );
    if (!target) {
      return { ok: false, reason: 'selected target token not found after keyboard commit' };
    }
    const deadline = Date.now() + (
      Number.isFinite(Number(payload.optionLoadTimeoutMs))
        ? Math.max(250, Math.round(Number(payload.optionLoadTimeoutMs)))
        : 3000
    );
    while (Date.now() <= deadline) {
      const selected = readSelectedOption(target);
      const valueMatches =
        payload.optionValue === null || selected.value === String(payload.optionValue);
      const labelMatches =
        payload.optionLabel === null || lower(selected.label) === lower(payload.optionLabel);
      if (valueMatches && labelMatches) {
        target.setAttribute('data-frontier-selected-value', selected.value || '');
        target.setAttribute('data-frontier-selected-label', selected.label || '');
        return { ok: true, selected };
      }
      await wait(50);
    }
    return {
      ok: false,
      reason: 'keyboard commit did not settle on the expected option',
    };
  })()`;
}

function buildPrepareRestoreSelectionScript(
  selectToken: string,
  previousIndex: number,
): string {
  const payload = JSON.stringify({ selectToken, previousIndex });
  return `(async () => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const emitClick = (el) => {
      if (!el) return;
      const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        try {
          el.dispatchEvent(new MouseEvent(type, eventInit));
        } catch (_error) {
          /* non-fatal */
        }
      }
      try {
        el.click();
      } catch (_error) {
        /* non-fatal */
      }
    };
    const isEditableField = (el) => {
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return true;
      if (el.isContentEditable) return true;
      return lower(el.getAttribute && el.getAttribute('role')) === 'textbox';
    };
    const editableFieldForControl = (control) => {
      if (!control) return null;
      if (isEditableField(control)) return control;
      return (
        control.querySelector &&
        control.querySelector(
          'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
        )
      ) || null;
    };
    const focusEditableField = (field) => {
      if (!field) return false;
      try {
        field.scrollIntoView({ block: 'center', inline: 'center' });
        field.focus && field.focus();
      } catch (_error) {
        return false;
      }
      try {
        if (field.isContentEditable) {
          const selection = window.getSelection();
          if (selection) {
            const range = document.createRange();
            range.selectNodeContents(field);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else if ('setSelectionRange' in field && typeof field.setSelectionRange === 'function') {
          const current =
            'value' in field && typeof field.value === 'string'
              ? field.value
              : normalize(field.textContent || '');
          field.setSelectionRange(0, current.length);
        }
      } catch (_error) {
        /* non-fatal */
      }
      return true;
    };
    const findListboxForControl = (control, includeHidden = false) => {
      if (!control) return null;
      const candidates = [];
      const push = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };
      if (implicitRole(control) === 'listbox') push(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) push(document.getElementById(id));
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      if (activeId) {
        const active = document.getElementById(activeId);
        push(active && active.closest ? active.closest('[role="listbox"]') : null);
      }
      push(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          push(listbox);
        }
      }
      if (candidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) push(listbox);
      }
      return (
        candidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const findPreviousOption = (control, previousId, previousValue, previousLabel) => {
      const listbox = findListboxForControl(control, true);
      const options = Array.from((listbox || control).querySelectorAll('[role="option"]'));
      return (
        options.find((candidate) => previousId && candidate.id === previousId) ||
        options.find((candidate) => previousValue && readOptionValue(candidate) === previousValue) ||
        options.find((candidate) => previousLabel && lower(readOptionLabel(candidate)) === lower(previousLabel)) ||
        null
      );
    };
    const target = document.querySelector(
      '[data-frontier-select-token="' + payload.selectToken + '"]',
    );
    if (!target) {
      return { ok: false, reason: 'selected target token not found' };
    }
    const commitKey =
      lower(target.getAttribute && target.getAttribute('data-frontier-commit-key')) === 'enter'
        ? 'Enter'
        : null;
    if (controlKind(target) === 'native') {
      return { ok: true, queryPlan: { mode: 'none', text: null, commitKey: null } };
    }
    const opened = implicitRole(target) !== 'listbox';
    if (opened) emitClick(target);
    const previousId = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-option-id'));
    const previousValue = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-value'));
    const previousLabel = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-label'));
    if (findPreviousOption(target, previousId, previousValue, previousLabel)) {
      return { ok: true, queryPlan: { mode: 'none', text: null, opened, commitKey } };
    }
    const queryText = previousLabel || previousValue || '';
    if (!queryText) {
      return { ok: true, queryPlan: { mode: 'none', text: null, opened, commitKey } };
    }
    const editor = editableFieldForControl(target);
    return {
      ok: true,
      queryPlan: {
        mode: editor && focusEditableField(editor) ? 'trusted' : 'page',
        text: queryText,
        opened,
        commitKey,
      },
    };
  })()`;
}

function buildFinishRestoreSelectionScript(
  selectToken: string,
  previousIndex: number,
  queryPlan: QueryPlanSummary,
): string {
  const payload = JSON.stringify({
    selectToken,
    previousIndex,
    queryMode: queryPlan.mode,
    queryOpened: queryPlan.opened ?? false,
    queryCommitKey: queryPlan.commitKey ?? null,
  });
  return `(async () => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const emitClick = (el) => {
      if (!el) return;
      const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        try {
          el.dispatchEvent(new MouseEvent(type, eventInit));
        } catch (_error) {
          /* non-fatal */
        }
      }
      try {
        el.click();
      } catch (_error) {
        /* non-fatal */
      }
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isEditableField = (el) => {
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return true;
      if (el.isContentEditable) return true;
      return lower(el.getAttribute && el.getAttribute('role')) === 'textbox';
    };
    const editableFieldForControl = (control) => {
      if (!control) return null;
      if (isEditableField(control)) return control;
      return (
        control.querySelector &&
        control.querySelector(
          'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
        )
      ) || null;
    };
    const writeEditableValue = (field, control, value) => {
      if (!field) return false;
      try {
        field.focus && field.focus();
        if (field.isContentEditable) {
          field.textContent = value;
        } else if ('value' in field) {
          field.value = value;
        } else {
          field.textContent = value;
        }
        for (const type of ['input', 'change']) {
          field.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
        }
        if (control && field !== control && 'value' in control && typeof control.value === 'string') {
          control.value = value;
        }
        if (control && field !== control && control.setAttribute) {
          control.setAttribute('data-frontier-query', value);
        }
        return true;
      } catch (_error) {
        return false;
      }
    };
    const findListboxForControl = (control, includeHidden = false) => {
      if (!control) return null;
      const candidates = [];
      const push = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };
      if (implicitRole(control) === 'listbox') push(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) push(document.getElementById(id));
      push(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          push(listbox);
        }
      }
      if (candidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) push(listbox);
      }
      return (
        candidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const findPreviousOption = (control, previousId, previousValue, previousLabel) => {
      const listbox = findListboxForControl(control, true);
      const options = Array.from((listbox || control).querySelectorAll('[role="option"]'));
      return (
        options.find((candidate) => previousId && candidate.id === previousId) ||
        options.find((candidate) => previousValue && readOptionValue(candidate) === previousValue) ||
        options.find((candidate) => previousLabel && lower(readOptionLabel(candidate)) === lower(previousLabel)) ||
        null
      );
    };
    const waitForPreviousOption = async (control, previousId, previousValue, previousLabel) => {
      let option = findPreviousOption(control, previousId, previousValue, previousLabel);
      if (option) return option;
      if (payload.queryMode === 'page') {
        const editor = editableFieldForControl(control);
        const query = previousLabel || previousValue;
        if (editor && query) {
          const wrote = writeEditableValue(editor, control, query);
          if (wrote) await wait(0);
        }
      }
      const started = Date.now();
      while (Date.now() - started < 2000) {
        await wait(50);
        option = findPreviousOption(control, previousId, previousValue, previousLabel);
        if (option) return option;
      }
      return null;
    };
    const isSelectedOption = (option) =>
      lower(option?.getAttribute && option.getAttribute('aria-selected')) === 'true' ||
      lower(option?.getAttribute && option.getAttribute('data-selected')) === 'true';
    const buildKeyboardPlan = (control, option) => {
      if (controlKind(control) !== 'custom') return null;
      if (lower(payload.queryCommitKey) !== 'enter') return null;
      const listbox = findListboxForControl(control, true);
      const options = Array.from(
        (listbox || control).querySelectorAll('[role="option"]'),
      ).filter((candidate) => isVisible(candidate));
      const targetIndex = options.indexOf(option);
      if (targetIndex < 0) return null;
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      const activeOption = activeId ? document.getElementById(activeId) : null;
      let activeIndex = options.indexOf(activeOption);
      if (activeIndex < 0) {
        activeIndex = options.findIndex((candidate) => isSelectedOption(candidate));
      }
      if (activeIndex < 0 && isSelectedOption(option)) {
        activeIndex = targetIndex;
      }
      const delta = activeIndex >= 0 ? targetIndex - activeIndex : targetIndex + 1;
      return {
        navigationKey: delta < 0 ? 'ArrowUp' : 'ArrowDown',
        navigationCount: Math.abs(delta),
        commitKey: 'Enter',
        targetValue: readOptionValue(option),
        targetLabel: readOptionLabel(option),
      };
    };
    const readSelectedOption = (control) => {
      if (!control) return { value: '', label: '' };
      if (controlKind(control) === 'native') {
        const index = Number.isInteger(control.selectedIndex) ? control.selectedIndex : -1;
        const option = index >= 0 ? control.options[index] : null;
        return {
          value: option ? String(option.value ?? '') : '',
          label: option ? normalize(option.textContent || option.label || '') : '',
        };
      }
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      let option = activeId ? document.getElementById(activeId) : null;
      if (!option) {
        const listbox = findListboxForControl(control, true);
        if (listbox) {
          option =
            Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]')).find(Boolean) ||
            null;
        }
      }
      return {
        value: option ? readOptionValue(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-value')),
        label: option ? readOptionLabel(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-label')),
      };
    };
    const target = document.querySelector(
      '[data-frontier-select-token="' + payload.selectToken + '"]',
    );
    if (!target) {
      return { ok: false, reason: 'selected target token not found' };
    }
    try {
      target.focus && target.focus();
      if (controlKind(target) === 'native') {
        target.selectedIndex = Number(payload.previousIndex);
      } else {
        if (
          payload.queryMode !== 'trusted' &&
          !payload.queryOpened &&
          implicitRole(target) !== 'listbox'
        ) {
          emitClick(target);
        }
        const previousId = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-option-id'));
        const previousValue = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-value'));
        const previousLabel = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-label'));
        const option = await waitForPreviousOption(
          target,
          previousId,
          previousValue,
          previousLabel,
        );
        if (!option && (previousId || previousValue || previousLabel)) {
          return {
            ok: false,
            reason: 'previous option not found during selection restore',
          };
        }
        if (option && payload.queryCommitKey) {
          const keyboardPlan = buildKeyboardPlan(target, option);
          if (!keyboardPlan) {
            return {
              ok: false,
              reason: 'keyboard restore plan could not be built for the previous option',
            };
          }
          return { ok: true, keyboardPlan };
        }
        if (option) emitClick(option);
      }
      const restored = readSelectedOption(target);
      target.setAttribute('data-frontier-selected-value', restored.value || '');
      target.setAttribute('data-frontier-selected-label', restored.label || '');
      if (controlKind(target) === 'native') {
        target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: 'selection restore failed: ' + ((error && error.message) || error),
      };
    }
  })()`;
}

function buildFinalizeRestoreKeyboardCommitScript(selectToken: string): string {
  const payload = JSON.stringify({ selectToken });
  return `(async () => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const implicitRole = (el) => {
      if (!el) return '';
      const explicit = lower(el.getAttribute && el.getAttribute('role'));
      if (explicit) return explicit;
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const optionIndexFor = (option) => {
      if (!option) return -1;
      const listbox = option.closest && option.closest('[role="listbox"]');
      if (!listbox) return -1;
      return Array.from(listbox.querySelectorAll('[role="option"]')).indexOf(option);
    };
    const findListboxForControl = (control, includeHidden = false) => {
      if (!control) return null;
      const candidates = [];
      const push = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };
      if (implicitRole(control) === 'listbox') push(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) push(document.getElementById(id));
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      if (activeId) {
        const active = document.getElementById(activeId);
        push(active && active.closest ? active.closest('[role="listbox"]') : null);
      }
      push(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          push(listbox);
        }
      }
      if (candidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) push(listbox);
      }
      return (
        candidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const readSelectedOption = (control) => {
      if (!control) return { id: null, value: '', label: '', index: -1 };
      if (controlKind(control) === 'native') {
        const index = Number.isInteger(control.selectedIndex) ? control.selectedIndex : -1;
        const option = index >= 0 ? control.options[index] : null;
        return {
          id: option ? option.id || null : null,
          value: option ? String(option.value ?? '') : '',
          label: option ? normalize(option.textContent || option.label || '') : '',
          index,
        };
      }
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      let option = activeId ? document.getElementById(activeId) : null;
      if (!option) {
        const listbox = findListboxForControl(control, true);
        if (listbox) {
          option =
            Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]')).find(Boolean) ||
            Array.from(listbox.querySelectorAll('[role="option"]')).find((candidate) =>
              lower(candidate.getAttribute && candidate.getAttribute('data-selected')) === 'true',
            ) ||
            null;
        }
      }
      return {
        id: option ? option.id || null : null,
        value: option ? readOptionValue(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-value')),
        label: option ? readOptionLabel(option) : normalize(control.getAttribute && control.getAttribute('data-frontier-selected-label')),
        index: option ? optionIndexFor(option) : -1,
      };
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const target = document.querySelector(
      '[data-frontier-select-token="' + payload.selectToken + '"]',
    );
    if (!target) {
      return { ok: false, reason: 'selected target token not found after keyboard restore' };
    }
    const previousValue = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-value'));
    const previousLabel = normalize(target.getAttribute && target.getAttribute('data-frontier-previous-label'));
    const deadline = Date.now() + 3000;
    while (Date.now() <= deadline) {
      const restored = readSelectedOption(target);
      const valueMatches = !previousValue || restored.value === previousValue;
      const labelMatches = !previousLabel || lower(restored.label) === lower(previousLabel);
      if (valueMatches && labelMatches) {
        target.setAttribute('data-frontier-selected-value', restored.value || '');
        target.setAttribute('data-frontier-selected-label', restored.label || '');
        return { ok: true };
      }
      await wait(50);
    }
    return {
      ok: false,
      reason: 'keyboard restore did not settle on the previous option',
    };
  })()`;
}

function buildExpectationScript(
  args: SelectOptionArgs,
  selectToken: string,
): string {
  const payload = JSON.stringify({
    expectValue: args.expectValue ?? null,
    expectLabel: args.expectLabel ?? null,
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectPageTextIncludes: args.expectPageTextIncludes ?? null,
    selectToken,
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
      if (String(el.tagName || '').toLowerCase() === 'select') {
        const size = Number(el.getAttribute && el.getAttribute('size') || 0);
        return el.multiple || size > 1 ? 'listbox' : 'combobox';
      }
      if (lower(el.getAttribute && el.getAttribute('aria-haspopup')) === 'listbox') {
        return 'combobox';
      }
      if (normalize(el.getAttribute && el.getAttribute('aria-controls'))) {
        return 'combobox';
      }
      return '';
    };
    const controlKind = (el) =>
      String(el && el.tagName || '').toLowerCase() === 'select' ? 'native' : 'custom';
    const readOptionLabel = (option) =>
      normalize(
        (option && (
          option.getAttribute && option.getAttribute('aria-label')
        )) ||
          option?.textContent ||
          option?.label ||
          '',
      );
    const readOptionValue = (option) => {
      if (!option) return '';
      const datasetValue =
        option.dataset && typeof option.dataset.value === 'string'
          ? option.dataset.value
          : '';
      if (datasetValue) return datasetValue;
      const attrValue =
        option.getAttribute && typeof option.getAttribute('value') === 'string'
          ? option.getAttribute('value')
          : '';
      if (attrValue) return attrValue;
      if ('value' in option && typeof option.value === 'string' && option.value) {
        return option.value;
      }
      return readOptionLabel(option);
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const findListboxForControl = (control, includeHidden = false) => {
      if (!control) return null;
      const candidates = [];
      const push = (value) => {
        if (!value || candidates.includes(value)) return;
        candidates.push(value);
      };
      if (implicitRole(control) === 'listbox') push(control);
      const ids = [
        normalize(control.getAttribute && control.getAttribute('aria-controls')),
        normalize(control.getAttribute && control.getAttribute('aria-owns')),
      ]
        .filter(Boolean)
        .flatMap((value) => value.split(/\\s+/).filter(Boolean));
      for (const id of ids) push(document.getElementById(id));
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      if (activeId) {
        const active = document.getElementById(activeId);
        push(active && active.closest ? active.closest('[role="listbox"]') : null);
      }
      push(control.nextElementSibling);
      if (control.parentElement) {
        for (const listbox of control.parentElement.querySelectorAll('[role="listbox"]')) {
          push(listbox);
        }
      }
      if (candidates.length === 0) {
        for (const listbox of document.querySelectorAll('[role="listbox"]')) push(listbox);
      }
      return (
        candidates.find((candidate) =>
          includeHidden ? Boolean(candidate) : isVisible(candidate),
        ) || null
      );
    };
    const readSelectedOption = (control) => {
      if (!control) return { value: '', label: '' };
      if (controlKind(control) === 'native') {
        const index = Number.isInteger(control.selectedIndex) ? control.selectedIndex : -1;
        const option = index >= 0 ? control.options[index] : null;
        return {
          value: option ? String(option.value ?? '') : '',
          label: option ? normalize(option.textContent || option.label || '') : '',
        };
      }
      const activeId = normalize(control.getAttribute && control.getAttribute('aria-activedescendant'));
      let option = activeId ? document.getElementById(activeId) : null;
      if (!option) {
        const listbox = findListboxForControl(control, true);
        if (listbox) {
          option =
            Array.from(listbox.querySelectorAll('[role="option"][aria-selected="true"]')).find(Boolean) ||
            null;
        }
      }
      let value = option ? readOptionValue(option) : '';
      let label = option ? readOptionLabel(option) : '';
      if (!value) {
        value = normalize(
          control.getAttribute && control.getAttribute('data-frontier-selected-value'),
        );
      }
      if (!label) {
        label = normalize(
          control.getAttribute && control.getAttribute('data-frontier-selected-label'),
        );
      }
      if (!value && 'value' in control && typeof control.value === 'string') value = control.value;
      if (!label && 'value' in control && typeof control.value === 'string') {
        label = normalize(control.value);
      }
      return { value, label };
    };
    const failures = [];
    const observed = {
      url: location.href,
      targetFound: false,
      selectedValue: null,
      selectedLabel: null,
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
        failures.push('selector should be absent after option selection');
      }
    }
    const target = document.querySelector(
      '[data-frontier-select-token="' + payload.selectToken + '"]',
    );
    observed.targetFound = Boolean(target);
    if (!target) {
      failures.push('selected target not found for verification');
    } else {
      const selected = readSelectedOption(target);
      observed.selectedValue = selected.value;
      observed.selectedLabel = selected.label;
      const expectedValue =
        payload.expectValue ??
        target.getAttribute('data-frontier-selected-value') ??
        null;
      const expectedLabel =
        payload.expectLabel ??
        target.getAttribute('data-frontier-selected-label') ??
        null;
      if (expectedValue !== null && observed.selectedValue !== String(expectedValue)) {
        failures.push('selected value did not match expected option');
      }
      if (
        expectedLabel !== null &&
        lower(observed.selectedLabel) !== lower(expectedLabel)
      ) {
        failures.push('selected label did not match expected option');
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

function requestedSelection(args: SelectOptionArgs): Record<string, unknown> {
  return {
    selector: args.selector ?? null,
    text: args.text ?? null,
    ariaLabel: args.ariaLabel ?? null,
    role: args.role ?? null,
    queryLength: typeof args.query === "string" ? args.query.length : null,
    commitKey: args.commitKey ?? null,
    optionLabel: args.optionLabel ?? null,
    optionValue: args.optionValue ?? null,
    optionLoadTimeoutMs: args.optionLoadTimeoutMs ?? null,
    expectValue: args.expectValue ?? args.optionValue ?? null,
    expectLabel: args.expectLabel ?? args.optionLabel ?? null,
    expectUrlIncludes: args.expectUrlIncludes ?? null,
    expectSelector: args.expectSelector ?? null,
    expectSelectorMissing: args.expectSelectorMissing ?? null,
    expectPageTextIncludesLength:
      typeof args.expectPageTextIncludes === "string"
        ? args.expectPageTextIncludes.length
        : null,
  };
}

function describeTarget(target: SelectTargetSummary | null): string {
  if (!target) return "control";
  const tag = target.tagName || "control";
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
  args: SelectOptionArgs,
  failedChecks: ActionCheck[],
): string[] {
  if (failedChecks.length === 0) return [];
  const suggestions: string[] = [];
  if (
    typeof args.expectSelector !== "string" &&
    failedChecks.some((check) => check.name === "dom-predicate")
  ) {
    suggestions.push(
      "Add `expectSelector` or `expectPageTextIncludes` if selection should trigger a visible page change.",
    );
  }
  if (
    typeof args.networkUrlRegex !== "string" &&
    failedChecks.some((check) => check.name === "network")
  ) {
    suggestions.push(
      "Add `networkUrlRegex` when the selection is expected to trigger a specific request.",
    );
  }
  return suggestions;
}
