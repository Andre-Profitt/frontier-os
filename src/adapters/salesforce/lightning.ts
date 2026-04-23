// Salesforce Lightning page-model extraction.
//
// The dashboard walker runs page-side via Runtime.evaluate (through
// run-script's async wrapper semantics — inner expression is awaited).
// It is deliberately targeted rather than generic: we know the tag names
// Salesforce uses on Lightning dashboards and walk those directly instead
// of capturing the entire DOM.
//
// Per the research dossier:
//   - Dashboard view pages are Aura + light DOM (not LWC shadow) — easier.
//   - CRMA (Wave) dashboards have stable `data-widget-id` that map to the
//     dashboard JSON — the single most automation-friendly surface in SF.
//   - Classic dashboards rendered in Lightning Experience have
//     `data-component-id` on widgets (Aura-era) and a known-broken save
//     button that we never touch in v0.
//
// This module does NOT import from the browser adapter directly to keep
// the compile-time coupling minimal — it just exports the page-side
// walker as a source string and a few small TS helpers.

export type DashboardKind = "classic" | "crma" | "lwc" | "unknown";

export interface DashboardWidget {
  /** data-widget-id (CRMA/Wave) or data-component-id (Classic Aura) or null. */
  id: string | null;
  /** Element tag name, lowercased. */
  tag: string;
  /** First heading/aria-label text inside the widget container. */
  title: string | null;
  /** Guessed visualization kind (chart|table|metric|other). */
  kind: "chart" | "table" | "metric" | "other";
  /** Bounding rect in CSS pixels. */
  rect: { x: number; y: number; w: number; h: number };
  /** True if the widget has zero width or zero height. */
  hidden: boolean;
  /** True if an active spinner was found inside the widget. */
  loading: boolean;
  /** First error/alert text inside the widget, if any. */
  errorText: string | null;
}

export interface DashboardFilter {
  /** aria-label, or visible pill text. */
  label: string | null;
  /** Currently-selected value(s) when discoverable. */
  value: string | null;
  /** True if the filter pill is rendered with non-zero size. */
  visible: boolean;
  /** Best-effort list of available option labels when interactively discoverable. */
  options?: string[];
  /** Total available option count before any truncation. */
  optionCount?: number | null;
  /** True when `options` is a capped preview rather than the full option set. */
  optionsTruncated?: boolean;
}

export interface DashboardModel {
  detected: boolean;
  /** When detected=false, explains why. */
  reason?: string;
  kind: DashboardKind;
  url: string;
  path: string;
  title: string | null;
  /** aura presence + idle state from the base __frontier helper. */
  aura: { detected: boolean; idle: boolean };
  widgetCount: number;
  filterCount: number;
  widgets: DashboardWidget[];
  filters: DashboardFilter[];
  /** Visible error banners / toast text at the page level. */
  pageErrors: string[];
  /** The container tag we matched on (helps diagnose walker misses). */
  containerTag: string | null;
  /**
   * When the walker descended into a same-origin iframe (e.g. the classic
   * desktopDashboards/dashboardApp.app frame), this holds the iframe's src
   * URL. Null when the dashboard was found at the top-level document.
   */
  scanIframeSrc?: string | null;
  /**
   * Server-side enrichment: widgetId → underlying report freshness. Populated
   * by the audit command after the walker runs, when a Salesforce access
   * token is available. Absent when enrichment was skipped; value may be an
   * empty map when the dashboard describe returned no components.
   */
  widgetReports?: Record<
    string,
    {
      widgetId: string;
      reportId: string | null;
      reportName: string | null;
      lastRunDate: string | null;
      lastModifiedDate: string | null;
    }
  >;
  /**
   * Per-audit override of the "days since LastRunDate" threshold at which
   * the report-stale rule fires. Defaults to 30. Audit command forwards
   * `arguments.reportStaleDays` into this field before rule evaluation.
   */
  reportStaleDays?: number;
}

export type ReportKind = "lightning" | "unknown";

