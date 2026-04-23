import {
  attach,
  evaluate,
  type CdpAttachOptions,
  type CdpSession,
} from "../../browser/cdp.ts";
import {
  DASHBOARD_WALKER_SRC,
  type DashboardFilter,
  type DashboardModel,
} from "../lightning.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface ListFiltersArgs extends CdpAttachOptions {
  urlHint?: string;
}

const DEFAULT_URL_MATCH = /salesforce|lightning|force\.com/i;
const MAX_FILTER_OPTIONS = 200;

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
        reason: 'classic dashboard iframe not available',
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
    const match =
      entries.find((entry) => matches(entry.label, target) || equals(entry.label, target)) ||
      null;
    if (!match || !match.button || !isVisible(match.button)) {
      return {
        ok: false,
        reason: 'classic dashboard filter control not found: ' + target,
      };
    }
    const frameRect = frame.getBoundingClientRect();
    const rect = match.button.getBoundingClientRect();
    return {
      ok: true,
      x: frameRect.left + rect.left + rect.width / 2,
      y: frameRect.top + rect.top + rect.height / 2,
      label: match.label || target,
      value: match.value,
    };
  })()`;
}

function buildReadOpenClassicDashboardFilterOptionsScript(
  filterLabel: string,
  maxOptions: number,
): string {
  const labelJson = JSON.stringify(filterLabel);
  return `(async () => {
    const target = ${labelJson};
    const maxOptions = ${maxOptions};
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
    const roots = [...doc.querySelectorAll('.filterGrid .filterPanel, .filterPanel, .picklistContainer, .slds-form-element.picklist')]
      .filter((node, index, all) => all.indexOf(node) === index && isVisible(node));
    const root =
      roots.find((entry) => matches(readLabel(entry), target) || equals(readLabel(entry), target)) ||
      null;
    if (!root) {
      return { ok: false, reason: 'classic dashboard filter root not found: ' + target };
    }
    const button = root.querySelector('button.slds-picklist__label, button');
    const findOpenDropdowns = () => {
      const dropdowns = [];
      const isOptionContainer = (node) => {
        if (!node || !isVisible(node)) return false;
        if (node.id === 'listbox-selections-unique-id') return false;
        const ariaLabel = normalize(node.getAttribute?.('aria-label') || '');
        return ariaLabel !== 'selected options:';
      };
      const push = (node) => {
        if (!isOptionContainer(node) || dropdowns.indexOf(node) !== -1) return;
        dropdowns.push(node);
      };
      for (const node of root.querySelectorAll('.slds-picklist.slds-is-open .slds-dropdown, .slds-dropdown[role="menu"], .slds-dropdown, [role="listbox"], [role="menu"]')) {
        push(node);
      }
      const openPicklist = root.querySelector('.slds-picklist.slds-is-open');
      if (openPicklist) {
        for (const node of openPicklist.querySelectorAll('.slds-dropdown, [role="listbox"], [role="menu"]')) {
          push(node);
        }
      }
      return dropdowns;
    };
    const deadline = Date.now() + 4000;
    let dropdowns = [];
    let reopened = false;
    while (Date.now() < deadline) {
      dropdowns = findOpenDropdowns();
      if (dropdowns.length > 0) break;
      if (!reopened && button) {
        reopened = true;
        try { button.click(); } catch (_e) { /* non-fatal */ }
      }
      await sleep(150);
    }
    if (dropdowns.length === 0) {
      return {
        ok: false,
        reason: 'classic dashboard filter dropdown did not open: ' + target,
      };
    }
    const seen = new Set();
    const allOptions = [];
    let selectedOption = null;
    for (const dropdown of dropdowns) {
      for (const candidate of dropdown.querySelectorAll(
        'li.slds-dropdown__item, li.slds-listbox__item, [role="menuitemcheckbox"], [role="menuitem"], [role="option"], a, button, .slds-listbox__option'
      )) {
        const text = normalize(candidate.textContent || '');
        if (!text) continue;
        const key = text.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          allOptions.push(text);
        }
        const selectionNode =
          candidate.closest &&
          candidate.closest('li.slds-dropdown__item, li.slds-listbox__item, [role="menuitemcheckbox"], [role="menuitem"], [role="option"]');
        if (
          selectedOption === null &&
          (
            candidate.getAttribute('aria-checked') === 'true' ||
            candidate.getAttribute('aria-selected') === 'true' ||
            selectionNode?.getAttribute('aria-checked') === 'true' ||
            selectionNode?.getAttribute('aria-selected') === 'true' ||
            /(^|\\s)(is-active|selected|slds-is-selected)(\\s|$)/.test(
              typeof candidate.className === 'string' ? candidate.className : ''
            ) ||
            /(^|\\s)(is-active|selected|slds-is-selected)(\\s|$)/.test(
              typeof selectionNode?.className === 'string' ? selectionNode.className : ''
            )
          )
        ) {
          selectedOption = text;
        }
      }
    }
    const currentValue = readValue(root, button);
    return {
      ok: true,
      currentValue,
      selectedOption,
      optionCount: allOptions.length,
      options: allOptions.slice(0, maxOptions),
      optionsTruncated: allOptions.length > maxOptions,
    };
  })()`;
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

async function dispatchEscape(session: CdpSession): Promise<void> {
  await session.client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await session.client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

async function enrichClassicDashboardFiltersWithOptions(
  session: CdpSession,
  filters: DashboardFilter[],
): Promise<{
  filters: DashboardFilter[];
  inspectionErrors: string[];
}> {
  const enriched: DashboardFilter[] = [];
  const inspectionErrors: string[] = [];

  for (const filter of filters) {
    if (typeof filter.label !== "string" || filter.label.trim().length === 0) {
      enriched.push(filter);
      continue;
    }
    try {
      const control = await evaluate<
        | { ok: true; x: number; y: number; label: string; value: string }
        | { ok: false; reason: string }
      >(session, {
        expression: buildLocateClassicDashboardFilterControlScript(filter.label),
        awaitPromise: false,
        returnByValue: true,
      });
      if (!control.ok) {
        inspectionErrors.push(`${filter.label}: ${control.reason}`);
        enriched.push(filter);
        continue;
      }

      await dispatchMouseClick(session, control.x, control.y);
      const options = await evaluate<
        | {
            ok: true;
            currentValue: string;
            selectedOption: string | null;
            optionCount: number;
            options: string[];
            optionsTruncated: boolean;
          }
        | { ok: false; reason: string }
      >(session, {
        expression: buildReadOpenClassicDashboardFilterOptionsScript(
          filter.label,
          MAX_FILTER_OPTIONS,
        ),
        awaitPromise: true,
        returnByValue: true,
      });
      await dispatchEscape(session);
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (!options.ok) {
        inspectionErrors.push(`${filter.label}: ${options.reason}`);
        enriched.push(filter);
        continue;
      }

      enriched.push({
        ...filter,
        value: options.currentValue || filter.value,
        optionCount: options.optionCount,
        options: options.options,
        optionsTruncated: options.optionsTruncated,
      });
    } catch (error) {
      inspectionErrors.push(
        `${filter.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await dispatchEscape(session);
      } catch {
        /* best effort */
      }
      enriched.push(filter);
    }
  }

  return { filters: enriched, inspectionErrors };
}

