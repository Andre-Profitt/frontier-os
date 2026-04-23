import { attach, evaluate, type CdpAttachOptions, type CdpSession } from "../../browser/cdp.ts";
import { runAction } from "../../browser/actions/action-loop.ts";
import type { NetworkMatcher } from "../../browser/actions/network-expect.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface MoveWidgetArgs extends CdpAttachOptions {
  urlHint?: string;
  selector?: string;
  widgetId?: string;
  widgetTitle?: string;
  targetSelector?: string;
  direction?: "left" | "right" | "up" | "down";
  deltaX?: number;
  deltaY?: number;
  dragSteps?: number;
  withHelper?: boolean;
  networkUrlRegex?: string;
  networkMethod?: string;
  acceptFailedNetwork?: boolean;
}

interface WidgetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WidgetSummary {
  tagName: string;
  id: string | null;
  widgetId: string | null;
  title: string | null;
  rect: WidgetRect;
}

interface MovePlan {
  strategy: "pointer_drag" | "editor_reflow";
  widget: WidgetSummary;
  startCenter: { x: number; y: number };
  endCenter: { x: number; y: number };
  targetRect: WidgetRect | null;
  moveVector: { dx: number; dy: number };
}

const DEFAULT_URL_MATCH = /salesforce|lightning|force\.com/i;
const DEFAULT_DIRECTION_STEP = 240;
const DEFAULT_DRAG_STEPS = 14;

