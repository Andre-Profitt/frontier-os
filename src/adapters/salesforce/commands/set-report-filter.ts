import {
  attach,
  evaluate,
  type CdpAttachOptions,
  type CdpSession,
} from "../../browser/cdp.ts";
import { runAction } from "../../browser/actions/action-loop.ts";
import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface SetReportFilterArgs extends CdpAttachOptions {
  /** Match the tab by URL substring when multiple tabs are open. */
  urlHint?: string;
  /** Report filter row label, e.g. "Show Me". */
  filterLabel: string;
  /** Inline action button label or dialog picklist option label. */
  actionLabel: string;
  /** Visible filter text expected after the action completes. */
  expectedNewLabel: string;
  /** Optional dialog field label when the filter uses a popover editor. */
  editorFieldLabel?: string;
  /** Optional labeled input values for dialog-backed editors, e.g. Start/End Date. */
  editorInputValues?: Record<string, string>;
}

const DEFAULT_URL_MATCH = /Report|salesforce|lightning|force\\.com/i;

function buildApplyInlineFilterScript(
  filterLabel: string,
  actionLabel: string,
  expectedNewLabel: string,
  editorFieldLabel?: string,
  editorInputValues?: Record<string, string>,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const actionJson = JSON.stringify(actionLabel);
  const expectedJson = JSON.stringify(expectedNewLabel);
  const editorJson = JSON.stringify(editorFieldLabel ?? null);
  const editorInputsJson = JSON.stringify(editorInputValues ?? {});
  return `(async () => {
    const targetFilter = ${filterJson};
    const targetAction = ${actionJson};
    const expected = ${expectedJson};
    const requestedEditorField = ${editorJson};
    const requestedEditorInputs = ${editorInputsJson};
    const requestedEditorInputEntries = Object.entries(requestedEditorInputs || {})
      .filter(([key, value]) => typeof key === 'string' && key.length > 0 && typeof value === 'string');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const readActions = () =>
      [...doc.querySelectorAll('button.slds-button_reset.slds-text-link, a.select')]
        .filter((el) => isVisible(el))
        .map((el) => normalize(el.textContent || ''))
        .filter(Boolean);
    const readFieldLabel = (control) => normalize(
      control &&
      control.closest &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget') &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget')
        .querySelector('label') &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget')
        .querySelector('label')
        .textContent || '',
    );
    const findPopover = () => {
      const popovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
        .filter((el) => isVisible(el));
      return popovers.find((el) => matches(el.textContent || '', targetFilter)) ||
        popovers.find((el) =>
          /(^|\\s)reports-filter-popover(\\s|$)/.test(
            typeof el.className === 'string' ? el.className : '',
          ),
        ) ||
        null;
    };
    const readEditorFields = (popover) => {
      if (!popover) return [];
      return [...popover.querySelectorAll('button.slds-picklist__label')]
        .filter((el) => isVisible(el))
        .map((el) => ({
          label: readFieldLabel(el),
          value: normalize(el.textContent || ''),
        }))
        .filter((entry) => entry.label || entry.value);
    };
    const readEditorInputs = (popover) => {
      if (!popover) return [];
      return [...popover.querySelectorAll('input, textarea, select')]
        .filter((el) => isVisible(el))
        .map((el) => {
          const container =
            el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
          const label = normalize(
            container && container.querySelector && container.querySelector('label') &&
            container.querySelector('label').textContent || '',
          );
          const value = 'value' in el ? normalize(el.value || '') : normalize(el.textContent || '');
          return {
            label,
            value,
            tag: String(el.tagName || '').toLowerCase(),
          };
        })
        .filter((entry) => entry.label || entry.value);
    };
    const readEditorOptions = () => {
      const dropdowns = [...doc.querySelectorAll('.slds-dropdown, [role="menu"], [role="listbox"], .uiMenuList')];
      const seen = new Set();
      const out = [];
      for (const dropdown of dropdowns) {
        for (const option of dropdown.querySelectorAll(
          'li.slds-dropdown__item, [role="option"], a[role^="menuitem"], button[role^="menuitem"], li.slds-dropdown__item a, li.slds-dropdown__item button',
        )) {
          const text = normalize(option.textContent || '');
          if (!text) continue;
          const key = text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(text);
        }
      }
      return out;
    };
    const clickApply = async (popover) => {
      if (!popover) return false;
      const applyButton = [...popover.querySelectorAll('button')].find(
        (el) => isVisible(el) && matches(el.textContent || '', 'Apply'),
      ) || null;
      if (!applyButton) return false;
      click(applyButton);
      await sleep(300);
      return true;
    };
    const applyEditorChoice = async (popover) => {
      const controls = popover
        ? [...popover.querySelectorAll('button.slds-picklist__label')].filter((el) => isVisible(el))
        : [];
      if (controls.length === 0) {
        return {
          ok: false,
          reason: 'report filter editor fields not found',
          editorField: null,
          editorOption: null,
          applied: false,
          availableEditorFields: [],
          availableEditorOptions: [],
          availableEditorInputs: [],
        };
      }
      const control = requestedEditorField
        ? controls.find((el) =>
            matches(readFieldLabel(el), requestedEditorField) ||
            matches(el.textContent || '', requestedEditorField),
          ) || null
        : controls.length === 1
          ? controls[0]
          : null;
      if (!control) {
        return {
          ok: false,
          reason: requestedEditorField
            ? 'report filter editor field not found: ' + requestedEditorField
            : 'report filter editor field is ambiguous; pass editorFieldLabel',
          editorField: null,
          editorOption: null,
          applied: false,
          availableEditorFields: readEditorFields(popover),
          availableEditorOptions: [],
          availableEditorInputs: readEditorInputs(popover),
        };
      }
      const resolvedField = readFieldLabel(control) || normalize(control.textContent || '');
      const currentControlValue = normalize(control.textContent || '');
      const currentInputs = readEditorInputs(popover);
      if (
        requestedEditorInputEntries.length > 0 &&
        matches(currentControlValue, targetAction) &&
        currentInputs.length > 0
      ) {
        return {
          ok: true,
          editorField: resolvedField,
          editorOption: currentControlValue,
          applied: false,
          needsTypedInputs: true,
          availableEditorFields: readEditorFields(popover),
          availableEditorOptions: readEditorOptions(),
          availableEditorInputs: readEditorInputs(popover),
        };
      }
      click(control);
      await sleep(400);
      if (control.getAttribute('aria-expanded') !== 'true') {
        click(control);
        await sleep(600);
      }
      const optionDeadline = Date.now() + 6000;
      let option = null;
      const resolveOptionTarget = (node) => {
        if (!node) return null;
        if (node.matches && node.matches('a, button, [role="option"], [role^="menuitem"]')) {
          return node;
        }
        return node.querySelector && node.querySelector('a, button, [role="option"], [role^="menuitem"]');
      };
      while (Date.now() < optionDeadline) {
        for (const dropdown of [...doc.querySelectorAll('.slds-dropdown, [role="menu"], [role="listbox"], .uiMenuList')]) {
          option = [...dropdown.querySelectorAll(
            'li.slds-dropdown__item, [role="option"], a[role^="menuitem"], button[role^="menuitem"], li.slds-dropdown__item a, li.slds-dropdown__item button',
          )].find((el) => matches(el.textContent || '', targetAction)) || null;
          if (option) break;
        }
        if (option) break;
        await sleep(200);
      }
      if (!option) {
        return {
          ok: false,
          reason: 'report filter editor option not found: ' + targetAction,
          editorField: resolvedField,
          editorOption: null,
          applied: false,
          availableEditorFields: readEditorFields(popover),
          availableEditorOptions: readEditorOptions(),
          availableEditorInputs: readEditorInputs(popover),
        };
      }
      const optionTarget = resolveOptionTarget(option);
      const resolvedOption = normalize((optionTarget || option).textContent || '');
      click(optionTarget || option);
      await sleep(300);
      if (requestedEditorInputEntries.length > 0) {
        return {
          ok: true,
          editorField: resolvedField,
          editorOption: resolvedOption,
          applied: false,
          needsTypedInputs: true,
          availableEditorFields: readEditorFields(popover),
          availableEditorOptions: readEditorOptions(),
          availableEditorInputs: readEditorInputs(popover),
        };
      }
      const applied = await clickApply(popover);
      return {
        ok: true,
        editorField: resolvedField,
        editorOption: resolvedOption,
        applied,
        availableEditorFields: readEditorFields(popover),
        availableEditorOptions: readEditorOptions(),
        availableEditorInputs: readEditorInputs(popover),
      };
    };
    const click = (el) => {
      if (!el) return;
      if (typeof el.click === 'function') {
        el.click();
        return;
      }
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const event = type.indexOf('pointer') === 0
          ? new PointerEvent(type, {
              ...mouse,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons: 1,
            })
          : new MouseEvent(type, { ...mouse, button: 0, buttons: 1 });
        el.dispatchEvent(event);
      }
    };
    const deadline = Date.now() + 12000;
    let doc = null;
    while (Date.now() < deadline) {
      const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
      doc = frame && frame.contentDocument;
      if (doc) break;
      await sleep(250);
    }
    if (!doc) {
      return { ok: false, reason: 'report iframe not available' };
    }

    const findRow = () => {
      const containers = [...doc.querySelectorAll('.filterContainer')];
      for (const container of containers) {
        const trigger =
          container.querySelector('button.slds-button_reset.slds-grow') ||
          container.querySelector('button');
        const text = normalize(
          (trigger && trigger.textContent) || container.textContent || '',
        );
        const title = normalize(container.getAttribute('title') || '');
        if (matches(text, targetFilter) || matches(title, targetFilter)) {
          return trigger || container;
        }
      }
      return null;
    };

    let row = null;
    const initialRowDeadline = Date.now() + 2500;
    while (Date.now() < initialRowDeadline) {
      row = findRow();
      if (row) break;
      await sleep(250);
    }
    let usedToggleFallback = false;
    if (!row) {
      const toggle = doc.querySelector(
        '.action-bar-action-toggleFilter, .report-action-toggleFilter, .forceFilterButton',
      );
      if (toggle) {
        click(toggle);
        usedToggleFallback = true;
        await sleep(600);
      }
      while (Date.now() < deadline) {
        row = findRow();
        if (row) break;
        await sleep(250);
      }
    }
    if (!row) {
      return {
        ok: false,
        reason: 'report filter row not found: ' + targetFilter,
        availableActions: readActions(),
        usedToggleFallback,
      };
    }
    const beforeText = normalize(row.textContent || '');
    if (matches(beforeText, expected)) {
      return {
        ok: true,
        beforeText,
        clickedAction: null,
        currentText: beforeText,
        availableActions: readActions(),
        usedToggleFallback,
        interactionMode: 'noop',
        editorField: null,
        editorOption: null,
        availableEditorFields: [],
        availableEditorOptions: [],
        availableEditorInputs: [],
        needsTypedInputs: false,
      };
    }
    click(row);
    await sleep(1000);

    let clickedAction = null;
    let interactionMode = null;
    let editorField = null;
    let editorOption = null;
    let availableEditorFields = [];
    let availableEditorOptions = [];
    let availableEditorInputs = [];
    let action = null;
    if (!requestedEditorField) {
      while (Date.now() < deadline) {
        action = [...doc.querySelectorAll('button.slds-button_reset.slds-text-link')]
          .find((el) => isVisible(el) && matches(el.textContent || '', targetAction)) || null;
        if (action) break;
        await sleep(250);
      }
    }
    if (action) {
      clickedAction = normalize(action.textContent || '');
      interactionMode = 'inline';
      click(action);
    } else {
      const popover = findPopover();
      const editorResult = await applyEditorChoice(popover);
      availableEditorFields = editorResult.availableEditorFields || [];
      availableEditorOptions = editorResult.availableEditorOptions || [];
      availableEditorInputs = editorResult.availableEditorInputs || [];
      editorField = editorResult.editorField || null;
      editorOption = editorResult.editorOption || null;
      if (!editorResult.ok) {
        return {
          ok: false,
          reason: editorResult.reason,
          beforeText,
          currentText: normalize(findRow()?.textContent || ''),
          availableActions: readActions(),
          usedToggleFallback,
          interactionMode: null,
          editorField,
          editorOption,
          availableEditorFields,
          availableEditorOptions,
          availableEditorInputs,
        };
      }
      clickedAction = editorResult.editorOption;
      interactionMode = 'editor';
    }
    if (!clickedAction) {
      return {
        ok: false,
        reason: 'report filter action not found: ' + targetAction,
        beforeText,
        currentText: normalize(findRow()?.textContent || ''),
        availableActions: readActions(),
        usedToggleFallback,
        interactionMode,
        editorField,
        editorOption,
        availableEditorFields,
        availableEditorOptions,
        availableEditorInputs,
      };
    }
    if (interactionMode === 'editor' && requestedEditorInputEntries.length > 0) {
      return {
        ok: true,
        beforeText,
        clickedAction,
        currentText: normalize(findRow()?.textContent || ''),
        availableActions: readActions(),
        usedToggleFallback,
        interactionMode,
        editorField,
        editorOption,
        availableEditorFields,
        availableEditorOptions,
        availableEditorInputs,
        needsTypedInputs: true,
      };
    }
    let currentText = beforeText;
    while (Date.now() < deadline + 3000) {
      const currentRow = findRow();
      if (!currentRow) {
        return {
          ok: false,
          reason: 'report filter row disappeared: ' + targetFilter,
          beforeText,
          clickedAction,
          currentText,
          availableActions: readActions(),
          usedToggleFallback,
          interactionMode,
          editorField,
          editorOption,
          availableEditorFields,
          availableEditorOptions,
          availableEditorInputs,
          needsTypedInputs: false,
        };
      }
      currentText = normalize(currentRow.textContent || '');
      if (matches(currentText, expected)) {
        return {
          ok: true,
          beforeText,
          clickedAction,
          currentText,
          availableActions: readActions(),
          usedToggleFallback,
          interactionMode,
          editorField,
          editorOption,
          availableEditorFields,
          availableEditorOptions,
          availableEditorInputs,
        };
      }
      await sleep(250);
    }

    return {
      ok: false,
      reason:
        'report filter row does not contain expected label "' + expected + '" (saw "' +
        currentText + '")',
      beforeText,
      clickedAction,
      currentText,
      availableActions: readActions(),
      usedToggleFallback,
      interactionMode,
      editorField,
      editorOption,
      availableEditorFields,
      availableEditorOptions,
      availableEditorInputs,
      needsTypedInputs: false,
    };
  })()`;
}