export async function listFiltersCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as ListFiltersArgs;

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
      /* some targets reject bringToFront */
    }

    const model = await evaluate<DashboardModel>(session, {
      expression: DASHBOARD_WALKER_SRC,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });

    if (!model.detected) {
      return buildResult({
        invocation,
        status: "partial",
        summary: `no dashboard detected at ${session.target.url}: ${model.reason ?? "unknown"}`,
        observedState: {
          targetId: session.target.id,
          helperInstalled: session.helperInstalled,
          dashboard: model,
          filters: [],
          filterCount: 0,
        },
        artifacts: [
          {
            kind: "url",
            ref: session.target.url,
            note: `${model.kind} page (no dashboard)`,
          },
        ],
        verification: { status: "not_run", checks: [] },
        suggestedNextActions: [
          "open a Salesforce dashboard tab and retry",
          "or pass { urlHint: '...' } to target a specific tab",
        ],
      });
    }

    let filters = model.filters;
    let inspectionErrors: string[] = [];
    if (model.kind === "classic" && model.filterCount > 0) {
      const enriched = await enrichClassicDashboardFiltersWithOptions(
        session,
        model.filters,
      );
      filters = enriched.filters;
      inspectionErrors = enriched.inspectionErrors;
    }

    const summary =
      model.filterCount === 0
        ? `listed 0 filters on ${model.kind} dashboard "${model.title ?? "(untitled)"}"`
        : `listed ${model.filterCount} filter${model.filterCount === 1 ? "" : "s"} on ${model.kind} dashboard "${model.title ?? "(untitled)"}"`;

    return buildResult({
      invocation,
      status: "success",
      summary,
      observedState: {
        targetId: session.target.id,
        helperInstalled: session.helperInstalled,
        dashboard: {
          kind: model.kind,
          title: model.title,
          url: model.url,
          path: model.path,
        },
        filters,
        filterCount: model.filterCount,
        optionInspectionErrors: inspectionErrors,
      },
      artifacts: [
        {
          kind: "url",
          ref: session.target.url,
          note: `${model.kind} dashboard filters`,
        },
      ],
      verification: {
        status: "passed",
        checks: ["artifact_schema", "trace_grade"],
      },
      suggestedNextActions:
        model.filterCount === 0
          ? ["confirm the dashboard is expected to have zero filters"]
          : inspectionErrors.length > 0
            ? ["some filter option inventories could not be read; inspect optionInspectionErrors in observedState"]
            : [],
    });
  } finally {
    await session.close();
  }
}
