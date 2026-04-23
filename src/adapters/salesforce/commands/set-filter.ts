import {
  attach,
  evaluate,
  type CdpAttachOptions,
  type CdpSession,
} from "../../browser/cdp.ts";
import {
  runAction,
  type ActionCheck,
  type ActionLoopResult,
} from "../../browser/actions/action-loop.ts";
import type { NetworkMatcher } from "../../browser/actions/network-expect.ts";
import { buildResult, failedResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

// v0.6 "click" variant:
//   "click the filter pill whose aria-label contains `filterLabel`, then
//    verify the pill's new aria-label matches `expectedNewLabel` after the
//    page network settles."
//
// This is the single-click flow that works against:
//   - our synthetic dashboard (pill has a click handler that mutates its
//     own aria-label + fires a mock network request)
//   - simple real-SF dashboards where the filter pill itself cycles values
//
// v0.7 adds the "dropdown" variant — the three-step flow that real SF
// Lightning dashboards use: click the pill → click an option row in the
// popover → click Apply → verify the pill label updated.
//
// Network expectation defaults to a broad regex covering SF Aura action
// endpoints + CRMA analytics endpoints + the synthetic /mock-* pattern.
// Override via `networkUrlRegex` arg (string form of a RegExp).

type SetFilterVariant = "click" | "dropdown";

interface SetFilterBaseArgs extends CdpAttachOptions {
  variant?: SetFilterVariant;
  filterLabel: string;
  expectedNewLabel?: string;
  networkUrlRegex?: string;
  urlHint?: string;
}

interface SetFilterClickArgs extends SetFilterBaseArgs {
  variant?: "click";
}

interface SetFilterDropdownArgs extends SetFilterBaseArgs {
  variant: "dropdown";
  /** Required. Visible text of the option row to click inside the popover. */
  optionLabel: string;
  /** Optional. Regex source for the apply button text. Default: Apply|Update|Done|Save. */
  applyButtonText?: string;
}

type SetFilterArgs = SetFilterClickArgs | SetFilterDropdownArgs;

const DEFAULT_URL_MATCH = /salesforce|lightning|force\.com/i;
const DEFAULT_NETWORK_REGEX =
  "/aura\\?.*ApexAction\\.execute|/services/data/v[0-9.]+/analytics|/wave/query|/mock-";
const DEFAULT_APPLY_BUTTON_REGEX = "^(Apply|Update|Done|Save)$";
const IGNORABLE_CLASSIC_DASHBOARD_TOAST_PATTERNS = [
  /you can't refresh this dashboard more than once in a minute/i,
];

// Page-side script to find + click the filter pill whose aria-label
// contains the target text. Returns {found, beforeLabel}.
function buildClickScript(filterLabel: string): string {
  const labelJson = JSON.stringify(filterLabel);
  return `(() => {
    const target = ${labelJson};
    const selectors = [
      'analytics-filter-pill',
      'wave-dashboard-filter-pill',
      '[role="listitem"][aria-label]',
      '[data-aura-class*="filter" i][aria-label]',
    ];
    let found = null;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const lbl = el.getAttribute('aria-label') || el.textContent || '';
        if (lbl.indexOf(target) !== -1) { found = el; break; }
      }
      if (found) break;
    }
    if (!found) return { ok: false, reason: 'filter pill not found: ' + target };
    const beforeLabel = found.getAttribute('aria-label') || found.textContent || '';
    // Scroll into view so the click is not intercepted by fixed headers.
    try { found.scrollIntoView({ block: 'center' }); } catch (_e) {}
    // Dispatch a real click so SF event delegates fire.
    try {
      found.click();
    } catch (e) {
      return { ok: false, reason: 'click failed: ' + (e && e.message || e) };
    }
    return { ok: true, beforeLabel };
  })()`;
}

// Page-side script to check whether the pill now carries the expected label.
function buildVerifyScript(
  filterLabel: string,
  expectedNewLabel: string,
): string {
  const labelJson = JSON.stringify(filterLabel);
  const expectedJson = JSON.stringify(expectedNewLabel);
  return `(() => {
    const target = ${labelJson};
    const expected = ${expectedJson};
    const selectors = [
      'analytics-filter-pill',
      'wave-dashboard-filter-pill',
      '[role="listitem"][aria-label]',
      '[data-aura-class*="filter" i][aria-label]',
    ];
    // Prefer finding a pill that NOW matches the expected label; fall back
    // to a pill that still matches the original target if the label change
    // hasn't landed yet.
    let byNew = null;
    let byOriginal = null;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const lbl = el.getAttribute('aria-label') || el.textContent || '';
        if (!byNew && lbl.indexOf(expected) !== -1) byNew = { el, lbl };
        if (!byOriginal && lbl.indexOf(target) !== -1) byOriginal = { el, lbl };
      }
    }
    if (byNew) {
      return {
        ok: true,
        observed: { currentLabel: byNew.lbl, expected },
      };
    }
    return {
      ok: false,
      reason:
        'filter pill does not carry expected label "' + expected + '"' +
        (byOriginal ? ' (still shows "' + byOriginal.lbl + '")' : ' (pill not found at all)'),
      observed: { expected, originalTargetStillPresent: !!byOriginal },
    };
  })()`;
}

// Page-side predicate: is a dropdown/popover currently visible?
// Used as the Step A DOM predicate for the dropdown variant.
function buildDropdownVisibleScript(): string {
  return `(() => {
    const selectors = [
      '.slds-dropdown',
      '.slds-popover',
      '[role="dialog"]',
      '[role="listbox"]',
    ];
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) {
          return {
            ok: true,
            observed: {
              selector: sel,
              classes: el.className || '',
              role: el.getAttribute('role') || '',
            },
          };
        }
      }
    }
    return { ok: false, reason: 'no visible dropdown/popover found after click' };
  })()`;
}

// Page-side script: find a dropdown option row whose textContent matches
// `optionLabel` and click it. Returns {ok, matchedText} or {ok:false, reason}.
// We scope the search to the nearest visible popover-ish container so we
// don't accidentally click something in the underlying dashboard.
function buildClickOptionScript(optionLabel: string): string {
  const labelJson = JSON.stringify(optionLabel);
  return `(() => {
    const target = ${labelJson};
    const containerSelectors = [
      '.slds-dropdown',
      '.slds-popover',
      '[role="dialog"]',
      '[role="listbox"]',
    ];
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const containers = [];
    for (const sel of containerSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) containers.push(el);
      }
    }
    if (containers.length === 0) {
      return { ok: false, reason: 'no visible dropdown container to search for option: ' + target };
    }
    const optionSelectors = [
      'li[role="option"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitem"]',
      'lightning-menu-item',
      '.slds-listbox__option',
      '.slds-listbox__item',
    ];
    const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const targetNorm = normalize(target);
    let matched = null;
    for (const container of containers) {
      for (const sel of optionSelectors) {
        for (const el of container.querySelectorAll(sel)) {
          const text = normalize(el.textContent || '');
          if (!text) continue;
          if (text === targetNorm || text.indexOf(targetNorm) !== -1) {
            matched = { el, text };
            break;
          }
        }
        if (matched) break;
      }
      if (matched) break;
    }
    if (!matched) {
      return { ok: false, reason: 'option not found in dropdown: ' + target };
    }
    try { matched.el.scrollIntoView({ block: 'center' }); } catch (_e) {}
    try {
      matched.el.click();
    } catch (e) {
      return { ok: false, reason: 'click option failed: ' + (e && e.message || e) };
    }
    return { ok: true, matchedText: matched.text };
  })()`;
}

// Page-side predicate: the option that was just clicked (matched by text)
// now carries a "selected" signal. Pass if ANY of aria-checked, aria-selected,
// .is-active, .selected, or .slds-is-selected is present on the matched row
// (or any ancestor up to the container).
function buildOptionSelectedScript(optionLabel: string): string {
  const labelJson = JSON.stringify(optionLabel);
  return `(() => {
    const target = ${labelJson};
    const containerSelectors = [
      '.slds-dropdown',
      '.slds-popover',
      '[role="dialog"]',
      '[role="listbox"]',
    ];
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const containers = [];
    for (const sel of containerSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) containers.push(el);
      }
    }
    // If the dropdown has auto-closed (some SF dropdowns auto-apply on click),
    // treat that as an acceptable "selected" signal — we can't verify in-DOM
    // but Step C will catch any actual failure via the pill label check.
    if (containers.length === 0) {
      return {
        ok: true,
        observed: { autoClosed: true, note: 'dropdown closed after option click' },
      };
    }
    const optionSelectors = [
      'li[role="option"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitem"]',
      'lightning-menu-item',
      '.slds-listbox__option',
      '.slds-listbox__item',
    ];
    const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const targetNorm = normalize(target);
    const selectedClassRegex = /(^|\\s)(is-active|selected|slds-is-selected)(\\s|$)/;
    const hasSelectedSignal = (el) => {
      if (!el) return false;
      const ariaChecked = el.getAttribute && el.getAttribute('aria-checked');
      if (ariaChecked === 'true') return true;
      const ariaSelected = el.getAttribute && el.getAttribute('aria-selected');
      if (ariaSelected === 'true') return true;
      const cls = (el.className && typeof el.className === 'string') ? el.className : '';
      if (selectedClassRegex.test(cls)) return true;
      return false;
    };
    let matched = null;
    for (const container of containers) {
      for (const sel of optionSelectors) {
        for (const el of container.querySelectorAll(sel)) {
          const text = normalize(el.textContent || '');
          if (!text) continue;
          if (text === targetNorm || text.indexOf(targetNorm) !== -1) {
            // Walk up to container checking for selected signal on the row
            // itself or any wrapping ancestor.
            let cur = el;
            let found = false;
            while (cur && cur !== container) {
              if (hasSelectedSignal(cur)) { found = true; break; }
              cur = cur.parentElement;
            }
            matched = { el, text, selected: found };
            break;
          }
        }
        if (matched) break;
      }
      if (matched) break;
    }
    if (!matched) {
      return { ok: false, reason: 'option row no longer visible after click: ' + target };
    }
    if (matched.selected) {
      return { ok: true, observed: { text: matched.text } };
    }
    return {
      ok: false,
      reason: 'option "' + matched.text + '" did not show a selected signal (aria-checked/aria-selected/.is-active/.selected)',
    };
  })()`;
}

// Page-side script: click an Apply/Update/Done/Save button scoped to the
// open dropdown. If no such button is found, fall back to dispatching an
// Enter keypress on the active element (some SF dropdowns auto-apply and
// have no explicit button). Returns {ok, via: 'button'|'enter'|'none'}.
function buildClickApplyScript(applyButtonRegexSource: string): string {
  const regexJson = JSON.stringify(applyButtonRegexSource);
  return `(() => {
    const btnRegex = new RegExp(${regexJson}, 'i');
    const containerSelectors = [
      '.slds-dropdown',
      '.slds-popover',
      '[role="dialog"]',
      '[role="listbox"]',
    ];
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const containers = [];
    for (const sel of containerSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) containers.push(el);
      }
    }
    const normalize = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const buttonSelectors = ['button', 'lightning-button', '[role="button"]'];
    let matched = null;
    for (const container of containers) {
      for (const sel of buttonSelectors) {
        for (const el of container.querySelectorAll(sel)) {
          if (!isVisible(el)) continue;
          const text = normalize(el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '');
          if (!text) continue;
          if (btnRegex.test(text)) {
            matched = { el, text };
            break;
          }
        }
        if (matched) break;
      }
      if (matched) break;
    }
    if (matched) {
      try { matched.el.scrollIntoView({ block: 'center' }); } catch (_e) {}
      try {
        matched.el.click();
      } catch (e) {
        return { ok: false, reason: 'apply click failed: ' + (e && e.message || e) };
      }
      return { ok: true, via: 'button', text: matched.text };
    }
    // Fallback: fire Enter on the active element (or the first container).
    const target = (document.activeElement && containers.indexOf(document.activeElement.closest && document.activeElement.closest('.slds-dropdown, .slds-popover, [role="dialog"], [role="listbox"]')) !== -1)
      ? document.activeElement
      : (containers[0] || document.activeElement || document.body);
    try {
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keypress', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch (e) {
      return { ok: false, reason: 'no apply button found and enter fallback failed: ' + (e && e.message || e) };
    }
    return { ok: true, via: 'enter' };
  })()`;
}

// ---- Classic Lightning dashboard helpers ----

function buildLocateClassicDashboardFilterControlScript(
  filterLabel: string,
): string {
  const labelJson = JSON.stringify(filterLabel);
  return `(() => {
    const target = ${labelJson};
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
    const frameCandidates = [...document.querySelectorAll('iframe')];
    const resolveFrame = () => {
      for (const frame of frameCandidates) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
        if (!doc) continue;
        if (/desktopDashboards\\/dashboardApp|\\/analytics\\/wave\\//.test(frame.src || '')) {
          return { frame, doc };
        }
      }
      for (const frame of frameCandidates) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
        if (!doc) continue;
        if (doc.querySelector('.filterGrid .filterPanel, .filterPanel, .picklistContainer, .slds-form-element.picklist')) {
          return { frame, doc };
        }
      }
      return null;
    };
    const resolved = resolveFrame();
    if (!resolved) {
      return {
        ok: false,
        surfaceDetected: false,
        reason: 'classic dashboard iframe not available',
        availableFilters: [],
        scanIframeSrc: null,
      };
    }
    const { frame, doc } = resolved;
    const roots = [];
    const seen = new Set();
    for (const sel of ['.filterGrid .filterPanel', '.filterPanel', '.picklistContainer', '.slds-form-element.picklist']) {
      for (const node of doc.querySelectorAll(sel)) {
        if (!node || seen.has(node) || !isVisible(node)) continue;
        seen.add(node);
        roots.push(node);
      }
    }
    const readLabel = (root) => normalize(
      root.querySelector('label.slds-form-element__label')?.textContent ||
      root.getAttribute('aria-label') ||
      root.getAttribute('title') ||
      ''
    );
    const readValue = (root, button) => {
      const buttonValue = normalize(
        button?.querySelector('.slds-truncate')?.textContent ||
        button?.getAttribute('data-selected-option-value') ||
        button?.textContent ||
        ''
      );
      const rootValue = normalize(
        root.getAttribute('data-selected-option-value') ||
        root.querySelector('[data-selected-option-value]')?.getAttribute('data-selected-option-value') ||
        ''
      );
      const selectedTokens = [...root.querySelectorAll(
        '#listbox-selections-unique-id .slds-pill__label, [role="listbox"] .slds-pill__label'
      )]
        .map((node) => normalize(node.textContent || ''))
        .filter(Boolean)
        .join(', ');
      const announcementValue = normalize(
        (
          root.querySelector('.slds-assistive-text[id^="filter-announcement-"]')?.textContent ||
          ''
        ).replace(/^filter set to\\s+/i, '')
      );
      if (buttonValue && buttonValue.toLowerCase() !== 'select an option') {
        return buttonValue;
      }
      if (rootValue) return rootValue;
      if (selectedTokens) return selectedTokens;
      if (announcementValue) return announcementValue;
      return buttonValue;
    };
    const entries = roots
      .map((root) => {
        const button = root.querySelector('button.slds-picklist__label, button');
        return {
          root,
          button,
          label: readLabel(root),
          value: readValue(root, button),
        };
      })
      .filter((entry) => entry.label || entry.value);
    const availableFilters = [...new Set(
      entries.map((entry) => entry.label || entry.value).filter(Boolean)
    )];
    const match = entries.find((entry) => matches(entry.label, target) || equals(entry.label, target)) || null;
    if (!match) {
      return {
        ok: false,
        surfaceDetected: true,
        reason: 'classic dashboard filter not found: ' + target,
        availableFilters,
        scanIframeSrc: frame.src || null,
      };
    }
    if (!match.button || !isVisible(match.button)) {
      return {
        ok: false,
        surfaceDetected: true,
        reason: 'classic dashboard filter control not clickable: ' + (match.label || target),
        availableFilters,
        scanIframeSrc: frame.src || null,
      };
    }
    const frameRect = frame.getBoundingClientRect();
    const rect = match.button.getBoundingClientRect();
    return {
      ok: true,
      surfaceDetected: true,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      label: match.label || target,
      beforeLabel: match.value,
      availableFilters,
      scanIframeSrc: frame.src || null,
    };
  })()`;
}

function buildLocateClassicDashboardFilterOptionScript(
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
    const frameCandidates = [...document.querySelectorAll('iframe')];
    const resolveFrame = () => {
      for (const frame of frameCandidates) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
        if (!doc) continue;
        if (/desktopDashboards\\/dashboardApp|\\/analytics\\/wave\\//.test(frame.src || '')) {
          return { frame, doc };
        }
      }
      for (const frame of frameCandidates) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
        if (!doc) continue;
        if (doc.querySelector('.filterGrid .filterPanel, .filterPanel, .picklistContainer, .slds-form-element.picklist')) {
          return { frame, doc };
        }
      }
      return null;
    };
    const resolved = resolveFrame();
    if (!resolved) {
      return {
        ok: false,
        reason: 'classic dashboard iframe not available',
        availableOptions: [],
        scanIframeSrc: null,
      };
    }
    const { frame, doc } = resolved;
    const roots = [];
    const seen = new Set();
    for (const sel of ['.filterGrid .filterPanel', '.filterPanel', '.picklistContainer', '.slds-form-element.picklist']) {
      for (const node of doc.querySelectorAll(sel)) {
        if (!node || seen.has(node) || !isVisible(node)) continue;
        seen.add(node);
        roots.push(node);
      }
    }
    const readLabel = (root) => normalize(
      root.querySelector('label.slds-form-element__label')?.textContent ||
      root.getAttribute('aria-label') ||
      root.getAttribute('title') ||
      ''
    );
    const root = roots.find((entry) => matches(readLabel(entry), targetFilter) || equals(readLabel(entry), targetFilter)) || null;
    if (!root) {
      return {
        ok: false,
        reason: 'classic dashboard filter not found: ' + targetFilter,
        availableOptions: [],
        scanIframeSrc: frame.src || null,
      };
    }
    const button = root.querySelector('button.slds-picklist__label, button');
    const dropdowns = [];
    const isOptionContainer = (node) => {
      if (!node || !isVisible(node)) return false;
      if (node.id === 'listbox-selections-unique-id') return false;
      const ariaLabel = normalize(node.getAttribute?.('aria-label') || '');
      return ariaLabel !== 'selected options:';
    };
    const pushDropdown = (node) => {
      if (!isOptionContainer(node) || dropdowns.indexOf(node) !== -1) return;
      dropdowns.push(node);
    };
    for (const node of root.querySelectorAll('.slds-picklist.slds-is-open .slds-dropdown, .slds-dropdown[role="menu"], .slds-dropdown, [role="listbox"], [role="menu"]')) {
      pushDropdown(node);
    }
    const openPicklist = root.querySelector('.slds-picklist.slds-is-open');
    if (openPicklist) {
      for (const node of openPicklist.querySelectorAll('.slds-dropdown, [role="listbox"], [role="menu"]')) {
        pushDropdown(node);
      }
    }
    for (const node of doc.querySelectorAll('.slds-picklist.slds-is-open .slds-dropdown, .slds-dropdown[role="menu"], .slds-dropdown, [role="listbox"], [role="menu"]')) {
      pushDropdown(node);
    }
    if (dropdowns.length === 0 && button) {
      try { button.click(); } catch (_e) { /* non-fatal */ }
    }
    const resolveOptionTarget = (node) => {
      if (!node) return null;
      if (
        node.matches &&
        node.matches(
          'a, button, [role="menuitemcheckbox"], [role="menuitem"], [role="option"], .slds-listbox__option, .slds-listbox__option-text'
        )
      ) {
        return node;
      }
      return node.querySelector &&
        node.querySelector(
          'a, button, [role="menuitemcheckbox"], [role="menuitem"], [role="option"], .slds-listbox__option, .slds-listbox__option-text'
        );
    };
    const availableOptions = [];
    const seenOptions = new Set();
    let exactMatch = null;
    let partialMatch = null;
    for (const dropdown of dropdowns) {
      for (const candidate of dropdown.querySelectorAll(
        'li.slds-dropdown__item, li.slds-listbox__item, [role="menuitemcheckbox"], [role="menuitem"], [role="option"], a, button, .slds-listbox__option'
      )) {
        if (!isVisible(candidate)) continue;
        const text = normalize(candidate.textContent || '');
        if (!text) continue;
        const key = text.toLowerCase();
        if (!seenOptions.has(key)) {
          seenOptions.add(key);
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
        reason: 'classic dashboard option not found: ' + targetOption,
        availableOptions,
        scanIframeSrc: frame.src || null,
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
      scanIframeSrc: frame.src || null,
    };
  })()`;
}

function buildVerifyClassicDashboardFilterScript(
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
    const resolveFrame = () => {
      for (const frame of document.querySelectorAll('iframe')) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
        if (!doc) continue;
        if (/desktopDashboards\\/dashboardApp|\\/analytics\\/wave\\//.test(frame.src || '')) {
          return { frame, doc };
        }
      }
      return null;
    };
    const resolved = resolveFrame();
    if (!resolved) {
      return { ok: false, reason: 'classic dashboard iframe not available' };
    }
    const { doc } = resolved;
    const readLabel = (root) => normalize(
      root.querySelector('label.slds-form-element__label')?.textContent ||
      root.getAttribute('aria-label') ||
      root.getAttribute('title') ||
      ''
    );
    const readValue = (root, button) => {
      const buttonValue = normalize(
        button?.querySelector('.slds-truncate')?.textContent ||
        button?.getAttribute('data-selected-option-value') ||
        button?.textContent ||
        ''
      );
      const rootValue = normalize(
        root.getAttribute('data-selected-option-value') ||
        root.querySelector('[data-selected-option-value]')?.getAttribute('data-selected-option-value') ||
        ''
      );
      const selectedTokens = [...root.querySelectorAll(
        '#listbox-selections-unique-id .slds-pill__label, [role="listbox"] .slds-pill__label'
      )]
        .map((node) => normalize(node.textContent || ''))
        .filter(Boolean)
        .join(', ');
      const announcementValue = normalize(
        (
          root.querySelector('.slds-assistive-text[id^="filter-announcement-"]')?.textContent ||
          ''
        ).replace(/^filter set to\\s+/i, '')
      );
      if (buttonValue && buttonValue.toLowerCase() !== 'select an option') {
        return buttonValue;
      }
      if (rootValue) return rootValue;
      if (selectedTokens) return selectedTokens;
      if (announcementValue) return announcementValue;
      return buttonValue;
    };
    const deadline = Date.now() + 10000;
    let currentValue = '';
    while (Date.now() < deadline) {
      const roots = [...doc.querySelectorAll('.filterGrid .filterPanel, .filterPanel, .picklistContainer, .slds-form-element.picklist')]
        .filter((node, index, all) => all.indexOf(node) === index && isVisible(node));
      const root = roots.find((entry) => matches(readLabel(entry), targetFilter) || equals(readLabel(entry), targetFilter)) || null;
      if (!root) {
        return { ok: false, reason: 'classic dashboard filter disappeared: ' + targetFilter };
      }
      const button = root.querySelector('button.slds-picklist__label, button');
      currentValue = readValue(root, button);
      if (matches(currentValue, expected) || equals(currentValue, expected)) {
        return {
          ok: true,
          observed: {
            currentLabel: currentValue,
            expected,
          },
        };
      }
      await sleep(250);
    }
    return {
      ok: false,
      reason:
        'classic dashboard filter does not show expected label "' + expected + '" (saw "' +
        currentValue + '")',
      observed: {
        currentLabel: currentValue,
        expected,
      },
    };
  })()`;
}