function buildAttachOpts(args: SetReportFilterArgs): CdpAttachOptions {
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
  attachOpts.installHelper = true;
  return attachOpts;
}

function hasEditorInputValues(
  editorInputValues?: Record<string, string>,
): editorInputValues is Record<string, string> {
  return Object.entries(editorInputValues ?? {}).some(([label, value]) =>
    label.trim().length > 0 && typeof value === "string"
  );
}

function buildFocusSelectReportFilterInputScript(
  filterLabel: string,
  inputLabel: string,
  desiredValue?: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const inputJson = JSON.stringify(inputLabel);
  const desiredJson = JSON.stringify(desiredValue ?? null);
  return `(() => {
    const targetFilter = ${filterJson};
    const targetInput = ${inputJson};
    const desiredValue = ${desiredJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc) return { ok: false, reason: 'report iframe not available' };
    const visiblePopovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) {
      return { ok: false, reason: 'report filter popover not found: ' + targetFilter };
    }
    const input = [...popover.querySelectorAll('input, textarea, select')]
      .find((el) => {
        const container =
          el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
        const label = normalize(
          container && container.querySelector && container.querySelector('label') &&
          container.querySelector('label').textContent || '',
        );
        return matches(label, targetInput);
      }) || null;
    if (!input) {
      return { ok: false, reason: 'report filter editor input not found: ' + targetInput };
    }
    let clearedReadonlySelection = false;
    let resolvedInput = input;
    const initialValue =
      'value' in input
        ? normalize(input.value || '')
        : normalize(input.textContent || '');
    const preserveReadonlySelection =
      typeof desiredValue === 'string' &&
      desiredValue.length > 0 &&
      matches(initialValue, desiredValue);
    const clearButton =
      input.closest('.slds-form-element, .filter-date-picker, .date-picker-container')
        ?.querySelector('button.slds-button_icon') || null;
    const clearAssistive = normalize(
      clearButton && clearButton.textContent || clearButton?.getAttribute?.('aria-label') || '',
    );
    if (
      'readOnly' in input &&
      input.readOnly &&
      matches(clearAssistive, 'Remove selected option') &&
      !preserveReadonlySelection
    ) {
      try {
        if (typeof clearButton.click === 'function') clearButton.click();
        clearedReadonlySelection = true;
        resolvedInput =
          [...popover.querySelectorAll('input, textarea, select')]
            .find((el) => {
              const container =
                el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
              const label = normalize(
                container && container.querySelector && container.querySelector('label') &&
                container.querySelector('label').textContent || '',
              );
              return matches(label, targetInput);
            }) || input;
      } catch (_e) {}
    }
    try {
      if (typeof resolvedInput.focus === 'function') resolvedInput.focus();
    } catch (_e) {}
    try {
      if (typeof resolvedInput.select === 'function') resolvedInput.select();
    } catch (_e) {}
    const frameRect = frame.getBoundingClientRect();
    const rect = resolvedInput.getBoundingClientRect();
    return {
      ok: true,
      value: 'value' in resolvedInput ? normalize(resolvedInput.value || '') : normalize(resolvedInput.textContent || ''),
      preservedReadonlySelection: preserveReadonlySelection,
      clearedReadonlySelection,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
    };
  })()`;
}

