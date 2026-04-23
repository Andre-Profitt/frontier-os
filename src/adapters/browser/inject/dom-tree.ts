// CDP-native DOM tree capture and serialization.
//
// Uses DOM.getDocument({depth: -1, pierce: true}) to get the entire document
// tree in one call — pierces shadow DOM natively, returns backendNodeIds that
// survive reparenting, and avoids the JS-bridge overhead of walking the DOM
// from an injected script.
//
// This replaces the inline Runtime.evaluate approach in the v0.1 inspect-dom
// placeholder. v0.3 will add layout bounds from DOMSnapshot.captureSnapshot.

import type { CdpSession } from "../cdp.ts";
import { isInteractive, type DomNodeForClickability } from "./clickable.ts";

// Minimal shape of what DOM.getDocument returns. We avoid importing the full
// devtools-protocol types here because the Node type from CRI is a structural
// subset and the types churn with Chrome releases.
interface CdpDomNode {
  nodeId: number;
  backendNodeId?: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[]; // flat [key, value, key, value, ...]
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode; // iframes
  pseudoElements?: CdpDomNode[];
}

export interface SerializedNode {
  backendNodeId?: number;
  nodeId: number;
  tag: string;
  nodeType: number;
  attrs: Record<string, string>;
  text?: string;
  interactive?: boolean;
  interactiveReason?: string;
  shadowRootMode?: "open" | "closed" | "user-agent";
  children: SerializedNode[];
}

export interface DomSnapshotResult {
  root: SerializedNode;
  totalNodes: number;
  interactiveNodes: number;
  truncated: boolean;
  shadowRootsSeen: number;
  iframesSeen: number;
}

export interface CaptureOptions {
  /** Max depth of the serialized tree (counted from the scope root). */
  maxDepth?: number;
  /** Hard cap on emitted nodes. */
  maxNodes?: number;
  /**
   * Only keep nodes of type ELEMENT_NODE (1) and meaningful text nodes.
   * Default true — drops comment/processing-instruction noise.
   */
  elementNodesOnly?: boolean;
  /**
   * Optional CSS selector (evaluated against the root Document via
   * DOM.querySelector) to scope the walk to a subtree. Pierces shadow DOM
   * via pierce:true on the initial getDocument call, but the selector
   * itself is a flat CSS selector — use DOM.querySelector's semantics.
   */
  rootSelector?: string;
}

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_DOCUMENT = 9;
const NODE_TYPE_DOCUMENT_FRAGMENT = 11; // shadow roots

function parseAttributes(flat: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = flat[i]!;
    const value = flat[i + 1]!;
    out[key] = value.length > 240 ? value.slice(0, 240) + "…" : value;
  }
  return out;
}