export interface ReportFilter {
  /** Raw visible filter text from the panel. */
  rawText: string;
  /** Best-effort field / filter label when parseable. */
  label: string | null;
  /** Best-effort operator, e.g. "equals" or "not equal to". */
  operator: string | null;
  /** Best-effort filter value when parseable. */
  value: string | null;
  /** True when the filter control is currently visible. */
  visible: boolean;
  /** True when the UI exposes edit affordance in the captured control text. */
  editable: boolean;
  /** True when a sibling remove-filter control was found. */
  removable: boolean;
}

export interface ReportAction {
  /** Stable internal action key. */
  key: string;
  /** Human-readable button label. */
  label: string;
  /** True when the button is currently visible. */
  visible: boolean;
  /** True when the control is not disabled / aria-disabled. */
  enabled: boolean;
  /** True when the control looks selected/toggled on. */
  selected: boolean;
}

export interface ReportModel {
  detected: boolean;
  /** When detected=false, explains why. */
  reason?: string;
  kind: ReportKind;
  url: string;
  path: string;
  /** Outer Lightning page title without the "| Salesforce" suffix. */
  title: string | null;
  /** First h1 text inside the report iframe. */
  headerText: string | null;
  /** Best-effort report-type prefix parsed from the header. */
  reportTypeLabel: string | null;
  /** aura presence + idle state from the base __frontier helper. */
  aura: { detected: boolean; idle: boolean };
  loading: boolean;
  filterCount: number;
  filters: ReportFilter[];
  actionCount: number;
  actions: ReportAction[];
  /** Null when the report offers no chart toggle and no chart was detected. */
  chartVisible: boolean | null;
  /** Visible error banners / toast text at the page or frame level. */
  pageErrors: string[];
  /** The container tag we matched on (helps diagnose walker misses). */
  containerTag: string | null;
  /** Same-origin report iframe URL when we scanned inside the frame. */
  scanIframeSrc?: string | null;
}