function buildLocateReportFilterInputOptionScript(
  filterLabel: string,
  inputLabel: string,
  optionLabel: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const inputJson = JSON.stringify(inputLabel);
  const optionJson = JSON.stringify(optionLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const targetInput = ${inputJson};
    const targetOption = ${optionJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const equals = (value, needle) =>
      normalize(value).toLowerCase() === normalize(needle).toLowerCase();
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc || !frame) return { ok: false, reason: 'report iframe not available', availableOptions: [], noMatches: false };
    const visiblePopovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) {
      return {
        ok: false,
        reason: 'report filter popover not found: ' + targetFilter,
        availableOptions: [],
        noMatches: false,
      };
    }
    const input = [...popover.querySelectorAll('input, textarea, select')]
      .find((el) => {
        const container =
          el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
        const label = normalize(
          container && container.querySelector && container.querySelector('label') &&
          container.querySelector('label').textContent || '',
        );
        return matches(label, targetInput);
      }) || null;
    if (!input) {
      return {
        ok: false,
        reason: 'report filter editor input not found: ' + targetInput,
        availableOptions: [],
        noMatches: false,
      };
    }
    try {
      if (typeof input.focus === 'function') input.focus();
      if (typeof input.click === 'function') input.click();
    } catch (_e) {}
    const resolveOptionTarget = (node) => {
      if (!node) return null;
      if (
        node.matches &&
        node.matches('[role="option"], li.slds-listbox__item, .slds-listbox__option, .slds-listbox__option-text')
      ) {
        return node;
      }
      return node.querySelector &&
        node.querySelector('[role="option"], li.slds-listbox__item, .slds-listbox__option, .slds-listbox__option-text');
    };
    const listboxes = [...doc.querySelectorAll('ul.report-combobox-listbox[role="listbox"], [role="listbox"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    const availableOptions = [];
    let exactMatch = null;
    let partialMatch = null;
    for (const listbox of listboxes) {
      const options = [...listbox.querySelectorAll('[role="option"], li.slds-listbox__item')]
        .filter((el) => !/(^|\\s)slds-listbox__status(\\s|$)/.test(typeof el.className === 'string' ? el.className : ''));
      for (const candidate of options) {
        const text = normalize(candidate.textContent || '');
        if (!text) continue;
        availableOptions.push(text);
        if (!exactMatch && equals(text, targetOption)) exactMatch = candidate;
        if (!partialMatch && matches(text, targetOption)) partialMatch = candidate;
      }
    }
    const option = exactMatch || partialMatch;
    if (!option) {
      const noMatches = listboxes.some((listbox) => matches(listbox.textContent || '', 'No matches found.'));
      return {
        ok: false,
        reason: 'report filter editor option not found for ' + targetInput + ': ' + targetOption,
        availableOptions,
        noMatches,
      };
    }
    const target = resolveOptionTarget(option) || option;
    const frameRect = frame.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return {
      ok: true,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      availableOptions,
      noMatches: false,
    };
  })()`;
}

function buildCommitReportFilterInputScript(
  filterLabel: string,
  inputLabel: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const inputJson = JSON.stringify(inputLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const targetInput = ${inputJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const visiblePopovers = [...document.querySelectorAll('iframe[src*="lightningReportApp.app"]')]
      .map((frame) => frame && frame.contentDocument)
      .filter(Boolean)
      .flatMap((doc) =>
        [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          }),
      );
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) {
      return { ok: false, reason: 'report filter popover not found: ' + targetFilter };
    }
    const input = [...popover.querySelectorAll('input, textarea, select')]
      .find((el) => {
        const container =
          el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
        const label = normalize(
          container && container.querySelector && container.querySelector('label') &&
          container.querySelector('label').textContent || '',
        );
        return matches(label, targetInput);
      }) || null;
    if (!input) {
      return { ok: false, reason: 'report filter editor input not found: ' + targetInput };
    }
    try {
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      if (typeof input.blur === 'function') input.blur();
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true, cancelable: true }));
    } catch (_e) {}
    return {
      ok: true,
      value: 'value' in input ? normalize(input.value || '') : normalize(input.textContent || ''),
    };
  })()`;
}