function textOfElement(node: CdpDomNode): string | undefined {
  // If the element has exactly one child that's a text node, return its
  // trimmed value. Matches the v0.1 inspect-dom heuristic.
  if (!node.children || node.children.length !== 1) return undefined;
  const only = node.children[0]!;
  if (only.nodeType !== NODE_TYPE_TEXT) return undefined;
  const raw = (only.nodeValue ?? "").trim();
  if (!raw) return undefined;
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

/**
 * Walk a CDP DOM node recursively, producing a SerializedNode tree.
 * Respects maxDepth, maxNodes, and the element-only filter. Shadow roots
 * and iframe contentDocuments are followed transparently.
 */
function walk(
  cdpNode: CdpDomNode,
  depth: number,
  state: {
    count: number;
    truncated: boolean;
    shadowRootsSeen: number;
    iframesSeen: number;
    interactiveCount: number;
    maxDepth: number;
    maxNodes: number;
    elementOnly: boolean;
  },
): SerializedNode | null {
  if (state.count >= state.maxNodes) {
    state.truncated = true;
    return null;
  }

  const tag = (cdpNode.localName || cdpNode.nodeName || "").toLowerCase();
  if (
    state.elementOnly &&
    cdpNode.nodeType !== NODE_TYPE_ELEMENT &&
    cdpNode.nodeType !== NODE_TYPE_DOCUMENT &&
    cdpNode.nodeType !== NODE_TYPE_DOCUMENT_FRAGMENT
  ) {
    return null;
  }

  state.count++;

  const attrs = parseAttributes(cdpNode.attributes);
  const node: SerializedNode = {
    nodeId: cdpNode.nodeId,
    tag,
    nodeType: cdpNode.nodeType,
    attrs,
    children: [],
  };
  if (cdpNode.backendNodeId !== undefined) {
    node.backendNodeId = cdpNode.backendNodeId;
  }

  // Interactive detection for element nodes only.
  if (cdpNode.nodeType === NODE_TYPE_ELEMENT) {
    const forCheck: DomNodeForClickability = {
      tagName: tag,
      attributes: attrs,
      children: (cdpNode.children ?? [])
        .filter((c) => c.nodeType === NODE_TYPE_ELEMENT)
        .map((c) => ({
          tagName: (c.localName || c.nodeName || "").toLowerCase(),
          attributes: parseAttributes(c.attributes),
        })),
    };
    const ir = isInteractive(forCheck);
    if (ir.interactive) {
      node.interactive = true;
      if (ir.reason) node.interactiveReason = ir.reason;
      state.interactiveCount++;
    }
  }

  const text = textOfElement(cdpNode);
  if (text) node.text = text;

  // Recurse into child element nodes.
  if (depth < state.maxDepth) {
    // Children
    for (const child of cdpNode.children ?? []) {
      if (state.count >= state.maxNodes) {
        state.truncated = true;
        break;
      }
      const rendered = walk(child, depth + 1, state);
      if (rendered) node.children.push(rendered);
    }
    // Shadow roots — pierce transparently.
    for (const shadow of cdpNode.shadowRoots ?? []) {
      state.shadowRootsSeen++;
      // Attach the shadow root under a synthetic "#shadow-root" marker so
      // consumers know the tree crossed a shadow boundary.
      const rendered = walk(shadow, depth + 1, state);
      if (rendered) {
        rendered.shadowRootMode = (
          shadow.nodeName?.includes("closed") ? "closed" : "open"
        ) as "open" | "closed";
        node.children.push(rendered);
      }
    }
    // iframe contentDocument — pierce transparently.
    if (cdpNode.contentDocument) {
      state.iframesSeen++;
      const rendered = walk(cdpNode.contentDocument, depth + 1, state);
      if (rendered) node.children.push(rendered);
    }
  } else if (
    (cdpNode.children && cdpNode.children.length > 0) ||
    (cdpNode.shadowRoots && cdpNode.shadowRoots.length > 0)
  ) {
    state.truncated = true;
  }

  return node;
}

/**
 * Capture a DOM tree from a live CDP session.
 */
export async function captureDomTree(
  session: CdpSession,
  opts: CaptureOptions = {},
): Promise<DomSnapshotResult> {
  const maxDepth = opts.maxDepth ?? 10;
  const maxNodes = opts.maxNodes ?? 1000;
  const elementOnly = opts.elementNodesOnly ?? true;
  const { DOM } = session.client;

  await DOM.enable({});
  // pierce:true walks into shadow DOM and iframes in one call. depth:-1 = full tree.
  const { root: document } = await DOM.getDocument({ depth: -1, pierce: true });

  let walkRoot: CdpDomNode = document as unknown as CdpDomNode;

  if (opts.rootSelector) {
    // DOM.querySelector returns a nodeId; we then need to resolve it back to
    // a full subtree. Use DOM.describeNode with depth:-1, pierce:true.
    const { nodeId } = await DOM.querySelector({
      nodeId: document.nodeId,
      selector: opts.rootSelector,
    });
    if (!nodeId) {
      throw new Error(
        `rootSelector ${JSON.stringify(opts.rootSelector)} matched no nodes`,
      );
    }
    const { node: scoped } = await DOM.describeNode({
      nodeId,
      depth: -1,
      pierce: true,
    });
    walkRoot = scoped as unknown as CdpDomNode;
  } else {
    // Walk from <body> if present, else from the document.
    const body = (walkRoot.children ?? [])
      .flatMap((n) => n.children ?? [])
      .find((n) => (n.localName || n.nodeName || "").toLowerCase() === "body");
    if (body) walkRoot = body;
  }

  const state = {
    count: 0,
    truncated: false,
    shadowRootsSeen: 0,
    iframesSeen: 0,
    interactiveCount: 0,
    maxDepth,
    maxNodes,
    elementOnly,
  };

  const rendered = walk(walkRoot, 0, state);
  if (!rendered) {
    throw new Error("DOM walk produced no root node");
  }

  return {
    root: rendered,
    totalNodes: state.count,
    interactiveNodes: state.interactiveCount,
    truncated: state.truncated,
    shadowRootsSeen: state.shadowRootsSeen,
    iframesSeen: state.iframesSeen,
  };
}