export async function moveWidgetCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as MoveWidgetArgs;

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

  let plan: MovePlan | null = null;
  try {
    const urlBefore = session.target.url;
    const networkMatcher = buildNetworkMatcher(args);
    const result = await runAction({
      session,
      ...(networkMatcher ? { expectNetwork: networkMatcher } : {}),
      networkTimeoutMs: 10000,
      skipStability: true,
      expectDomExpression: buildVerifyScript(args),
      noToast: ["error", "warning"],
      rollback: async () => {
        try {
          await session.client.Page.navigate({ url: urlBefore });
        } catch {
          /* best effort */
        }
      },
      action: async () => {
        plan = await attemptEditorReflowMove(session, args);
        if (!plan) {
          plan = await resolveMovePlan(session, args);
          try {
            await session.client.Page.bringToFront();
          } catch {
            /* best effort */
          }
          await dragPointer(
            session,
            plan.startCenter,
            plan.endCenter,
            normalizedDragSteps(args.dragSteps),
          );
        }
        await recordMovePlan(session, plan);
        await waitAfterAction(session);
      },
    });

    const failedChecks = result.checks.filter((check) => check.status === "failed");
    const resolvedPlan = snapshotMovePlan(plan);
    const movedWidget = resolvedPlan ? resolvedPlan.widget : null;
    const sideEffects = movedWidget
      ? [
          {
            class: "shared_write" as const,
            target: session.target.url,
            summary: `moved ${describeWidget(movedWidget)}`,
          },
        ]
      : undefined;
    return buildResult({
      invocation,
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? `moved ${describeWidget(movedWidget)} on ${session.target.url}`
        : `move-widget failed: ${summarizeFailedChecks(failedChecks)}`,
      observedState: {
        targetId: session.target.id,
        url: session.target.url,
        helperInstalled: session.helperInstalled,
        requested: requestedMove(args),
        plan: resolvedPlan,
        checks: result.checks,
        toasts: result.toasts,
        rolledBack: result.rolledBack,
        durationMs: result.durationMs,
        ...(result.network ? { network: result.network } : {}),
      },
      ...(sideEffects ? { sideEffects } : {}),
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

async function recordMovePlan(
  session: CdpSession,
  plan: MovePlan,
): Promise<void> {
  await evaluate(session, {
    expression: `(() => {
      window.__frontierMoveWidgetPlan = ${JSON.stringify({
        strategy: plan.strategy,
        startCenter: plan.startCenter,
        endCenter: plan.endCenter,
        targetRect: plan.targetRect,
        moveVector: plan.moveVector,
        widget: plan.widget,
      })};
      return true;
    })()`,
    awaitPromise: false,
    returnByValue: true,
  });
}

function snapshotMovePlan(plan: MovePlan | null): MovePlan | null {
  return plan;
}

async function attemptEditorReflowMove(
  session: CdpSession,
  args: MoveWidgetArgs,
): Promise<MovePlan | null> {
  if (typeof args.targetSelector !== "string" || args.targetSelector.trim().length === 0) {
    return null;
  }
  const result = await evaluate<
    | { ok: true; plan: MovePlan }
    | { ok: false; unsupported?: boolean; reason: string }
  >(session, {
    expression: buildEditorReflowScript(args),
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.ok) {
    return result.plan;
  }
  if (result.unsupported) {
    return null;
  }
  throw new Error(result.reason);
}

async function resolveMovePlan(
  session: CdpSession,
  args: MoveWidgetArgs,
): Promise<MovePlan> {
  const plan = await evaluate<
    | {
        ok: true;
        strategy: "pointer_drag";
        widget: WidgetSummary;
        startCenter: { x: number; y: number };
        endCenter: { x: number; y: number };
        targetRect: WidgetRect | null;
        moveVector: { dx: number; dy: number };
      }
    | { ok: false; reason: string }
  >(session, {
    expression: buildResolvePlanScript(args),
    awaitPromise: false,
    returnByValue: true,
  });
  if (!plan.ok) {
    throw new Error(plan.reason);
  }
  return plan;
}

function buildEditorReflowScript(args: MoveWidgetArgs): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    widgetId: args.widgetId ?? null,
    widgetTitle: args.widgetTitle ?? null,
    targetSelector: args.targetSelector ?? null,
  });
  return `(async () => {
    const payload = ${payload};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const readClassWidgetId = (el) => {
      const nodes = [el, el && el.closest ? el.closest('[class*="widget-container_"]') : null]
        .filter(Boolean);
      for (const node of nodes) {
        const classList = Array.from(node.classList || []);
        for (const className of classList) {
          const match = /^widget-container_(.+)$/.exec(className);
          if (match && match[1]) return normalize(match[1]);
        }
      }
      return null;
    };
    const readWidgetId = (el) =>
      normalize(
        el?.getAttribute?.('data-widget-id') ||
        el?.getAttribute?.('data-component-id') ||
        readClassWidgetId(el) ||
        ''
      ) || null;
    const readWidgetTitle = (el) => {
      if (!el) return null;
      const titleNode = el.querySelector('h1, h2, h3, h4, [role="heading"], [aria-label]');
      return normalize(
        (titleNode && (titleNode.getAttribute('aria-label') || titleNode.textContent)) ||
        el.getAttribute('aria-label') ||
        ''
      ) || null;
    };
    const widgetSummary = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        tagName: String(el.tagName || '').toLowerCase(),
        id: el.id || null,
        widgetId: readWidgetId(el),
        title: readWidgetTitle(el),
        rect: {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
        },
      };
    };
    const selectors = [
      'analytics-dashboard-widget',
      'wave-dashboard-widget',
      '[data-widget-id]',
      '[data-component-id]',
      '[class*="widget-container_"]',
      '[data-frontier-widget-id]',
      '[data-widget-title]',
    ];
    const collectCandidates = () => {
      if (payload.selector) {
        try {
          const matched = document.querySelector(payload.selector);
          return matched ? [matched] : [];
        } catch (error) {
          throw new Error('invalid selector: ' + ((error && error.message) || error));
        }
      }
      const seen = new Set();
      const candidates = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          candidates.push(element);
        }
      }
      return candidates;
    };
    const resolveWidgetContainer = (el) => {
      if (!el) return null;
      if (String(el.className || '').includes('widget-container_')) return el;
      return el.closest('[class*="widget-container_"]');
    };
    const resolveWidgetNode = (container) =>
      container?.querySelector?.(':scope > .widget[draggable="true"]') ||
      container?.querySelector?.('.widget[draggable="true"]') ||
      null;
    const findReactFiber = (node, predicate) => {
      if (!node) return null;
      const reactKey = Object.keys(node).find((key) => key.startsWith('__reactFiber'));
      let fiber = reactKey ? node[reactKey] : null;
      while (fiber) {
        if (predicate(fiber)) return fiber;
        fiber = fiber.return;
      }
      return null;
    };

    if (!payload.targetSelector) {
      return {
        ok: false,
        unsupported: true,
        reason: 'editor reflow requires targetSelector',
      };
    }

    let candidates;
    try {
      candidates = collectCandidates();
    } catch (error) {
      return {
        ok: false,
        reason: String(error && error.message ? error.message : error),
      };
    }

    const wantedWidgetId = normalize(payload.widgetId).toLowerCase();
    const wantedTitle = normalize(payload.widgetTitle).toLowerCase();
    const sourceElement = candidates.find((candidate) => {
      const container = resolveWidgetContainer(candidate) || candidate;
      if (!isVisible(container)) return false;
      const summary = widgetSummary(container);
      const candidateWidgetId = normalize(summary.widgetId).toLowerCase();
      const candidateTitle = normalize(summary.title).toLowerCase();
      if (wantedWidgetId && candidateWidgetId !== wantedWidgetId) return false;
      if (wantedTitle && !candidateTitle.includes(wantedTitle)) return false;
      return true;
    });
    if (!sourceElement) {
      return {
        ok: false,
        reason: 'no visible widget matched the provided widget selector/id/title',
      };
    }

    let targetElement = null;
    try {
      targetElement = document.querySelector(payload.targetSelector);
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid targetSelector: ' + ((error && error.message) || error),
      };
    }
    if (!targetElement || !isVisible(targetElement)) {
      return {
        ok: false,
        reason: 'targetSelector did not resolve to a visible widget slot',
      };
    }

    const sourceContainer = resolveWidgetContainer(sourceElement) || sourceElement;
    const targetContainer = resolveWidgetContainer(targetElement);
    const sourceWidgetNode = resolveWidgetNode(sourceContainer);
    const targetWidgetNode = resolveWidgetNode(targetContainer);
    if (!sourceContainer || !targetContainer || !sourceWidgetNode || !targetWidgetNode) {
      return {
        ok: false,
        unsupported: true,
        reason: 'editor reflow surface was not available for the selected widgets',
      };
    }

    const sourceWidgetFiber = findReactFiber(
      sourceWidgetNode,
      (fiber) => fiber.tag === 11 && fiber.memoizedProps && fiber.memoizedProps.widget,
    );
    const targetWidgetFiber = findReactFiber(
      targetWidgetNode,
      (fiber) => fiber.tag === 11 && fiber.memoizedProps && fiber.memoizedProps.widget,
    );
    const gridFiber = findReactFiber(
      sourceWidgetNode,
      (fiber) =>
        fiber.tag === 1 &&
        fiber.type &&
        (fiber.type.displayName || fiber.type.name) === 'GridLayoutRC',
    );
    if (!sourceWidgetFiber || !targetWidgetFiber || !gridFiber) {
      return {
        ok: false,
        unsupported: true,
        reason: 'editor reflow hooks were not present on the live dashboard surface',
      };
    }

    const grid = gridFiber.stateNode;
    const mover = gridFiber.memoizedProps?.mover;
    if (!grid || !mover || !mover._reflowMover) {
      return {
        ok: false,
        unsupported: true,
        reason: 'editor reflow mover was not available',
      };
    }

    const sourceWidget = sourceWidgetFiber.memoizedProps.widget;
    const targetWidget = targetWidgetFiber.memoizedProps.widget;
    const sourceLeft = parseFloat(sourceContainer.style.left || 'NaN');
    const sourceTop = parseFloat(sourceContainer.style.top || 'NaN');
    const targetLeft = parseFloat(targetContainer.style.left || 'NaN');
    const targetTop = parseFloat(targetContainer.style.top || 'NaN');
    if (![sourceLeft, sourceTop, targetLeft, targetTop].every(Number.isFinite)) {
      return {
        ok: false,
        unsupported: true,
        reason: 'widget containers did not expose layout positioning metadata',
      };
    }

    const sourceRect = sourceContainer.getBoundingClientRect();
    const targetRect = targetContainer.getBoundingClientRect();
    const summary = widgetSummary(sourceContainer);
    const delta = {
      deltaX: targetLeft - sourceLeft,
      deltaY: targetTop - sourceTop,
    };
    const startBox = {
      getColumn: () => sourceLeft,
      getRow: () => sourceTop,
      getWidth: () => sourceRect.width,
      getHeight: () => sourceRect.height,
    };
    const plan = {
      strategy: 'editor_reflow',
      widget: summary,
      startCenter: {
        x: summary.rect.x + summary.rect.w / 2,
        y: summary.rect.y + summary.rect.h / 2,
      },
      endCenter: {
        x: targetRect.x + targetRect.width / 2,
        y: targetRect.y + targetRect.height / 2,
      },
      targetRect: {
        x: targetRect.x,
        y: targetRect.y,
        w: targetRect.width,
        h: targetRect.height,
      },
      moveVector: {
        dx: delta.deltaX,
        dy: delta.deltaY,
      },
    };

    try {
      sourceWidgetNode.click();
    } catch (_error) {
      /* best effort */
    }
    await wait(100);
    mover._activeMover = mover._reflowMover;
    mover._activeShiftState = true;
    mover._preventReflow = false;
    grid._onKeyboardMoveStart();
    await wait(100);
    grid._onKeyboardMove(delta, startBox, null, grid.state?.proxyMap || {});
    await wait(100);

    const moveResults = grid.state?.moveResults;
    if (!moveResults || !moveResults.isValidOperation || !moveResults.isValidOperation()) {
      return {
        ok: false,
        reason: 'editor reflow move rejected the requested slot',
      };
    }

    grid._onKeyboardMoveEnd(startBox, delta, false);
    await wait(200);

    return {
      ok: true,
      plan,
    };
  })()`;
}

function buildResolvePlanScript(args: MoveWidgetArgs): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    widgetId: args.widgetId ?? null,
    widgetTitle: args.widgetTitle ?? null,
    targetSelector: args.targetSelector ?? null,
    direction: args.direction ?? null,
    deltaX: typeof args.deltaX === "number" ? args.deltaX : null,
    deltaY: typeof args.deltaY === "number" ? args.deltaY : null,
    stepPixels: DEFAULT_DIRECTION_STEP,
  });
  return `(() => {
    const payload = ${payload};
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const readClassWidgetId = (el) => {
      const nodes = [el, el && el.closest ? el.closest('[class*="widget-container_"]') : null]
        .filter(Boolean);
      for (const node of nodes) {
        for (const className of Array.from(node.classList || [])) {
          const match = /^widget-container_(.+)$/.exec(className);
          if (match && match[1]) return normalize(match[1]);
        }
      }
      return null;
    };
    const readWidgetId = (el) =>
      normalize(
        el?.getAttribute?.('data-widget-id') ||
        el?.getAttribute?.('data-component-id') ||
        readClassWidgetId(el) ||
        ''
      ) || null;
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const widgetSummary = (el) => {
      const rect = el.getBoundingClientRect();
      const titleNode = el.querySelector('h1, h2, h3, h4, [role="heading"], [aria-label]');
      return {
        tagName: String(el.tagName || '').toLowerCase(),
        id: el.id || null,
        widgetId: readWidgetId(el),
        title: normalize(
          (titleNode && (titleNode.getAttribute('aria-label') || titleNode.textContent)) ||
          el.getAttribute('aria-label') ||
          ''
        ) || null,
        rect: {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
        },
      };
    };
    const selectors = [
      'analytics-dashboard-widget',
      'wave-dashboard-widget',
      '[data-widget-id]',
      '[data-component-id]',
      '[class*="widget-container_"]',
      '[data-frontier-widget-id]',
      '[data-widget-title]',
    ];
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
      const seen = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          candidates.push(element);
        }
      }
    }

    const wantedWidgetId = normalize(payload.widgetId).toLowerCase();
    const wantedTitle = normalize(payload.widgetTitle).toLowerCase();
    const widget = candidates.find((candidate) => {
      if (!isVisible(candidate)) return false;
      const summary = widgetSummary(candidate);
      const candidateWidgetId = normalize(summary.widgetId).toLowerCase();
      const candidateTitle = normalize(summary.title).toLowerCase();
      if (wantedWidgetId && candidateWidgetId !== wantedWidgetId) return false;
      if (wantedTitle && !candidateTitle.includes(wantedTitle)) return false;
      return true;
    });
    if (!widget) {
      return {
        ok: false,
        reason: 'no visible widget matched the provided widget selector/id/title',
      };
    }

    const summary = widgetSummary(widget);
    const startCenter = {
      x: summary.rect.x + summary.rect.w / 2,
      y: summary.rect.y + summary.rect.h / 2,
    };

    let targetRect = null;
    let moveVector = { dx: 0, dy: 0 };
    if (payload.targetSelector) {
      let target = null;
      try {
        target = document.querySelector(payload.targetSelector);
      } catch (error) {
        return {
          ok: false,
          reason: 'invalid targetSelector: ' + ((error && error.message) || error),
        };
      }
      if (!target || !isVisible(target)) {
        return {
          ok: false,
          reason: 'targetSelector did not resolve to a visible drop target',
        };
      }
      const rect = target.getBoundingClientRect();
      targetRect = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      moveVector = {
        dx: rect.x + rect.width / 2 - startCenter.x,
        dy: rect.y + rect.height / 2 - startCenter.y,
      };
    } else if (typeof payload.deltaX === 'number' || typeof payload.deltaY === 'number') {
      moveVector = {
        dx: typeof payload.deltaX === 'number' ? payload.deltaX : 0,
        dy: typeof payload.deltaY === 'number' ? payload.deltaY : 0,
      };
    } else if (payload.direction) {
      const step = typeof payload.stepPixels === 'number' ? payload.stepPixels : 240;
      if (payload.direction === 'left') moveVector.dx = -step;
      else if (payload.direction === 'right') moveVector.dx = step;
      else if (payload.direction === 'up') moveVector.dy = -step;
      else if (payload.direction === 'down') moveVector.dy = step;
    } else {
      return {
        ok: false,
        reason: 'move-widget requires targetSelector, deltaX/deltaY, or direction',
      };
    }

    const endCenter = {
      x: startCenter.x + moveVector.dx,
      y: startCenter.y + moveVector.dy,
    };
    return {
      ok: true,
      strategy: 'pointer_drag',
      widget: summary,
      startCenter,
      endCenter,
      targetRect,
      moveVector,
    };
  })()`;
}