function buildOpenReportFilterEditorScript(
  filterLabel: string,
  expectedNewLabel: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const expectedJson = JSON.stringify(expectedNewLabel);
  return `(async () => {
    const targetFilter = ${filterJson};
    const expected = ${expectedJson};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const click = (el) => {
      if (!el) return;
      if (typeof el.click === 'function') {
        el.click();
        return;
      }
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const event = type.indexOf('pointer') === 0
          ? new PointerEvent(type, {
              ...mouse,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons: 1,
            })
          : new MouseEvent(type, { ...mouse, button: 0, buttons: 1 });
        el.dispatchEvent(event);
      }
    };
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc) {
      return {
        ok: false,
        reason: 'report iframe not available',
        beforeText: '',
        currentText: '',
        availableActions: [],
        usedToggleFallback: false,
        availableEditorFields: [],
        availableEditorInputs: [],
      };
    }
    const readActions = () =>
      [...doc.querySelectorAll('button.slds-button_reset.slds-text-link, a.select')]
        .filter((el) => isVisible(el))
        .map((el) => normalize(el.textContent || ''))
        .filter(Boolean);
    const readFieldLabel = (control) => normalize(
      control &&
      control.closest &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget') &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget')
        .querySelector('label') &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget')
        .querySelector('label')
        .textContent || '',
    );
    const readEditorFields = (popover) => {
      if (!popover) return [];
      return [...popover.querySelectorAll('button.slds-picklist__label')]
        .filter((el) => isVisible(el))
        .map((el) => ({
          label: readFieldLabel(el),
          value: normalize(el.textContent || ''),
        }))
        .filter((entry) => entry.label || entry.value);
    };
    const readEditorInputs = (popover) => {
      if (!popover) return [];
      return [...popover.querySelectorAll('input, textarea, select')]
        .filter((el) => isVisible(el))
        .map((el) => {
          const container =
            el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
          const label = normalize(
            container && container.querySelector && container.querySelector('label') &&
            container.querySelector('label').textContent || '',
          );
          const value = 'value' in el ? normalize(el.value || '') : normalize(el.textContent || '');
          return {
            label,
            value,
            tag: String(el.tagName || '').toLowerCase(),
          };
        })
        .filter((entry) => entry.label || entry.value);
    };
    const findPopover = () => {
      const popovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
        .filter((el) => isVisible(el));
      return popovers.find((el) => matches(el.textContent || '', targetFilter)) ||
        popovers.find((el) =>
          /(^|\\s)reports-filter-popover(\\s|$)/.test(
            typeof el.className === 'string' ? el.className : '',
          ),
        ) ||
        null;
    };
    const findRow = () => {
      const containers = [...doc.querySelectorAll('.filterContainer')];
      for (const container of containers) {
        const trigger =
          container.querySelector('button.slds-button_reset.slds-grow') ||
          container.querySelector('button');
        const text = normalize(
          (trigger && trigger.textContent) || container.textContent || '',
        );
        const title = normalize(container.getAttribute('title') || '');
        if (matches(text, targetFilter) || matches(title, targetFilter)) {
          return trigger || container;
        }
      }
      return null;
    };
    const deadline = Date.now() + 12000;
    let row = null;
    const initialRowDeadline = Date.now() + 2500;
    while (Date.now() < initialRowDeadline) {
      row = findRow();
      if (row) break;
      await sleep(250);
    }
    let usedToggleFallback = false;
    if (!row) {
      const toggle = doc.querySelector(
        '.action-bar-action-toggleFilter, .report-action-toggleFilter, .forceFilterButton',
      );
      if (toggle) {
        click(toggle);
        usedToggleFallback = true;
        await sleep(600);
      }
      while (Date.now() < deadline) {
        row = findRow();
        if (row) break;
        await sleep(250);
      }
    }
    if (!row) {
      return {
        ok: false,
        reason: 'report filter row not found: ' + targetFilter,
        beforeText: '',
        currentText: '',
        availableActions: readActions(),
        usedToggleFallback,
        availableEditorFields: [],
        availableEditorInputs: [],
      };
    }
    const beforeText = normalize(row.textContent || '');
    if (matches(beforeText, expected)) {
      return {
        ok: true,
        beforeText,
        currentText: beforeText,
        availableActions: readActions(),
        usedToggleFallback,
        interactionMode: 'noop',
        availableEditorFields: [],
        availableEditorInputs: [],
      };
    }
    click(row);
    let popover = null;
    const popoverDeadline = Date.now() + 4000;
    while (Date.now() < popoverDeadline) {
      popover = findPopover();
      if (popover) break;
      await sleep(250);
    }
    if (!popover) {
      return {
        ok: false,
        reason: 'report filter popover not found: ' + targetFilter,
        beforeText,
        currentText: normalize(findRow()?.textContent || ''),
        availableActions: readActions(),
        usedToggleFallback,
        availableEditorFields: [],
        availableEditorInputs: [],
      };
    }
    return {
      ok: true,
      beforeText,
      currentText: normalize(findRow()?.textContent || ''),
      availableActions: readActions(),
      usedToggleFallback,
      interactionMode: 'editor',
      availableEditorFields: readEditorFields(popover),
      availableEditorInputs: readEditorInputs(popover),
    };
  })()`;
}

function buildLocateReportFilterEditorFieldControlScript(
  filterLabel: string,
  fieldLabel: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const fieldJson = JSON.stringify(fieldLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const targetField = ${fieldJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc || !frame) {
      return { ok: false, reason: 'report iframe not available', availableEditorFields: [] };
    }
    const readFieldLabel = (control) => normalize(
      control &&
      control.closest &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget') &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget')
        .querySelector('label') &&
      control.closest('.slds-form-element, .picklist-container, .filter-widget')
        .querySelector('label')
        .textContent || '',
    );
    const readEditorFields = (popover) => {
      if (!popover) return [];
      return [...popover.querySelectorAll('button.slds-picklist__label')]
        .filter((el) => isVisible(el))
        .map((el) => ({
          label: readFieldLabel(el),
          value: normalize(el.textContent || ''),
        }))
        .filter((entry) => entry.label || entry.value);
    };
    const visiblePopovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
      .filter((el) => isVisible(el));
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) {
      return {
        ok: false,
        reason: 'report filter popover not found: ' + targetFilter,
        availableEditorFields: [],
      };
    }
    const controls = [...popover.querySelectorAll('button.slds-picklist__label')]
      .filter((el) => isVisible(el));
    const control = controls.find((el) =>
      matches(readFieldLabel(el), targetField) ||
      matches(el.textContent || '', targetField),
    ) || null;
    if (!control) {
      return {
        ok: false,
        reason: 'report filter editor field not found: ' + targetField,
        availableEditorFields: readEditorFields(popover),
      };
    }
    const frameRect = frame.getBoundingClientRect();
    const rect = control.getBoundingClientRect();
    return {
      ok: true,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      fieldLabel: readFieldLabel(control) || normalize(control.textContent || ''),
      currentValue: normalize(control.textContent || ''),
      availableEditorFields: readEditorFields(popover),
    };
  })()`;
}

function buildLocateReportFilterEditorOptionScript(
  filterLabel: string,
  optionLabel: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const optionJson = JSON.stringify(optionLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const targetOption = ${optionJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const equals = (value, needle) =>
      normalize(value).toLowerCase() === normalize(needle).toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc || !frame) {
      return { ok: false, reason: 'report iframe not available', availableOptions: [] };
    }
    const resolveOptionTarget = (node) => {
      if (!node) return null;
      if (
        node.matches &&
        node.matches(
          'a, button, [role="option"], [role^="menuitem"], .slds-listbox__option, .slds-listbox__option-text',
        )
      ) {
        return node;
      }
      return node.querySelector &&
        node.querySelector(
          'a, button, [role="option"], [role^="menuitem"], .slds-listbox__option, .slds-listbox__option-text',
        );
    };
    const dropdowns = [...doc.querySelectorAll('.slds-dropdown, [role="menu"], [role="listbox"], .uiMenuList')]
      .filter((el) => isVisible(el));
    const seen = new Set();
    const availableOptions = [];
    let exactMatch = null;
    let partialMatch = null;
    for (const dropdown of dropdowns) {
      for (const candidate of dropdown.querySelectorAll(
        'li.slds-dropdown__item, [role="option"], a[role^="menuitem"], button[role^="menuitem"], li.slds-dropdown__item a, li.slds-dropdown__item button, li.slds-listbox__item, .slds-listbox__option',
      )) {
        if (!isVisible(candidate)) continue;
        if (/(^|\\s)slds-listbox__status(\\s|$)/.test(
          typeof candidate.className === 'string' ? candidate.className : '',
        )) {
          continue;
        }
        const text = normalize(candidate.textContent || '');
        if (!text) continue;
        const key = text.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          availableOptions.push(text);
        }
        if (!exactMatch && equals(text, targetOption)) exactMatch = candidate;
        if (!partialMatch && matches(text, targetOption)) partialMatch = candidate;
      }
    }
    const option = exactMatch || partialMatch;
    if (!option) {
      return {
        ok: false,
        reason: 'report filter editor option not found: ' + targetOption,
        availableOptions,
      };
    }
    const target = resolveOptionTarget(option) || option;
    const frameRect = frame.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return {
      ok: true,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      optionText: normalize((target || option).textContent || ''),
      availableOptions,
    };
  })()`;
}