function normalizedIncludes(value: string | null | undefined, needle: string): boolean {
  return (value ?? "").trim().toLowerCase().includes(needle.trim().toLowerCase());
}

function isIgnorableClassicDashboardToast(text: string): boolean {
  return IGNORABLE_CLASSIC_DASHBOARD_TOAST_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
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

async function applyClassicDashboardFilterOption(
  session: CdpSession,
  filterLabel: string,
  optionLabel: string,
  expectedNewLabel: string,
): Promise<{
  beforeLabel: string;
  matchedOptionText: string;
  availableFilters: string[];
  availableOptions: string[];
  scanIframeSrc: string | null;
}> {
  const control = await evaluate<
    | {
        ok: true;
        surfaceDetected: true;
        x: number;
        y: number;
        label: string;
        beforeLabel: string;
        availableFilters: string[];
        scanIframeSrc: string | null;
      }
    | {
        ok: false;
        surfaceDetected: boolean;
        reason: string;
        availableFilters: string[];
        scanIframeSrc: string | null;
      }
  >(session, {
    expression: buildLocateClassicDashboardFilterControlScript(filterLabel),
    awaitPromise: false,
    returnByValue: true,
  });
  if (!control.ok) throw new Error(control.reason);
  if (normalizedIncludes(control.beforeLabel, expectedNewLabel)) {
    return {
      beforeLabel: control.beforeLabel,
      matchedOptionText: control.beforeLabel,
      availableFilters: control.availableFilters,
      availableOptions: [],
      scanIframeSrc: control.scanIframeSrc,
    };
  }

  await dispatchMouseClick(session, control.x, control.y);

  const optionDeadline = Date.now() + 5000;
  let option:
    | {
        ok: true;
        x: number;
        y: number;
        optionText: string;
        availableOptions: string[];
        scanIframeSrc: string | null;
      }
    | {
        ok: false;
        reason: string;
        availableOptions: string[];
        scanIframeSrc: string | null;
      } = {
    ok: false,
    reason: `classic dashboard option not found: ${optionLabel}`,
    availableOptions: [],
    scanIframeSrc: control.scanIframeSrc,
  };
  let reopened = false;
  while (Date.now() < optionDeadline) {
    option = await evaluate<
      | {
          ok: true;
          x: number;
          y: number;
          optionText: string;
          availableOptions: string[];
          scanIframeSrc: string | null;
        }
      | {
          ok: false;
          reason: string;
          availableOptions: string[];
          scanIframeSrc: string | null;
        }
    >(session, {
      expression: buildLocateClassicDashboardFilterOptionScript(
        filterLabel,
        optionLabel,
      ),
      awaitPromise: false,
      returnByValue: true,
    });
    if (option.ok) break;
    if (!reopened) {
      await dispatchMouseClick(session, control.x, control.y);
      reopened = true;
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
  return {
    beforeLabel: control.beforeLabel,
    matchedOptionText: option.optionText,
    availableFilters: control.availableFilters,
    availableOptions: option.availableOptions,
    scanIframeSrc: option.scanIframeSrc,
  };
}

async function runClassicDashboardDropdownVariant(
  session: CdpSession,
  invocation: AdapterInvocation,
  args: SetFilterDropdownArgs,
): Promise<AdapterResult> {
  const effectiveExpectedNewLabel =
    typeof args.expectedNewLabel === "string" && args.expectedNewLabel.trim().length > 0
      ? args.expectedNewLabel
      : args.optionLabel;
  const urlBefore = session.target.url;
  const rollback = async (): Promise<void> => {
    if (filterCapture.beforeLabel) {
      try {
        await applyClassicDashboardFilterOption(
          session,
          args.filterLabel,
          filterCapture.beforeLabel,
          filterCapture.beforeLabel,
        );
        return;
      } catch (_e) {
        /* fall through to page reload */
      }
    }
    try {
      await session.client.Page.navigate({ url: urlBefore });
    } catch (_e) {
      /* target may be gone */
    }
  };

  const filterCapture = {
    beforeLabel: "" as string | null,
    availableFilters: [] as string[],
    scanIframeSrc: null as string | null,
  };
  const optionCapture = {
    matchedText: "" as string,
    availableOptions: [] as string[],
  };

  const actionResult = await runAction({
    session,
    skipStability: true,
    expectDomExpression: buildVerifyClassicDashboardFilterScript(
      args.filterLabel,
      effectiveExpectedNewLabel,
    ),
    noToast: [],
    rollback,
    action: async () => {
      const applied = await applyClassicDashboardFilterOption(
        session,
        args.filterLabel,
        args.optionLabel,
        effectiveExpectedNewLabel,
      );
      filterCapture.beforeLabel = applied.beforeLabel;
      filterCapture.availableFilters = applied.availableFilters;
      filterCapture.scanIframeSrc = applied.scanIframeSrc;
      optionCapture.matchedText = applied.matchedOptionText;
      optionCapture.availableOptions = applied.availableOptions;
    },
  });

  const checks = [...actionResult.checks];
  const blockingToasts = actionResult.toasts.filter(
    (toast) =>
      (toast.kind === "error" || toast.kind === "warning") &&
      !isIgnorableClassicDashboardToast(toast.text),
  );
  const ignoredToasts = actionResult.toasts.filter(
    (toast) =>
      (toast.kind === "error" || toast.kind === "warning") &&
      isIgnorableClassicDashboardToast(toast.text),
  );
  let rolledBack = actionResult.rolledBack;
  if (ignoredToasts.length > 0) {
    checks.push({
      name: "classic-dashboard-toast-filter",
      status: "passed",
      detail: `ignored ${ignoredToasts.length} known dashboard refresh toast${ignoredToasts.length === 1 ? "" : "s"}`,
    });
  }
  if (blockingToasts.length > 0) {
    checks.push({
      name: "classic-dashboard-toast-filter",
      status: "failed",
      detail: `${blockingToasts.length} blocked toasts: ${blockingToasts.map((toast) => `[${toast.kind}] ${toast.text}`).join("; ")}`,
    });
    if (!rolledBack) {
      try {
        await rollback();
        rolledBack = true;
      } catch (error) {
        checks.push({
          name: "rollback",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const ok =
    actionResult.ok &&
    checks.every((check) => check.status === "passed" || check.status === "skipped");
  const status: AdapterResult["status"] = ok ? "success" : "failed";
  const summary = ok
    ? `set-filter[classic-dashboard] "${args.filterLabel}" → "${args.optionLabel}" → verified "${effectiveExpectedNewLabel}" in ${actionResult.durationMs}ms`
    : `set-filter[classic-dashboard] failed: ${checks
        .filter((c) => c.status === "failed")
        .map((c) => `${c.name}: ${c.detail ?? ""}`)
        .join("; ")}`;

  return buildResult({
    invocation,
    status,
    summary,
    observedState: {
      variant: "dropdown",
      surface: "classic-dashboard",
      targetId: session.target.id,
      helperInstalled: session.helperInstalled,
      filterLabel: args.filterLabel,
      optionLabel: args.optionLabel,
      expectedNewLabel: effectiveExpectedNewLabel,
      beforeLabel: filterCapture.beforeLabel,
      matchedOptionText: optionCapture.matchedText,
      availableFilters: filterCapture.availableFilters,
      availableOptions: optionCapture.availableOptions,
      scanIframeSrc: filterCapture.scanIframeSrc,
      checks,
      toasts: actionResult.toasts,
      rolledBack,
      durationMs: actionResult.durationMs,
    },
    sideEffects: [
      {
        class: "shared_write",
        target: urlBefore,
        summary: `set classic dashboard filter "${args.filterLabel}" to "${args.optionLabel}"`,
      },
    ],
    verification: {
      status: ok ? "passed" : "failed",
      checks: ["policy", "trace_grade"],
    },
    suggestedNextActions: ok
      ? []
      : [
          `confirm dashboard filter "${args.filterLabel}" exposes option "${args.optionLabel}" on the live page`,
          rolledBack
            ? "rollback navigation completed — investigate the failed checks"
            : "no rollback performed — manual recovery may be needed",
        ],
  });
}

// ---- Click variant (v0.6, unchanged behavior) ----

async function runClickVariant(
  invocation: AdapterInvocation,
  args: SetFilterClickArgs,
): Promise<AdapterResult> {
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
    const urlBefore = session.target.url;
    const expectedNewLabel = args.expectedNewLabel as string;
    const networkRegex = new RegExp(
      args.networkUrlRegex ?? DEFAULT_NETWORK_REGEX,
    );
    const networkMatcher: NetworkMatcher = {
      urlRegex: networkRegex,
      statusPredicate: () => true,
      acceptLoadingFailed: true,
    };

    const clickResult = { beforeLabel: "" as string | null };
    const result = await runAction({
      session,
      expectNetwork: networkMatcher,
      networkTimeoutMs: 5000,
      expectStable: { quietMs: 300, timeoutMs: 5000 },
      expectDomExpression: buildVerifyScript(
        args.filterLabel,
        expectedNewLabel,
      ),
      noToast: ["error", "warning"],
      rollback: async () => {
        try {
          await session!.client.Page.navigate({ url: urlBefore });
        } catch (_e) {
          /* target may be gone */
        }
      },
      action: async () => {
        const out = await evaluate<
          { ok: true; beforeLabel: string } | { ok: false; reason: string }
        >(session!, {
          expression: buildClickScript(args.filterLabel),
          awaitPromise: false,
          returnByValue: true,
        });
        if (!out.ok) throw new Error(out.reason);
        clickResult.beforeLabel = out.beforeLabel;
      },
    });

    const status: AdapterResult["status"] = result.ok ? "success" : "failed";

    const summary = result.ok
      ? `set-filter "${args.filterLabel}" → "${expectedNewLabel}" verified in ${result.durationMs}ms`
      : `set-filter failed: ${result.checks
          .filter((c) => c.status === "failed")
          .map((c) => `${c.name}: ${c.detail ?? ""}`)
          .join("; ")}`;

    return buildResult({
      invocation,
      status,
      summary,
      observedState: {
        variant: "click",
        targetId: session.target.id,
        helperInstalled: session.helperInstalled,
        filterLabel: args.filterLabel,
        expectedNewLabel,
        beforeLabel: clickResult.beforeLabel,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        network: result.network,
      },
      sideEffects: [
        {
          class: "shared_write",
          target: urlBefore,
          summary: `click filter pill "${args.filterLabel}" to set to "${expectedNewLabel}"`,
        },
      ],
      verification: {
        status: result.ok ? "passed" : "failed",
        checks: ["policy", "trace_grade"],
      },
      suggestedNextActions: result.ok
        ? []
        : [
            result.rolledBack
              ? "rollback navigation completed — investigate the failed checks"
              : "no rollback performed — manual recovery may be needed",
          ],
    });
  } finally {
    await session.close();
  }
}

// ---- Dropdown variant (v0.7) ----

type StepTag = "stepA" | "stepB" | "stepC";

function tagChecks(step: StepTag, checks: ActionCheck[]): ActionCheck[] {
  return checks.map((c) => ({ ...c, name: `${step}.${c.name}` }));
}

async function runDropdownVariant(
  invocation: AdapterInvocation,
  args: SetFilterDropdownArgs,
): Promise<AdapterResult> {
  if (typeof args.optionLabel !== "string" || !args.optionLabel) {
    return failedResult(
      invocation,
      new Error(
        "set-filter variant=dropdown requires `arguments.optionLabel` (non-empty string)",
      ),
    );
  }
  const effectiveExpectedNewLabel =
    typeof args.expectedNewLabel === "string" && args.expectedNewLabel.trim().length > 0
      ? args.expectedNewLabel
      : args.optionLabel;

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
      /* keep going on targets that reject bringToFront */
    }

    const classicProbe = await evaluate<
      | {
          ok: true;
          surfaceDetected: true;
          x: number;
          y: number;
          label: string;
          beforeLabel: string;
          availableFilters: string[];
          scanIframeSrc: string | null;
        }
      | {
          ok: false;
          surfaceDetected: boolean;
          reason: string;
          availableFilters: string[];
          scanIframeSrc: string | null;
        }
    >(session, {
      expression: buildLocateClassicDashboardFilterControlScript(args.filterLabel),
      awaitPromise: false,
      returnByValue: true,
    });
    if (classicProbe.surfaceDetected) {
      return await runClassicDashboardDropdownVariant(
        session,
        invocation,
        args,
      );
    }

    const urlBefore = session.target.url;
    const networkRegex = new RegExp(
      args.networkUrlRegex ?? DEFAULT_NETWORK_REGEX,
    );
    const networkMatcher: NetworkMatcher = {
      urlRegex: networkRegex,
      statusPredicate: () => true,
      acceptLoadingFailed: true,
    };
    const applyButtonRegexSource = args.applyButtonText
      ? args.applyButtonText
      : DEFAULT_APPLY_BUTTON_REGEX;

    const rollback = async (): Promise<void> => {
      try {
        await session!.client.Page.navigate({ url: urlBefore });
      } catch (_e) {
        /* target may be gone */
      }
    };

    const clickPillCapture = { beforeLabel: "" as string | null };
    const optionCapture = { matchedText: "" as string };
    const applyCapture = { via: "" as string };

    // --- Step A: open dropdown by clicking the pill ---
    const stepA = await runAction({
      session,
      // no expectNetwork — clicking the pill usually doesn't hit the server
      expectStable: { quietMs: 200, timeoutMs: 3000 },
      expectDomExpression: buildDropdownVisibleScript(),
      noToast: ["error", "warning"],
      // no rollback at this step — rollback happens at the end if step C fails
      action: async () => {
        const out = await evaluate<
          { ok: true; beforeLabel: string } | { ok: false; reason: string }
        >(session!, {
          expression: buildClickScript(args.filterLabel),
          awaitPromise: false,
          returnByValue: true,
        });
        if (!out.ok) throw new Error(out.reason);
        clickPillCapture.beforeLabel = out.beforeLabel;
      },
    });

    // --- Step B: click the option row ---
    let stepB: ActionLoopResult | null = null;
    if (stepA.ok) {
      stepB = await runAction({
        session,
        expectStable: { quietMs: 200, timeoutMs: 3000 },
        expectDomExpression: buildOptionSelectedScript(args.optionLabel),
        noToast: ["error", "warning"],
        action: async () => {
          const out = await evaluate<
            { ok: true; matchedText: string } | { ok: false; reason: string }
          >(session!, {
            expression: buildClickOptionScript(args.optionLabel),
            awaitPromise: false,
            returnByValue: true,
          });
          if (!out.ok) throw new Error(out.reason);
          optionCapture.matchedText = out.matchedText;
        },
      });
    }

    // --- Step C: click apply + verify pill label ---
    let stepC: ActionLoopResult | null = null;
    if (stepA.ok && stepB && stepB.ok) {
      stepC = await runAction({
        session,
        expectNetwork: networkMatcher,
        networkTimeoutMs: 8000,
        expectStable: { quietMs: 500, timeoutMs: 8000 },
        expectDomExpression: buildVerifyScript(
          args.filterLabel,
          effectiveExpectedNewLabel,
        ),
        noToast: ["error", "warning"],
        rollback,
        action: async () => {
          const out = await evaluate<
            | { ok: true; via: string; text?: string }
            | { ok: false; reason: string }
          >(session!, {
            expression: buildClickApplyScript(applyButtonRegexSource),
            awaitPromise: false,
            returnByValue: true,
          });
          if (!out.ok) throw new Error(out.reason);
          applyCapture.via = out.via;
        },
      });
    }

    // Merge checks from all three steps (tagged by step name).
    const mergedChecks: ActionCheck[] = [
      ...tagChecks("stepA", stepA.checks),
      ...(stepB ? tagChecks("stepB", stepB.checks) : []),
      ...(stepC ? tagChecks("stepC", stepC.checks) : []),
    ];

    const allOk =
      stepA.ok && stepB !== null && stepB.ok && stepC !== null && stepC.ok;

    // If step A or B failed, we didn't pass a rollback to runAction for those
    // steps — but the user's contract says rollback on any failure in the
    // overall flow. Run it manually here if the dropdown/option step broke
    // and step C never got a chance to roll back itself.
    let manualRolledBack = false;
    if (!allOk && (stepC === null || !stepC.rolledBack)) {
      try {
        await rollback();
        manualRolledBack = true;
      } catch (_e) {
        /* best effort */
      }
    }

    const status: AdapterResult["status"] = allOk ? "success" : "failed";

    // Figure out which step caused the failure for the summary + next actions.
    let failedAt: StepTag | null = null;
    if (!stepA.ok) failedAt = "stepA";
    else if (!stepB || !stepB.ok) failedAt = "stepB";
    else if (!stepC || !stepC.ok) failedAt = "stepC";

    const totalDurationMs =
      stepA.durationMs +
      (stepB ? stepB.durationMs : 0) +
      (stepC ? stepC.durationMs : 0);

    const summary = allOk
      ? `set-filter[dropdown] "${args.filterLabel}" → "${args.optionLabel}" → verified "${effectiveExpectedNewLabel}" in ${totalDurationMs}ms (apply via ${applyCapture.via})`
      : `set-filter[dropdown] failed at ${failedAt}: ${mergedChecks
          .filter((c) => c.status === "failed")
          .map((c) => `${c.name}: ${c.detail ?? ""}`)
          .join("; ")}`;

    const mergedToasts = [
      ...stepA.toasts,
      ...(stepB ? stepB.toasts : []),
      ...(stepC ? stepC.toasts : []),
    ];

    const rolledBack = manualRolledBack || (stepC !== null && stepC.rolledBack);

    const observedState: Record<string, unknown> = {
      variant: "dropdown",
      targetId: session.target.id,
      helperInstalled: session.helperInstalled,
      filterLabel: args.filterLabel,
      optionLabel: args.optionLabel,
      expectedNewLabel: effectiveExpectedNewLabel,
      beforeLabel: clickPillCapture.beforeLabel,
      matchedOptionText: optionCapture.matchedText,
      applyVia: applyCapture.via,
      checks: mergedChecks,
      toasts: mergedToasts,
      rolledBack,
      durationMs: totalDurationMs,
      stepA: {
        ok: stepA.ok,
        durationMs: stepA.durationMs,
        rolledBack: stepA.rolledBack,
      },
      stepB: stepB
        ? {
            ok: stepB.ok,
            durationMs: stepB.durationMs,
            rolledBack: stepB.rolledBack,
          }
        : { ok: false, skipped: true },
      stepC: stepC
        ? {
            ok: stepC.ok,
            durationMs: stepC.durationMs,
            rolledBack: stepC.rolledBack,
          }
        : { ok: false, skipped: true },
    };
    if (stepC && stepC.network !== undefined) {
      observedState.network = stepC.network;
    }
    if (failedAt) {
      observedState.failedAt = failedAt;
    }

    const nextActions: string[] = [];
    if (!allOk) {
      if (failedAt === "stepA") {
        nextActions.push(
          "check the filter pill exists and is clickable (stepA failed to open the dropdown)",
        );
      } else if (failedAt === "stepB") {
        nextActions.push(
          `check the option label matches — "${args.optionLabel}" was not found or not selected in the open dropdown`,
        );
      } else if (failedAt === "stepC") {
        nextActions.push(
          `check the apply button text (regex "${applyButtonRegexSource}") or the expected filter label "${effectiveExpectedNewLabel}"`,
        );
      }
      nextActions.push(
        rolledBack
          ? "rollback navigation completed — investigate the failed checks"
          : "no rollback performed — manual recovery may be needed",
      );
    }

    return buildResult({
      invocation,
      status,
      summary,
      observedState,
      sideEffects: [
        {
          class: "shared_write",
          target: urlBefore,
          summary: `open filter pill "${args.filterLabel}" dropdown, pick "${args.optionLabel}", apply to set "${effectiveExpectedNewLabel}"`,
        },
      ],
      verification: {
        status: allOk ? "passed" : "failed",
        checks: ["policy", "trace_grade"],
      },
      suggestedNextActions: nextActions,
    });
  } finally {
    await session.close();
  }
}

// ---- Shared attach-opts builder ----

function buildAttachOpts(args: SetFilterBaseArgs): CdpAttachOptions {
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

// ---- Top-level dispatcher ----

export async function setFilterCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as SetFilterArgs;
  if (typeof args.filterLabel !== "string" || !args.filterLabel) {
    return failedResult(
      invocation,
      new Error(
        "set-filter requires `arguments.filterLabel` (non-empty string)",
      ),
    );
  }

  const variant: SetFilterVariant = args.variant ?? "click";
  if (
    variant === "click" &&
    (typeof args.expectedNewLabel !== "string" || !args.expectedNewLabel)
  ) {
    return failedResult(
      invocation,
      new Error(
        "set-filter variant=click requires `arguments.expectedNewLabel` (non-empty string)",
      ),
    );
  }
  if (variant === "dropdown") {
    return runDropdownVariant(invocation, args as SetFilterDropdownArgs);
  }
  if (variant === "click") {
    return runClickVariant(invocation, args as SetFilterClickArgs);
  }
  return failedResult(
    invocation,
    new Error(
      `set-filter unknown variant "${String(
        variant,
      )}" (expected "click" or "dropdown")`,
    ),
  );
}
