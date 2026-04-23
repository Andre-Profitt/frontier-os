// TypeScript port of browser-use's ClickableElementDetector.is_interactive.
// Source: browser_use/dom/serializer/clickable_elements.py (MIT license)
//
// v0.2 scope: tag/role/attribute/event-handler heuristics. Does NOT yet
// include:
//   - computed-style cursor:pointer check (needs DOMSnapshot or computed-style CDP)
//   - accessibility-tree role fallback (skipped on Lightning per research
//     dossier, will be wired in selectively for Sigma later)
//   - icon-sized element detection (needs bounds from DOMSnapshot/getBoxModel)
//   - has_js_click_listener detection (needs DOMDebugger.getEventListeners)
//
// These are planned for v0.3 alongside bounds capture.

export interface DomNodeForClickability {
  tagName: string; // lower-case
  attributes: Record<string, string>;
  children?: DomNodeForClickability[];
}

const INTERACTIVE_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "a",
  "details",
  "summary",
  "option",
  "optgroup",
]);

const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);

const INTERACTIVE_EVENT_ATTRS = new Set([
  "onclick",
  "onmousedown",
  "onmouseup",
  "onkeydown",
  "onkeyup",
  "tabindex",
]);

const INTERACTIVE_ARIA_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "option",
  "radio",
  "checkbox",
  "tab",
  "textbox",
  "combobox",
  "slider",
  "spinbutton",
  "search",
  "searchbox",
  "row",
  "cell",
  "gridcell",
]);

const SEARCH_INDICATORS = [
  "search",
  "magnify",
  "glass",
  "lookup",
  "find",
  "query",
  "search-icon",
  "search-btn",
  "search-button",
  "searchbox",
];

function hasFormControlDescendant(
  node: DomNodeForClickability,
  maxDepth: number,
): boolean {
  if (maxDepth <= 0) return false;
  if (!node.children) return false;
  for (const child of node.children) {
    if (FORM_CONTROL_TAGS.has(child.tagName)) return true;
    if (hasFormControlDescendant(child, maxDepth - 1)) return true;
  }
  return false;
}

export interface InteractiveReason {
  interactive: boolean;
  reason?: string;
}

/**
 * Decide whether a DOM element node is interactive/clickable.
 * Returns `{interactive: true, reason: "..."}` or `{interactive: false}`.
 * Reasons are useful in inspect-dom output for auditing "why did this get flagged".
 */
export function isInteractive(node: DomNodeForClickability): InteractiveReason {
  const tag = node.tagName;
  const attrs = node.attributes ?? {};

  if (tag === "html" || tag === "body") {
    return { interactive: false };
  }

  // Labels: skip proxies (for=...), otherwise interactive if wrapping a form control.
  if (tag === "label") {
    if (attrs["for"]) return { interactive: false };
    if (hasFormControlDescendant(node, 2)) {
      return { interactive: true, reason: "label wrapping form control" };
    }
    // fall through to generic heuristics
  }

  // Span wrappers: interactive if wrapping a form control, otherwise fall through.
  if (tag === "span") {
    if (hasFormControlDescendant(node, 2)) {
      return { interactive: true, reason: "span wrapping form control" };
    }
  }

  // Search heuristics on class/id/data-* attributes.
  const classList = (attrs["class"] ?? "").toLowerCase();
  const elementId = (attrs["id"] ?? "").toLowerCase();
  for (const indicator of SEARCH_INDICATORS) {
    if (classList.includes(indicator)) {
      return {
        interactive: true,
        reason: `search indicator in class: ${indicator}`,
      };
    }
    if (elementId.includes(indicator)) {
      return {
        interactive: true,
        reason: `search indicator in id: ${indicator}`,
      };
    }
  }
  for (const [attrName, attrValue] of Object.entries(attrs)) {
    if (!attrName.startsWith("data-")) continue;
    const lower = attrValue.toLowerCase();
    for (const indicator of SEARCH_INDICATORS) {
      if (lower.includes(indicator)) {
        return {
          interactive: true,
          reason: `search indicator in ${attrName}: ${indicator}`,
        };
      }
    }
  }

  // Canonical interactive tags.
  if (INTERACTIVE_TAGS.has(tag)) {
    return { interactive: true, reason: `tag:${tag}` };
  }

  // Interactive event attributes / tabindex.
  for (const eventAttr of INTERACTIVE_EVENT_ATTRS) {
    if (eventAttr in attrs) {
      return { interactive: true, reason: `attr:${eventAttr}` };
    }
  }

  // ARIA role check.
  const role = attrs["role"];
  if (role && INTERACTIVE_ARIA_ROLES.has(role)) {
    return { interactive: true, reason: `role:${role}` };
  }

  // Common Salesforce Lightning tag shortcuts — not in browser-use's upstream
  // but load-bearing for us. `lightning-button-icon`, `lightning-button`,
  // `lightning-menu-item`, etc. are always interactive.
  if (tag.startsWith("lightning-")) {
    if (
      tag === "lightning-button" ||
      tag === "lightning-button-icon" ||
      tag === "lightning-button-icon-stateful" ||
      tag === "lightning-button-menu" ||
      tag === "lightning-menu-item" ||
      tag === "lightning-combobox" ||
      tag === "lightning-input" ||
      tag === "lightning-checkbox-group" ||
      tag === "lightning-radio-group"
    ) {
      return { interactive: true, reason: `lwc:${tag}` };
    }
  }

  return { interactive: false };
}