export function detectDashboardKindFromUrl(url: string): DashboardKind {
  if (!url) return "unknown";
  if (/\/analytics\/wave\//.test(url)) return "crma";
  if (/\/lightning\/r\/Dashboard\//.test(url)) return "classic";
  if (/\/one\/one\.app.*Dashboard/i.test(url)) return "classic";
  return "unknown";
}

/**
 * Page-side walker source.
 *
 * Exported as a plain string so it can be passed to run-script's async
 * wrapper (`await (${expression})`) or to Runtime.evaluate directly.
 * The walker returns a Promise<DashboardModel> — it awaits the base
 * helper's waitStable before capturing when the helper is present.
 *
 * Keep this self-contained: no external function refs, no TS.
 */
export const DASHBOARD_WALKER_SRC = /* js */ `
(async () => {
  const CONTAINER_SELECTORS = [
    'analytics-dashboard-container',
    'wave-dashboard-runtime',
    'wave-dashboard-container',
    // Classic Lightning dashboards render in a same-origin iframe
    // (desktopDashboards/dashboardApp.app). Their root container is a plain
    // div with these Aura-era class names — neither an Aura data attribute
    // nor a custom tag, so we match on class directly.
    '.dashboardGridLayout',
    '.filteredDashboard',
    '[data-aura-class*="Dashboard"]',
    '[data-aura-class*="waveDashboard"]',
  ];
  const WIDGET_SELECTORS = [
    'analytics-dashboard-widget',
    'wave-dashboard-widget',
    '[data-widget-id]',
    '[data-component-id][data-aura-class*="Widget"]',
    // Classic iframe dashboards: widgets are <div class="widget-container
    // widget-container_<widgetId>"> — no data-widget-id, ID lives in the
    // class name. We match the leading-class prefix and pull the id below.
    '[class*="widget-container_"]',
  ];
  const FILTER_SELECTORS = [
    'analytics-filter-pill',
    'wave-dashboard-filter-pill',
    '[role="listitem"][aria-label*="filter" i]',
    // Classic iframe filter pills (observed on real SF Lightning dashboards).
    '.filter-panel .filter-pill',
    '.dashboard-filters .filter',
    '.filterGrid .filterPanel',
    '.filterPanel',
    '.picklistContainer',
    '.slds-form-element.picklist',
  ];
  const ERROR_SELECTORS = [
    '[role="alert"]',
    '.slds-notify--error',
    '.forceActionsError',
    '.errorMessage',
  ];
  const LOADING_SELECTORS = [
    'lightning-spinner',
    '.slds-spinner',
    '[aria-busy="true"]',
    '.dashboardSpinner',
    'analytics-dashboard-spinner',
  ];

  const firstMatch = (root, selectors) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const allMatches = (root, selectors) => {
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      try {
        for (const el of root.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch (_e) { /* invalid selector on some browsers — skip */ }
    }
    return out;
  };
  const cleanText = (s) =>
    (s || '').replace(/\\s+/g, ' ').trim().slice(0, 240) || null;
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  };

  // Best-effort stability wait if the base __frontier helper is present.
  if (window.__frontier && typeof window.__frontier.waitStable === 'function') {
    try {
      await window.__frontier.waitStable({ quietMs: 500, timeoutMs: 8000 });
    } catch (_e) { /* non-fatal — continue with current state */ }
  }

  const url = location.href;
  const path = location.pathname + location.search;

  // Detect kind from URL first, then refine by what we actually see.
  let kind = 'unknown';
  if (/\\/analytics\\/wave\\//.test(url)) kind = 'crma';
  else if (/\\/lightning\\/r\\/Dashboard\\//.test(url)) kind = 'classic';

  // Classic Lightning dashboards live inside a same-origin iframe
  // (desktopDashboards/dashboardApp.app). We PREFER the iframe when it
  // exists and contains a dashboard container — the top-level document
  // can also match loose selectors like [data-aura-class*="Dashboard"]
  // which hit the Chatter feed sidebar and mask the real dashboard.
  let scanRoot = document;
  let scanIframeSrc = null;
  let container = null;
  const DASHBOARD_IFRAME_RE = /desktopDashboards\\/dashboardApp|\\/analytics\\/wave\\//;
  const iframes = document.querySelectorAll('iframe');
  for (const frame of iframes) {
    if (!DASHBOARD_IFRAME_RE.test(frame.src || '')) continue;
    let doc = null;
    try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
    if (!doc) continue;
    const inner = firstMatch(doc, CONTAINER_SELECTORS);
    if (inner) {
      scanRoot = doc;
      scanIframeSrc = frame.src || null;
      container = inner;
      break;
    }
  }
  if (!container) {
    container = firstMatch(document, CONTAINER_SELECTORS);
  }
  if (!container) {
    for (const frame of iframes) {
      if (DASHBOARD_IFRAME_RE.test(frame.src || '')) continue; // already tried
      let doc = null;
      try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
      if (!doc) continue;
      const inner = firstMatch(doc, CONTAINER_SELECTORS);
      if (inner) {
        scanRoot = doc;
        scanIframeSrc = frame.src || null;
        container = inner;
        break;
      }
    }
  }
  if (!container) {
    return {
      detected: false,
      reason: 'no dashboard container found (tried: ' + CONTAINER_SELECTORS.join(', ') + ')',
      kind,
      url,
      path,
      title: document.title || null,
      aura: {
        detected: !!window.$A,
        idle: !(window.$A && window.$A.clientService && typeof window.$A.clientService.inFlightXHRs === 'function')
              || window.$A.clientService.inFlightXHRs().length === 0,
      },
      widgetCount: 0,
      filterCount: 0,
      widgets: [],
      filters: [],
      pageErrors: [],
      containerTag: null,
    };
  }

  // Refine kind using the container tag when URL was ambiguous.
  const containerTag = container.tagName.toLowerCase();
  if (kind === 'unknown') {
    if (containerTag.startsWith('wave-')) kind = 'crma';
    else if (containerTag.startsWith('analytics-')) kind = 'classic';
  }

  // Title: try obvious dashboard title selectors against the scan root
  // (inside the iframe when we descended), fall back to the outer
  // document.title — which for classic iframe dashboards is the SF page
  // title ("<dashboard> | Salesforce"), useful as a last resort.
  const titleEl =
    scanRoot.querySelector('.dashboardTitle') ||
    scanRoot.querySelector('h1.slds-page-header__title') ||
    scanRoot.querySelector('h1.page-header__title') ||
    container.querySelector('h1') ||
    null;
  const title = titleEl ? cleanText(titleEl.textContent) : cleanText(document.title);

  const widgetEls = allMatches(container, WIDGET_SELECTORS).filter((el) => {
    // Drop classic positional wrappers ("widget-container_1/2/3/4") that
    // are grid rows, not actual widgets. Keep only elements with an SF id
    // (data attribute or 15/18-char class suffix) OR a data-widget-id /
    // data-component-id. analytics-*/wave-* tag selectors pass as-is.
    if (el.hasAttribute('data-widget-id') || el.hasAttribute('data-component-id')) {
      return true;
    }
    const tag = el.tagName.toLowerCase();
    if (tag.startsWith('analytics-') || tag.startsWith('wave-')) {
      return true;
    }
    for (const c of el.classList) {
      if (/^widget-container_[A-Za-z0-9]{15,18}$/.test(c)) return true;
    }
    return false;
  });
  const widgets = widgetEls.map((el) => {
    const rect = el.getBoundingClientRect();
    // Classic iframe widgets encode their ID in the class name
    // ("widget-container widget-container_<15- or 18-char SF id>"). Strict
    // 15/18 char SF-id length to reject positional wrappers like
    // "widget-container_1" that wrap grid rows, not widgets.
    let classId = null;
    for (const c of el.classList) {
      const m = /^widget-container_([A-Za-z0-9]{15,18})$/.exec(c);
      if (m) { classId = m[1]; break; }
    }
    const id =
      el.getAttribute('data-widget-id') ||
      el.getAttribute('data-component-id') ||
      classId ||
      null;
    const title =
      cleanText(
        (el.querySelector('h2, h3, .widget-title, .slds-text-heading_small')
          || {}).textContent
      ) ||
      cleanText(el.getAttribute('aria-label'));
    const tag = el.tagName.toLowerCase();

    // Guess visualization kind from the child tag mix.
    let guess = 'other';
    if (el.querySelector('svg, canvas, analytics-reportchart-widget, wave-chart')) {
      guess = 'chart';
    } else if (el.querySelector('table, .slds-table, analytics-reporttable-widget')) {
      guess = 'table';
    } else if (el.querySelector('.metric, analytics-metric-widget, .kpi')) {
      guess = 'metric';
    }

    const loading = LOADING_SELECTORS.some((s) => {
      const spinner = el.querySelector(s);
      if (!spinner) return false;
      const style = getComputedStyle(spinner);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const errorEl = firstMatch(el, ERROR_SELECTORS);
    return {
      id,
      tag,
      title,
      kind: guess,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      hidden: rect.width === 0 || rect.height === 0,
      loading,
      errorText: errorEl ? cleanText(errorEl.textContent) : null,
    };
  });

  const filterRoots = [];
  const seenFilterRoots = new Set();
  for (const el of allMatches(container, FILTER_SELECTORS)) {
    const root =
      (el.closest &&
        el.closest('.filterPanel, .picklistContainer, .slds-form-element.picklist')) ||
      el;
    if (!root || seenFilterRoots.has(root)) continue;
    seenFilterRoots.add(root);
    filterRoots.push(root);
  }
  const seenFilters = new Set();
  const filters = filterRoots
    .map((el) => {
      const button =
        el.querySelector &&
        el.querySelector('button.slds-picklist__label');
      const label =
        cleanText(
          (el.querySelector &&
            el.querySelector('label.slds-form-element__label, .filter-label, [class*="label"]') ||
            {}).textContent
        ) ||
        cleanText(el.getAttribute && el.getAttribute('aria-label')) ||
        cleanText(button && button.getAttribute && button.getAttribute('aria-label')) ||
        cleanText(
          (button &&
            button.querySelector &&
            button.querySelector('.slds-truncate') ||
            {}).textContent
        );
      const buttonValue = cleanText(
        button &&
        button.querySelector &&
        button.querySelector('.slds-truncate') &&
        button.querySelector('.slds-truncate').textContent
      );
      const rootValue =
        cleanText(el.getAttribute && el.getAttribute('data-selected-option-value')) ||
        cleanText(el.getAttribute && el.getAttribute('data-value'));
      const selectedTokens = cleanText(
        [...(el.querySelectorAll ? el.querySelectorAll(
          '#listbox-selections-unique-id .slds-pill__label, [role="listbox"] .slds-pill__label'
        ) : [])]
          .map((node) => node && node.textContent || '')
          .join(', ')
      );
      const assistiveValue = cleanText(
        (
          (el.querySelector &&
            el.querySelector('.slds-assistive-text[id^="filter-announcement-"]') ||
            {}).textContent ||
          ''
        ).replace(/^filter set to\\s+/i, '')
      );
      const value =
        (buttonValue && buttonValue.toLowerCase() !== 'select an option' ? buttonValue : '') ||
        rootValue ||
        selectedTokens ||
        assistiveValue ||
        buttonValue ||
        cleanText(
          (el.querySelector &&
            el.querySelector('.filter-value, [class*="value"]') ||
            {}).textContent
        );
      if (!label) return null;
      const dedupeKey = label.toLowerCase();
      if (seenFilters.has(dedupeKey)) return null;
      seenFilters.add(dedupeKey);
      return {
        label,
        value,
        visible: isVisible(button) || isVisible(el),
      };
    })
    .filter(Boolean);

  const pageErrorEls = allMatches(scanRoot, ERROR_SELECTORS);
  const pageErrors = pageErrorEls
    .map((el) => cleanText(el.textContent))
    .filter((s) => s !== null);

  return {
    detected: true,
    kind,
    url,
    path,
    title,
    aura: {
      detected: !!window.$A,
      idle: !(window.$A && window.$A.clientService && typeof window.$A.clientService.inFlightXHRs === 'function')
            || window.$A.clientService.inFlightXHRs().length === 0,
    },
    widgetCount: widgets.length,
    filterCount: filters.length,
    widgets,
    filters,
    pageErrors,
    containerTag,
    scanIframeSrc,
  };
})()
`;

/**
 * Page-side Lightning report walker source.
 *
 * Standard Lightning reports render inside a same-origin iframe
 * (`/reports/lightningReportApp.app`). We scan inside that iframe when
 * available and extract the report title, filter panel state, visible
 * actions, and obvious error/loading signals.
 */
export const REPORT_WALKER_SRC = /* js */ `
(async () => {
  const REPORT_IFRAME_RE = /\\/reports\\/lightningReportApp\\.app/i;
  const ROOT_SELECTORS = [
    '.reportBuilder',
    '.reportsLightningReportApp',
    '.reportPageHeader',
  ];
  const ERROR_SELECTORS = [
    '[role="alert"]',
    '.slds-notify--error',
    '.forceActionsError',
    '.errorMessage',
  ];
  const LOADING_SELECTORS = [
    'lightning-spinner',
    '.slds-spinner',
    '[aria-busy="true"]',
    '.forceModalSpinner',
  ];
  const FILTER_SELECTORS = [
    '.report-filter-panel button.slds-button_reset.slds-grow',
    '.reportFilterPanel button.slds-button_reset.slds-grow',
    '.filtersPanel button.slds-button_reset.slds-grow',
    'button.slds-button_reset.slds-grow.slds-has-blur-focus',
  ];
  const ACTION_SPECS = [
    {
      key: 'toggle_chart',
      fallbackLabel: 'Toggle Chart',
      selectors: [
        '.forceChartButton',
        '.action-bar-action-toggleChart',
        '.report-action-toggleChart',
      ],
    },
    {
      key: 'filters',
      fallbackLabel: 'Filters',
      selectors: [
        '.forceFilterButton',
        '.action-bar-action-toggleFilter',
        '.report-action-toggleFilter',
      ],
    },
    {
      key: 'refresh',
      fallbackLabel: 'Refresh',
      selectors: [
        '.forceRefreshButton',
        '.action-bar-action-refreshReport',
        '.report-action-refreshReport',
      ],
    },
    {
      key: 'settings',
      fallbackLabel: 'Settings',
      selectors: ['button[title="Settings"]'],
    },
    {
      key: 'edit',
      fallbackLabel: 'Edit',
      selectors: [
        '.action-bar-action-LightningReportEditAction',
        '.report-action-LightningReportEditAction',
      ],
    },
    {
      key: 'search_table',
      fallbackLabel: 'Search report table',
      selectors: [
        '.action-bar-action-searchTable',
        '.report-action-searchTable',
      ],
    },
    {
      key: 'add_chart',
      fallbackLabel: 'Add Chart',
      selectors: [
        '.action-bar-action-addChart',
        '.report-action-addChart',
      ],
    },
    {
      key: 'enable_field_editing',
      fallbackLabel: 'Enable Field Editing',
      selectors: [
        '.action-bar-action-inlineEditReport',
        '.report-action-inlineEditReport',
      ],
    },
  ];

  const firstMatch = (root, selectors) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const allMatches = (root, selectors) => {
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      try {
        for (const el of root.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch (_e) { /* invalid selector on some browsers — skip */ }
    }
    return out;
  };
  const cleanText = (value) =>
    (value || '').replace(/\\s+/g, ' ').trim().slice(0, 240) || null;
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  };
  const isSelected = (el) => {
    const className = typeof el.className === 'string'
      ? el.className
      : (el.getAttribute && el.getAttribute('class')) || '';
    return (
      el.getAttribute('aria-pressed') === 'true' ||
      /(^|\\s)(is-selected|slds-is-selected|selected)(\\s|$)/.test(className)
    );
  };
  const parseFilterText = (raw) => {
    const operators = [
      'greater than or equal to',
      'less than or equal to',
      'not equal to',
      'greater than',
      'less than',
      'starts with',
      'ends with',
      'contains',
      'excludes',
      'includes',
      'equals',
    ];
    const normalized = cleanText(raw);
    if (!normalized) {
      return { label: null, operator: null, value: null };
    }
    const lower = normalized.toLowerCase();
    for (const operator of operators) {
      const idx = lower.indexOf(operator);
      if (idx <= 0) continue;
      const label = cleanText(normalized.slice(0, idx));
      const value = cleanText(normalized.slice(idx + operator.length));
      return {
        label,
        operator,
        value,
      };
    }
    return { label: normalized, operator: null, value: null };
  };

  if (window.__frontier && typeof window.__frontier.waitStable === 'function') {
    try {
      await window.__frontier.waitStable({ quietMs: 500, timeoutMs: 8000 });
    } catch (_e) { /* non-fatal — continue with current state */ }
  }

  const url = location.href;
  const path = location.pathname + location.search;
  const outerTitle = cleanText(document.title);
  const title =
    outerTitle && /\\| Salesforce$/.test(outerTitle)
      ? cleanText(outerTitle.replace(/\\s*\\| Salesforce$/, ''))
      : outerTitle;

  let scanRoot = document;
  let scanIframeSrc = null;
  for (const frame of document.querySelectorAll('iframe')) {
    if (!REPORT_IFRAME_RE.test(frame.src || '')) continue;
    let doc = null;
    try { doc = frame.contentDocument; } catch (_e) { /* cross-origin */ }
    if (!doc) continue;
    scanRoot = doc;
    scanIframeSrc = frame.src || null;
    break;
  }

  const container = firstMatch(scanRoot, ROOT_SELECTORS) || scanRoot.body || null;
  const headerText = cleanText(
    (scanRoot.querySelector('h1') || {}).textContent,
  );
  const kind = scanIframeSrc || /\\/lightning\\/r\\/Report\\//.test(url)
    ? 'lightning'
    : 'unknown';
  if (!container) {
    return {
      detected: false,
      reason: 'no report container found (tried: ' + ROOT_SELECTORS.join(', ') + ')',
      kind,
      url,
      path,
      title,
      headerText,
      reportTypeLabel: null,
      aura: {
        detected: !!window.$A,
        idle: !(window.$A && window.$A.clientService && typeof window.$A.clientService.inFlightXHRs === 'function')
              || window.$A.clientService.inFlightXHRs().length === 0,
      },
      loading: false,
      filterCount: 0,
      filters: [],
      actionCount: 0,
      actions: [],
      chartVisible: null,
      pageErrors: [],
      containerTag: null,
      scanIframeSrc,
    };
  }

  let reportTypeLabel = null;
  if (headerText && title && headerText.endsWith(title) && headerText.length > title.length) {
    reportTypeLabel = cleanText(headerText.slice(0, headerText.length - title.length));
  }

  const filterButtons = allMatches(scanRoot, FILTER_SELECTORS).filter((el) =>
    container.contains(el),
  );
  const seenFilters = new Set();
  const filters = filterButtons
    .map((el) => {
      const rawText = cleanText(el.textContent);
      const normalized = rawText ? rawText.replace(/^Edit Filter/i, '').trim() : null;
      if (!normalized) return null;
      const dedupeKey = normalized.toLowerCase();
      if (seenFilters.has(dedupeKey)) return null;
      seenFilters.add(dedupeKey);
      const group =
        el.closest('li, .slds-media, .report-filter-item, .report-filter-panel__item') ||
        el.parentElement ||
        el;
      const parsed = parseFilterText(normalized);
      return {
        rawText: normalized,
        label: parsed.label,
        operator: parsed.operator,
        value: parsed.value,
        visible: isVisible(el),
        editable: /^Edit Filter/i.test(rawText || ''),
        removable: !!firstMatch(group, [
          'button[title^="Remove filter"]',
          'button[aria-label^="Remove filter"]',
        ]),
      };
    })
    .filter(Boolean);

  const actions = ACTION_SPECS
    .map((spec) => {
      const el = firstMatch(scanRoot, spec.selectors);
      if (!el) return null;
      return {
        key: spec.key,
        label:
          cleanText(el.getAttribute && el.getAttribute('title')) ||
          cleanText(el.textContent) ||
          spec.fallbackLabel,
        visible: isVisible(el),
        enabled:
          !el.hasAttribute('disabled') &&
          el.getAttribute('aria-disabled') !== 'true',
        selected: isSelected(el),
      };
    })
    .filter(Boolean);

  let chartVisible = null;
  const chartAction = actions.find((action) => action.key === 'toggle_chart');
  if (chartAction) {
    chartVisible = chartAction.selected;
  } else if (firstMatch(scanRoot, ['svg', 'canvas', '.chartContainer', '.reportChart'])) {
    chartVisible = true;
  }

  const loading = [...LOADING_SELECTORS].some((sel) => {
    try {
      return allMatches(scanRoot, [sel]).some((el) => isVisible(el));
    } catch (_e) {
      return false;
    }
  });

  const pageErrors = [...new Set(
    [
      ...allMatches(scanRoot, ERROR_SELECTORS),
      ...allMatches(document, ERROR_SELECTORS),
    ]
      .map((el) => cleanText(el.textContent))
      .filter((value) =>
        value !== null &&
        !/^loading\\.{0,3}$/i.test(value) &&
        !/^total records\\s+\\d+$/i.test(value),
      ),
  )];

  return {
    detected: true,
    kind,
    url,
    path,
    title,
    headerText,
    reportTypeLabel,
    aura: {
      detected: !!window.$A,
      idle: !(window.$A && window.$A.clientService && typeof window.$A.clientService.inFlightXHRs === 'function')
            || window.$A.clientService.inFlightXHRs().length === 0,
    },
    loading,
    filterCount: filters.length,
    filters,
    actionCount: actions.length,
    actions,
    chartVisible,
    pageErrors,
    containerTag: container ? container.tagName.toLowerCase() : null,
    scanIframeSrc,
  };
})()
`;