function buildReadReportFilterEditorInputsScript(filterLabel: string): string {
  const filterJson = JSON.stringify(filterLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc) return [];
    const visiblePopovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) return [];
    return [...popover.querySelectorAll('input, textarea, select')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      })
      .map((el) => {
        const container =
          el.closest('.slds-form-element, .filter-date-picker, .date-picker-container') || el.parentElement;
        const label = normalize(
          container && container.querySelector && container.querySelector('label') &&
          container.querySelector('label').textContent || '',
        );
        return {
          label,
          value: 'value' in el ? normalize(el.value || '') : normalize(el.textContent || ''),
          tag: String(el.tagName || '').toLowerCase(),
        };
      })
      .filter((entry) => entry.label || entry.value);
  })()`;
}

function buildLocateReportFilterApplyScript(filterLabel: string): string {
  const filterJson = JSON.stringify(filterLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc) return { ok: false, reason: 'report iframe not available' };
    const visiblePopovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) {
      return { ok: false, reason: 'report filter popover not found: ' + targetFilter };
    }
    const applyButton = [...popover.querySelectorAll('button')]
      .find((el) => matches(el.textContent || '', 'Apply')) || null;
    if (!applyButton) {
      return { ok: false, reason: 'report filter apply button not found: ' + targetFilter };
    }
    const frameRect = frame.getBoundingClientRect();
    const rect = applyButton.getBoundingClientRect();
    return {
      ok: true,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      disabled: applyButton.disabled === true,
    };
  })()`;
}

function buildClickReportFilterApplyScript(filterLabel: string): string {
  const filterJson = JSON.stringify(filterLabel);
  return `(() => {
    const targetFilter = ${filterJson};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const click = (el) => {
      if (!el) return false;
      if (typeof el.click === 'function') {
        el.click();
        return true;
      }
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const event = type.indexOf('pointer') === 0
          ? new PointerEvent(type, {
              ...mouse,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              buttons: 1,
            })
          : new MouseEvent(type, { ...mouse, button: 0, buttons: 1 });
        el.dispatchEvent(event);
      }
      return true;
    };
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc) return { ok: false, reason: 'report iframe not available' };
    const visiblePopovers = [...doc.querySelectorAll('.reports-filter-popover, [role="dialog"]')]
      .filter((el) => isVisible(el));
    const popover = visiblePopovers.find((el) => matches(el.textContent || '', targetFilter)) ||
      (visiblePopovers.length === 1 ? visiblePopovers[0] : visiblePopovers[0] || null);
    if (!popover) {
      return { ok: false, reason: 'report filter popover not found: ' + targetFilter };
    }
    const applyButton = [...popover.querySelectorAll('button')]
      .find((el) => isVisible(el) && matches(el.textContent || '', 'Apply')) || null;
    if (!applyButton) {
      return { ok: false, reason: 'report filter apply button not found: ' + targetFilter };
    }
    if (applyButton.disabled === true) {
      return { ok: false, reason: 'report filter apply button disabled: ' + targetFilter };
    }
    return { ok: click(applyButton) };
  })()`;
}

function buildWaitForReportFilterLabelScript(
  filterLabel: string,
  expectedNewLabel: string,
): string {
  const filterJson = JSON.stringify(filterLabel);
  const expectedJson = JSON.stringify(expectedNewLabel);
  return `(async () => {
    const targetFilter = ${filterJson};
    const expected = ${expectedJson};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matches = (value, needle) =>
      normalize(value).toLowerCase().indexOf(normalize(needle).toLowerCase()) !== -1;
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const frame = document.querySelector('iframe[src*="lightningReportApp.app"]');
    const doc = frame && frame.contentDocument;
    if (!doc) {
      return { ok: false, reason: 'report iframe not available', currentText: '', availableActions: [] };
    }
    const readActions = () =>
      [...doc.querySelectorAll('button.slds-button_reset.slds-text-link, a.select')]
        .filter((el) => isVisible(el))
        .map((el) => normalize(el.textContent || ''))
        .filter(Boolean);
    const findRow = () => {
      const containers = [...doc.querySelectorAll('.filterContainer')];
      for (const container of containers) {
        const trigger =
          container.querySelector('button.slds-button_reset.slds-grow') ||
          container.querySelector('button');
        const text = normalize(
          (trigger && trigger.textContent) || container.textContent || '',
        );
        const title = normalize(container.getAttribute('title') || '');
        if (matches(text, targetFilter) || matches(title, targetFilter)) {
          return trigger || container;
        }
      }
      return null;
    };
    const deadline = Date.now() + 10000;
    let currentText = '';
    while (Date.now() < deadline) {
      const currentRow = findRow();
      if (!currentRow) {
        return {
          ok: false,
          reason: 'report filter row disappeared: ' + targetFilter,
          currentText,
          availableActions: readActions(),
        };
      }
      currentText = normalize(currentRow.textContent || '');
      if (matches(currentText, expected)) {
        return { ok: true, currentText, availableActions: readActions() };
      }
      await sleep(250);
    }
    return {
      ok: false,
      reason:
        'report filter row does not contain expected label "' + expected + '" (saw "' +
        currentText + '")',
      currentText,
      availableActions: readActions(),
    };
  })()`;
}