async function dragPointer(
  session: CdpSession,
  start: { x: number; y: number },
  end: { x: number; y: number },
  steps: number,
): Promise<void> {
  const { Input } = session.client;
  await Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
  });
  await Input.dispatchMouseEvent({
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
      button: "left",
      buttons: 1,
    });
  }
  await Input.dispatchMouseEvent({
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function waitAfterAction(session: CdpSession, timeoutMs = 350): Promise<void> {
  await evaluate(session, {
    expression: `new Promise((resolve) => setTimeout(resolve, ${timeoutMs}))`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs + 1000,
  });
}

function buildVerifyScript(args: MoveWidgetArgs): string {
  const payload = JSON.stringify({
    selector: args.selector ?? null,
    widgetId: args.widgetId ?? null,
    widgetTitle: args.widgetTitle ?? null,
    targetSelector: args.targetSelector ?? null,
    direction: args.direction ?? null,
  });
  return `(() => {
    const payload = ${payload};
    const movePlan = window.__frontierMoveWidgetPlan || null;
    const normalize = (value) =>
      String(value ?? '').replace(/\\s+/g, ' ').trim();
    const readClassWidgetId = (el) => {
      const nodes = [el, el && el.closest ? el.closest('[class*="widget-container_"]') : null]
        .filter(Boolean);
      for (const node of nodes) {
        for (const className of Array.from(node.classList || [])) {
          const match = /^widget-container_(.+)$/.exec(className);
          if (match && match[1]) return normalize(match[1]);
        }
      }
      return null;
    };
    const readWidgetId = (el) =>
      normalize(
        el?.getAttribute?.('data-widget-id') ||
        el?.getAttribute?.('data-component-id') ||
        readClassWidgetId(el) ||
        ''
      ).toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectors = [
      'analytics-dashboard-widget',
      'wave-dashboard-widget',
      '[data-widget-id]',
      '[data-component-id]',
      '[class*="widget-container_"]',
      '[data-frontier-widget-id]',
      '[data-widget-title]',
    ];
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
      const seen = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          candidates.push(element);
        }
      }
    }

    const wantedWidgetId = normalize(payload.widgetId).toLowerCase();
    const wantedTitle = normalize(payload.widgetTitle).toLowerCase();
    const widget = candidates.find((candidate) => {
      if (!isVisible(candidate)) return false;
      const candidateWidgetId = readWidgetId(candidate);
      const titleNode = candidate.querySelector('h1, h2, h3, h4, [role="heading"], [aria-label]');
      const candidateTitle = normalize(
        (titleNode && (titleNode.getAttribute('aria-label') || titleNode.textContent)) ||
        candidate.getAttribute('aria-label') ||
        ''
      ).toLowerCase();
      if (wantedWidgetId && candidateWidgetId !== wantedWidgetId) return false;
      if (wantedTitle && !candidateTitle.includes(wantedTitle)) return false;
      return true;
    });
    if (!widget) {
      return {
        ok: false,
        reason: 'widget not found after drag',
      };
    }

    const rect = widget.getBoundingClientRect();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    if (payload.targetSelector) {
      const targetRect =
        movePlan &&
        movePlan.targetRect &&
        typeof movePlan.targetRect.x === 'number' &&
        typeof movePlan.targetRect.y === 'number' &&
        typeof movePlan.targetRect.w === 'number' &&
        typeof movePlan.targetRect.h === 'number'
          ? movePlan.targetRect
          : (() => {
              let target = null;
              try {
                target = document.querySelector(payload.targetSelector);
              } catch (error) {
                return {
                  ok: false,
                  reason: 'invalid targetSelector: ' + ((error && error.message) || error),
                };
              }
              if (!target || !isVisible(target)) {
                return {
                  ok: false,
                  reason: 'targetSelector not visible after drag',
                };
              }
              const currentRect = target.getBoundingClientRect();
              return {
                x: currentRect.x,
                y: currentRect.y,
                w: currentRect.width,
                h: currentRect.height,
              };
            })();
      if (targetRect && targetRect.ok === false) {
        return targetRect;
      }
      const inside =
        center.x >= targetRect.x &&
        center.x <= targetRect.x + targetRect.w &&
        center.y >= targetRect.y &&
        center.y <= targetRect.y + targetRect.h;
      if (!inside) {
        return {
          ok: false,
          reason: 'widget center did not land inside the requested target',
          observed: {
            center,
            targetRect: {
              x: targetRect.x,
              y: targetRect.y,
              w: targetRect.w,
              h: targetRect.h,
            },
          },
        };
      }
      return {
        ok: true,
        observed: {
          center,
          targetRect: {
            x: targetRect.x,
            y: targetRect.y,
            w: targetRect.w,
            h: targetRect.h,
          },
        },
      };
    }
    const plannedStart =
      movePlan &&
      movePlan.widget &&
      movePlan.widget.rect &&
      typeof movePlan.widget.rect.x === 'number' &&
      typeof movePlan.widget.rect.y === 'number'
        ? movePlan.widget.rect
        : null;
    if (
      plannedStart &&
      typeof movePlan.moveVector?.dx === 'number' &&
      typeof movePlan.moveVector?.dy === 'number'
    ) {
      const actualDx = rect.x - plannedStart.x;
      const actualDy = rect.y - plannedStart.y;
      const movedEnough =
        Math.abs(actualDx) >= 12 || Math.abs(actualDy) >= 12;
      if (!movedEnough) {
        return {
          ok: false,
          reason: 'widget rect did not change enough after drag',
          observed: {
            startRect: plannedStart,
            endRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            actualDelta: { dx: actualDx, dy: actualDy },
          },
        };
      }
      if (payload.direction) {
        const expectedRight = payload.direction === 'right' && actualDx > 0;
        const expectedLeft = payload.direction === 'left' && actualDx < 0;
        const expectedDown = payload.direction === 'down' && actualDy > 0;
        const expectedUp = payload.direction === 'up' && actualDy < 0;
        if (!(expectedRight || expectedLeft || expectedDown || expectedUp)) {
          return {
            ok: false,
            reason: 'widget rect changed, but not in the requested direction',
            observed: {
              startRect: plannedStart,
              endRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              actualDelta: { dx: actualDx, dy: actualDy },
            },
          };
        }
      }
      if (typeof payload.direction !== 'string') {
        const expectedDx = Number(movePlan.moveVector.dx || 0);
        const expectedDy = Number(movePlan.moveVector.dy || 0);
        const roughlyMatches = (expected, actual) =>
          Math.abs(expected) < 1 ? Math.abs(actual) < 18 : Math.sign(expected) === Math.sign(actual);
        if (!roughlyMatches(expectedDx, actualDx) || !roughlyMatches(expectedDy, actualDy)) {
          return {
            ok: false,
            reason: 'widget rect changed, but not toward the requested destination',
            observed: {
              startRect: plannedStart,
              endRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              expectedDelta: { dx: expectedDx, dy: expectedDy },
              actualDelta: { dx: actualDx, dy: actualDy },
            },
          };
        }
      }
      return {
        ok: true,
        observed: {
          startRect: plannedStart,
          endRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          actualDelta: { dx: actualDx, dy: actualDy },
        },
      };
    }
    if (payload.direction) {
      return {
        ok: false,
        reason: 'move verification lost the planned start rect before direction check',
      };
    }
    return {
      ok: true,
      observed: {
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      },
    };
  })()`;
}

function buildNetworkMatcher(args: MoveWidgetArgs): NetworkMatcher | null {
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

function normalizedDragSteps(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DRAG_STEPS;
  return Math.max(3, Math.min(40, Math.floor(value)));
}

function requestedMove(args: MoveWidgetArgs): Record<string, unknown> {
  return {
    selector: args.selector ?? null,
    widgetId: args.widgetId ?? null,
    widgetTitle: args.widgetTitle ?? null,
    targetSelector: args.targetSelector ?? null,
    direction: args.direction ?? null,
    deltaX: typeof args.deltaX === "number" ? args.deltaX : null,
    deltaY: typeof args.deltaY === "number" ? args.deltaY : null,
  };
}

function describeWidget(widget: WidgetSummary | null): string {
  if (!widget) return "widget";
  return widget.title ?? widget.widgetId ?? widget.id ?? widget.tagName;
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
  args: MoveWidgetArgs,
  failedChecks: Array<{ name: string }>,
): string[] {
  const actions: string[] = [];
  if (failedChecks.some((check) => check.name === "action")) {
    actions.push(
      "confirm the widget locator resolves in edit mode and the target drop zone is visible",
    );
  }
  if (failedChecks.some((check) => check.name === "dom-predicate")) {
    actions.push(
      typeof args.targetSelector === "string"
        ? "check that the widget can legally drop into the requested targetSelector"
        : "pass targetSelector for deterministic placement instead of relying on a relative drag only",
    );
  }
  if (failedChecks.some((check) => check.name === "network")) {
    actions.push(
      "relax or remove networkUrlRegex if the widget move does not emit a matching request",
    );
  }
  if (actions.length === 0) {
    actions.push(
      "confirm the dashboard is already in edit mode before retrying move-widget",
    );
  }
  return actions;
}