function describePrintableKey(char: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
} {
  if (/^[0-9]$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      windowsVirtualKeyCode: char.charCodeAt(0),
    };
  }
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase();
    return {
      key: char,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  switch (char) {
    case ".":
      return { key: ".", code: "Period", windowsVirtualKeyCode: 190 };
    case "/":
      return { key: "/", code: "Slash", windowsVirtualKeyCode: 191 };
    case "-":
      return { key: "-", code: "Minus", windowsVirtualKeyCode: 189 };
    case " ":
      return { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
    case ":":
      return { key: ":", code: "Semicolon", windowsVirtualKeyCode: 186 };
    case ",":
      return { key: ",", code: "Comma", windowsVirtualKeyCode: 188 };
    default:
      return {
        key: char,
        code: "",
        windowsVirtualKeyCode: char.charCodeAt(0),
      };
  }
}

async function dispatchMouseClick(
  session: CdpSession,
  x: number,
  y: number,
): Promise<void> {
  await session.client.Input.dispatchMouseEvent({
    type: "mouseMoved",
    x,
    y,
    button: "left",
    buttons: 0,
  });
  await session.client.Input.dispatchMouseEvent({
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await session.client.Input.dispatchMouseEvent({
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function dispatchPrintableText(
  session: CdpSession,
  text: string,
): Promise<void> {
  for (const char of text) {
    const key = describePrintableKey(char);
    await session.client.Input.dispatchKeyEvent({
      type: "rawKeyDown",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: key.windowsVirtualKeyCode,
    });
    await session.client.Input.dispatchKeyEvent({
      type: "char",
      key: key.key,
      code: key.code,
      text: char,
      unmodifiedText: char,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: key.windowsVirtualKeyCode,
    });
    await session.client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: key.windowsVirtualKeyCode,
    });
  }
}

async function dispatchTab(session: CdpSession): Promise<void> {
  await session.client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
  await session.client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
}

async function typeReportFilterEditorInput(
  session: CdpSession,
  filterLabel: string,
  inputLabel: string,
  value: string,
): Promise<void> {
  const deadline = Date.now() + 4000;
  let focus:
    | {
        ok: true;
        value: string;
        preservedReadonlySelection?: boolean;
        clearedReadonlySelection?: boolean;
        x: number;
        y: number;
      }
    | { ok: false; reason: string } = {
      ok: false,
      reason: `report filter editor input not found: ${inputLabel}`,
    };
  while (Date.now() < deadline) {
    focus = await evaluate<
      | {
          ok: true;
          value: string;
          preservedReadonlySelection?: boolean;
          clearedReadonlySelection?: boolean;
          x: number;
          y: number;
        }
      | { ok: false; reason: string }
    >(session, {
      expression: buildFocusSelectReportFilterInputScript(
        filterLabel,
        inputLabel,
        value,
      ),
      awaitPromise: false,
      returnByValue: true,
    });
    if (focus.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!focus.ok) throw new Error(focus.reason);
  if (focus.preservedReadonlySelection === true) return;
  if (focus.clearedReadonlySelection === true) {
    await dispatchMouseClick(session, focus.x, focus.y);
  }
  await dispatchPrintableText(session, value);
  if (focus.clearedReadonlySelection === true) {
    const optionDeadline = Date.now() + 4000;
    let option:
      | {
          ok: true;
          x: number;
          y: number;
          availableOptions: string[];
          noMatches: boolean;
        }
      | {
          ok: false;
          reason: string;
          availableOptions: string[];
          noMatches: boolean;
        } = {
          ok: false,
          reason: `report filter editor option not found for ${inputLabel}: ${value}`,
          availableOptions: [],
          noMatches: false,
        };
    while (Date.now() < optionDeadline) {
      option = await evaluate<
        | {
            ok: true;
            x: number;
            y: number;
            availableOptions: string[];
            noMatches: boolean;
          }
        | {
            ok: false;
            reason: string;
            availableOptions: string[];
            noMatches: boolean;
          }
      >(session, {
        expression: buildLocateReportFilterInputOptionScript(
          filterLabel,
          inputLabel,
          value,
        ),
        awaitPromise: false,
        returnByValue: true,
      });
      if (option.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!option.ok) {
      const detail = option.availableOptions.length > 0
        ? `${option.reason}; saw ${option.availableOptions.join(", ")}`
        : option.reason;
      throw new Error(detail);
    }
    await dispatchMouseClick(session, option.x, option.y);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return;
  }
  await evaluate<
    | { ok: true; value: string }
    | { ok: false; reason: string }
  >(session, {
    expression: buildCommitReportFilterInputScript(filterLabel, inputLabel),
    awaitPromise: false,
    returnByValue: true,
  });
  await dispatchTab(session);
}

async function readReportFilterEditorInputs(
  session: CdpSession,
  filterLabel: string,
): Promise<Array<{ label: string; value: string; tag: string }>> {
  const inputs = await evaluate<
    Array<{ label: string; value: string; tag: string }>
  >(session, {
    expression: buildReadReportFilterEditorInputsScript(filterLabel),
    awaitPromise: false,
    returnByValue: true,
  });
  return Array.isArray(inputs)
    ? inputs.filter((entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.label === "string" &&
        typeof entry.value === "string" &&
        typeof entry.tag === "string"
      )
    : [];
}

function matchesNormalizedText(value: string, needle: string): boolean {
  return value.trim().toLowerCase().includes(needle.trim().toLowerCase());
}

async function openReportFilterEditor(
  session: CdpSession,
  filterLabel: string,
  expectedNewLabel: string,
): Promise<
  | {
      ok: true;
      beforeText: string;
      currentText: string;
      availableActions: string[];
      usedToggleFallback: boolean;
      interactionMode: "noop" | "editor";
      availableEditorFields: Array<{ label: string; value: string }>;
      availableEditorInputs: Array<{ label: string; value: string; tag: string }>;
    }
  | {
      ok: false;
      reason: string;
      beforeText: string;
      currentText: string;
      availableActions: string[];
      usedToggleFallback: boolean;
      availableEditorFields: Array<{ label: string; value: string }>;
      availableEditorInputs: Array<{ label: string; value: string; tag: string }>;
    }
> {
  const out = await evaluate<
    | {
        ok: true;
        beforeText: string;
        currentText: string;
        availableActions?: string[];
        usedToggleFallback?: boolean;
        interactionMode?: "noop" | "editor";
        availableEditorFields?: Array<{ label: string; value: string }>;
        availableEditorInputs?: Array<{ label: string; value: string; tag: string }>;
      }
    | {
        ok: false;
        reason: string;
        beforeText?: string;
        currentText?: string;
        availableActions?: string[];
        usedToggleFallback?: boolean;
        availableEditorFields?: Array<{ label: string; value: string }>;
        availableEditorInputs?: Array<{ label: string; value: string; tag: string }>;
      }
  >(session, {
    expression: buildOpenReportFilterEditorScript(filterLabel, expectedNewLabel),
    awaitPromise: true,
    returnByValue: true,
  });
  const base = {
    beforeText: out.beforeText ?? "",
    currentText: out.currentText ?? "",
    availableActions: Array.isArray(out.availableActions)
      ? out.availableActions.filter((entry) => typeof entry === "string")
      : [],
    usedToggleFallback: out.usedToggleFallback === true,
    availableEditorFields: Array.isArray(out.availableEditorFields)
      ? out.availableEditorFields.filter((entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.label === "string" &&
          typeof entry.value === "string"
        )
      : [],
    availableEditorInputs: Array.isArray(out.availableEditorInputs)
      ? out.availableEditorInputs.filter((entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.label === "string" &&
          typeof entry.value === "string" &&
          typeof entry.tag === "string"
        )
      : [],
  };
  if (!out.ok) {
    return { ok: false, reason: out.reason, ...base };
  }
  return {
    ok: true,
    interactionMode: out.interactionMode === "noop" ? "noop" : "editor",
    ...base,
  };
}

async function selectReportFilterEditorChoice(
  session: CdpSession,
  filterLabel: string,
  fieldLabel: string,
  optionLabel: string,
): Promise<{
  fieldLabel: string;
  currentValue: string;
  availableEditorFields: Array<{ label: string; value: string }>;
  availableOptions: string[];
}> {
  const controlDeadline = Date.now() + 4000;
  let control:
    | {
        ok: true;
        x: number;
        y: number;
        fieldLabel: string;
        currentValue: string;
        availableEditorFields: Array<{ label: string; value: string }>;
      }
    | {
        ok: false;
        reason: string;
        availableEditorFields: Array<{ label: string; value: string }>;
      } = {
        ok: false,
        reason: `report filter editor field not found: ${fieldLabel}`,
        availableEditorFields: [],
      };
  while (Date.now() < controlDeadline) {
    control = await evaluate<
      | {
          ok: true;
          x: number;
          y: number;
          fieldLabel: string;
          currentValue: string;
          availableEditorFields: Array<{ label: string; value: string }>;
        }
      | {
          ok: false;
          reason: string;
          availableEditorFields: Array<{ label: string; value: string }>;
        }
    >(session, {
      expression: buildLocateReportFilterEditorFieldControlScript(
        filterLabel,
        fieldLabel,
      ),
      awaitPromise: false,
      returnByValue: true,
    });
    if (control.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!control.ok) throw new Error(control.reason);
  if (matchesNormalizedText(control.currentValue, optionLabel)) {
    return {
      fieldLabel: control.fieldLabel,
      currentValue: control.currentValue,
      availableEditorFields: control.availableEditorFields,
      availableOptions: [],
    };
  }

  await dispatchMouseClick(session, control.x, control.y);
  const optionDeadline = Date.now() + 4000;
  let option:
    | {
        ok: true;
        x: number;
        y: number;
        optionText: string;
        availableOptions: string[];
      }
    | {
        ok: false;
        reason: string;
        availableOptions: string[];
      } = {
        ok: false,
        reason: `report filter editor option not found: ${optionLabel}`,
        availableOptions: [],
      };
  let reopenedControl = false;
  while (Date.now() < optionDeadline) {
    option = await evaluate<
      | {
          ok: true;
          x: number;
          y: number;
          optionText: string;
          availableOptions: string[];
        }
      | {
          ok: false;
          reason: string;
          availableOptions: string[];
        }
    >(session, {
      expression: buildLocateReportFilterEditorOptionScript(
        filterLabel,
        optionLabel,
      ),
      awaitPromise: false,
      returnByValue: true,
    });
    if (option.ok) break;
    if (!reopenedControl) {
      await dispatchMouseClick(session, control.x, control.y);
      reopenedControl = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!option.ok) {
    const detail = option.availableOptions.length > 0
      ? `${option.reason}; saw ${option.availableOptions.join(", ")}`
      : option.reason;
    throw new Error(detail);
  }

  await dispatchMouseClick(session, option.x, option.y);

  const confirmDeadline = Date.now() + 4000;
  while (Date.now() < confirmDeadline) {
    control = await evaluate<
      | {
          ok: true;
          x: number;
          y: number;
          fieldLabel: string;
          currentValue: string;
          availableEditorFields: Array<{ label: string; value: string }>;
        }
      | {
          ok: false;
          reason: string;
          availableEditorFields: Array<{ label: string; value: string }>;
        }
    >(session, {
      expression: buildLocateReportFilterEditorFieldControlScript(
        filterLabel,
        fieldLabel,
      ),
      awaitPromise: false,
      returnByValue: true,
    });
    if (control.ok && matchesNormalizedText(control.currentValue, optionLabel)) {
      return {
        fieldLabel: control.fieldLabel,
        currentValue: control.currentValue,
        availableEditorFields: control.availableEditorFields,
        availableOptions: option.availableOptions,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (!control.ok) throw new Error(control.reason);
  throw new Error(
    `report filter editor field "${fieldLabel}" did not update to "${optionLabel}" (saw "${control.currentValue}")`,
  );
}

async function clickReportFilterApply(
  session: CdpSession,
  filterLabel: string,
): Promise<void> {
  const deadline = Date.now() + 4000;
  let applyTarget:
    | { ok: true; x: number; y: number; disabled: boolean }
    | { ok: false; reason: string } = {
      ok: false,
      reason: `report filter apply button not found: ${filterLabel}`,
    };
  while (Date.now() < deadline) {
    applyTarget = await evaluate<
      | { ok: true; x: number; y: number; disabled: boolean }
      | { ok: false; reason: string }
    >(session, {
      expression: buildLocateReportFilterApplyScript(filterLabel),
      awaitPromise: false,
      returnByValue: true,
    });
    if (applyTarget.ok && !applyTarget.disabled) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!applyTarget.ok) throw new Error(applyTarget.reason);
  if (applyTarget.disabled) {
    throw new Error(`report filter apply button disabled: ${filterLabel}`);
  }
  await dispatchMouseClick(session, applyTarget.x, applyTarget.y);
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    await evaluate<{ ok: boolean; reason?: string }>(session, {
      expression: buildClickReportFilterApplyScript(filterLabel),
      awaitPromise: false,
      returnByValue: true,
    });
  } catch {
    // The first CDP click may already have closed the popover; keep the commit path best-effort.
  }
}

async function waitForReportFilterLabel(
  session: CdpSession,
  filterLabel: string,
  expectedNewLabel: string,
): Promise<
  | { ok: true; currentText: string; availableActions: string[] }
  | { ok: false; reason: string; currentText: string; availableActions: string[] }
> {
  return await evaluate<
    | { ok: true; currentText: string; availableActions: string[] }
    | { ok: false; reason: string; currentText: string; availableActions: string[] }
  >(session, {
    expression: buildWaitForReportFilterLabelScript(
      filterLabel,
      expectedNewLabel,
    ),
    awaitPromise: true,
    returnByValue: true,
  });
}

export async function setReportFilterCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as SetReportFilterArgs;
  if (typeof args.filterLabel !== "string" || !args.filterLabel) {
    return failedResult(
      invocation,
      new Error(
        "set-report-filter requires `arguments.filterLabel` (non-empty string)",
      ),
    );
  }
  if (typeof args.actionLabel !== "string" || !args.actionLabel) {
    return failedResult(
      invocation,
      new Error(
        "set-report-filter requires `arguments.actionLabel` (non-empty string)",
      ),
    );
  }
  if (typeof args.expectedNewLabel !== "string" || !args.expectedNewLabel) {
    return failedResult(
      invocation,
      new Error(
        "set-report-filter requires `arguments.expectedNewLabel` (non-empty string)",
      ),
    );
  }

  const attachOpts = buildAttachOpts(args);

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

  try {
    try {
      await session.client.Page.bringToFront();
    } catch {
      // Some CDP targets reject bringToFront; keep going with the existing session.
    }
    const urlBefore = session.target.url;
    const captures = {
      beforeText: null as string | null,
      clickedAction: null as string | null,
      currentText: null as string | null,
      availableActions: [] as string[],
      usedToggleFallback: false,
      interactionMode: null as string | null,
      editorField: null as string | null,
      editorOption: null as string | null,
      availableEditorFields: [] as Array<{ label: string; value: string }>,
      availableEditorOptions: [] as string[],
      availableEditorInputs: [] as Array<{ label: string; value: string; tag: string }>,
    };

    const rollback = async (): Promise<void> => {
      await session!.client.Page.reload({ ignoreCache: false });
    };

    const result = await runAction({
      session,
      noToast: ["error", "warning"],
      skipStability: true,
      rollback,
      action: async () => {
        if (
          typeof args.editorFieldLabel === "string" &&
          args.editorFieldLabel.trim().length > 0
        ) {
          const editor = await openReportFilterEditor(
            session!,
            args.filterLabel,
            args.expectedNewLabel,
          );
          captures.beforeText = editor.beforeText;
          captures.currentText = editor.currentText;
          captures.availableActions = editor.availableActions;
          captures.usedToggleFallback = editor.usedToggleFallback;
          captures.interactionMode = editor.ok ? editor.interactionMode : null;
          captures.availableEditorFields = editor.availableEditorFields;
          captures.availableEditorInputs = editor.availableEditorInputs;
          captures.editorField = args.editorFieldLabel;
          captures.editorOption = null;
          captures.availableEditorOptions = [];
          if (!editor.ok) throw new Error(editor.reason);
          if (editor.interactionMode === "noop") return;

          const selected = await selectReportFilterEditorChoice(
            session!,
            args.filterLabel,
            args.editorFieldLabel,
            args.actionLabel,
          );
          captures.editorField = selected.fieldLabel;
          captures.editorOption = selected.currentValue;
          captures.availableEditorFields = selected.availableEditorFields;
          captures.availableEditorOptions = selected.availableOptions;

          if (hasEditorInputValues(args.editorInputValues)) {
            for (const [inputLabel, inputValue] of Object.entries(args.editorInputValues)) {
              if (!inputLabel.trim()) continue;
              await typeReportFilterEditorInput(
                session!,
                args.filterLabel,
                inputLabel,
                inputValue,
              );
            }
          }
          captures.availableEditorInputs = await readReportFilterEditorInputs(
            session!,
            args.filterLabel,
          );
          await clickReportFilterApply(session!, args.filterLabel);
          const after = await waitForReportFilterLabel(
            session!,
            args.filterLabel,
            args.expectedNewLabel,
          );
          captures.currentText = after.currentText;
          captures.availableActions = after.availableActions;
          if (!after.ok) throw new Error(after.reason);
          return;
        }

        const out = await evaluate<
          | {
              ok: true;
              beforeText: string;
              clickedAction: string | null;
              currentText: string;
              availableActions?: string[];
              usedToggleFallback?: boolean;
              interactionMode?: string | null;
              editorField?: string | null;
              editorOption?: string | null;
              availableEditorFields?: Array<{ label: string; value: string }>;
              availableEditorOptions?: string[];
              availableEditorInputs?: Array<{ label: string; value: string; tag: string }>;
              needsTypedInputs?: boolean;
            }
          | {
              ok: false;
              reason: string;
              beforeText?: string;
              clickedAction?: string | null;
              currentText?: string;
              availableActions?: string[];
              usedToggleFallback?: boolean;
              interactionMode?: string | null;
              editorField?: string | null;
              editorOption?: string | null;
              availableEditorFields?: Array<{ label: string; value: string }>;
              availableEditorOptions?: string[];
              availableEditorInputs?: Array<{ label: string; value: string; tag: string }>;
            }
        >(session!, {
          expression: buildApplyInlineFilterScript(
            args.filterLabel,
            args.actionLabel,
            args.expectedNewLabel,
            args.editorFieldLabel,
            args.editorInputValues,
          ),
          awaitPromise: true,
          returnByValue: true,
        });
        captures.beforeText = out.beforeText ?? null;
        captures.clickedAction = out.clickedAction ?? null;
        captures.currentText = out.currentText ?? null;
        captures.availableActions = Array.isArray(out.availableActions)
          ? out.availableActions
          : [];
        captures.usedToggleFallback = out.usedToggleFallback === true;
        captures.interactionMode = typeof out.interactionMode === "string"
          ? out.interactionMode
          : null;
        captures.editorField = typeof out.editorField === "string"
          ? out.editorField
          : null;
        captures.editorOption = typeof out.editorOption === "string"
          ? out.editorOption
          : null;
        captures.availableEditorFields = Array.isArray(out.availableEditorFields)
          ? out.availableEditorFields
              .filter((entry) =>
                entry &&
                typeof entry === "object" &&
                typeof entry.label === "string" &&
                typeof entry.value === "string"
              )
          : [];
        captures.availableEditorOptions = Array.isArray(out.availableEditorOptions)
          ? out.availableEditorOptions.filter((entry) => typeof entry === "string")
          : [];
        captures.availableEditorInputs = Array.isArray(out.availableEditorInputs)
          ? out.availableEditorInputs
              .filter((entry) =>
                entry &&
                typeof entry === "object" &&
                typeof entry.label === "string" &&
                typeof entry.value === "string" &&
                typeof entry.tag === "string"
              )
          : [];
        if (!out.ok) throw new Error(out.reason);
        if (out.needsTypedInputs === true && hasEditorInputValues(args.editorInputValues)) {
          for (const [inputLabel, inputValue] of Object.entries(args.editorInputValues)) {
            if (!inputLabel.trim()) continue;
            await typeReportFilterEditorInput(
              session!,
              args.filterLabel,
              inputLabel,
              inputValue,
            );
          }
          captures.availableEditorInputs = await readReportFilterEditorInputs(
            session!,
            args.filterLabel,
          );
          await clickReportFilterApply(session!, args.filterLabel);
          const after = await waitForReportFilterLabel(
            session!,
            args.filterLabel,
            args.expectedNewLabel,
          );
          captures.currentText = after.currentText;
          captures.availableActions = after.availableActions;
          if (!after.ok) throw new Error(after.reason);
        }
      },
    });

    const status: AdapterResult["status"] = result.ok ? "success" : "failed";

    const summary = result.ok
      ? `set-report-filter "${args.filterLabel}" via "${args.actionLabel}" verified as "${args.expectedNewLabel}" in ${result.durationMs}ms`
      : `set-report-filter failed: ${result.checks
          .filter((check) => check.status === "failed")
          .map((check) => `${check.name}: ${check.detail ?? ""}`)
          .join("; ")}`;

    const nextActions: string[] = [];
    if (!result.ok) {
      nextActions.push(
        result.rolledBack
          ? "report reloaded back to the saved view after the failed attempt"
          : "manual report reload may be needed to restore the saved view",
      );
    }

    return buildResult({
      invocation,
      status,
      summary,
      observedState: {
        targetId: session.target.id,
        helperInstalled: session.helperInstalled,
        filterLabel: args.filterLabel,
        actionLabel: args.actionLabel,
        expectedNewLabel: args.expectedNewLabel,
        editorFieldLabel: args.editorFieldLabel ?? null,
        editorInputValues: args.editorInputValues ?? null,
        beforeText: captures.beforeText,
        clickedAction: captures.clickedAction,
        currentText: captures.currentText,
        availableActions: captures.availableActions,
        usedToggleFallback: captures.usedToggleFallback,
        interactionMode: captures.interactionMode,
        editorField: captures.editorField,
        editorOption: captures.editorOption,
        availableEditorFields: captures.availableEditorFields,
        availableEditorOptions: captures.availableEditorOptions,
        availableEditorInputs: captures.availableEditorInputs,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        urlBefore,
      },
      sideEffects: [
        {
          class: "shared_write",
          target: urlBefore,
          summary: `apply report filter action "${args.actionLabel}" to "${args.filterLabel}"`,
        },
      ],
      verification: {
        status: result.ok ? "passed" : "failed",
        checks: ["policy", "trace_grade"],
      },
      suggestedNextActions: nextActions,
    });
  } finally {
    await session.close();
  }
}
