// Frontier OS page-side helper.
//
// This file is injected into every page via
// Page.addScriptToEvaluateOnNewDocument + a Page.frameNavigated safety net
// (see inject/install.ts). It must be an IIFE, idempotent across re-injection,
// and MUST NOT throw on pages where it's already installed.
//
// Everything the controller needs page-side (SPA nav events, mutation
// observers, stability detection, toast watchers, postMessage hooks) hangs
// off window.__frontier. Call via CDP Runtime.evaluate.
//
// Version strategy: every material change to this file bumps __version.
// installHelper() re-injects on every navigation and the idempotency guard
// destroys the old instance if the version is stale, so live tabs pick up
// new helper versions on their next navigation without requiring a reload.

(function installFrontierHelper() {
  "use strict";
  const w = /** @type {any} */ (window);
  const VERSION = 2;

  // Idempotency: if an older version is installed, destroy it and reinstall.
  // If the same version is already installed, bail.
  if (w.__frontier && w.__frontier.__version === VERSION) return;
  if (w.__frontier && typeof w.__frontier.__destroy === "function") {
    try {
      w.__frontier.__destroy();
    } catch (_e) {
      /* ignore */
    }
  }

  const disposers = [];
  const onDestroy = (fn) => disposers.push(fn);

  // ---- SPA navigation awareness ----
  // Patch history.pushState/replaceState so soft-nav emits a 'frontier:nav'
  // CustomEvent. The install layer listens to Page.frameNavigated from CDP,
  // but that fires on full-document loads only; this gives us page-side
  // notification for SPA route changes (pushState).
  const emitNav = (reason) => {
    try {
      window.dispatchEvent(
        new CustomEvent("frontier:nav", {
          detail: { url: location.href, reason },
        }),
      );
    } catch (_e) {
      /* no DOM at very early inject time */
    }
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function patchedHistoryMethod() {
      const result = original.apply(this, arguments);
      queueMicrotask(() => emitNav(method));
      return result;
    };
    onDestroy(() => {
      history[method] = original;
    });
  }
  const onPopState = () => emitNav("popstate");
  window.addEventListener("popstate", onPopState);
  onDestroy(() => window.removeEventListener("popstate", onPopState));

  // ---- Shadow-aware MutationObserver ----
  // Observes the document + every open shadow root recursively. Also patches
  // Element.prototype.attachShadow so newly created open shadow roots get
  // observed as they appear. Closed shadow roots are invisible by design.
  const observeAll = (root, callback) => {
    const mo = new MutationObserver(callback);
    try {
      mo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-busy", "aria-hidden", "class", "hidden"],
      });
    } catch (_e) {
      return { disconnect() {} };
    }
    const walk = (node) => {
      if (node && node.shadowRoot) {
        try {
          mo.observe(node.shadowRoot, { childList: true, subtree: true });
          node.shadowRoot.querySelectorAll("*").forEach(walk);
        } catch (_e) {
          /* ignore unreadable shadow */
        }
      }
    };
    try {
      root.querySelectorAll("*").forEach(walk);
    } catch (_e) {
      /* root may not be queryable yet */
    }
    const origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function frontierAttachShadow(init) {
      const sr = origAttach.call(this, init);
      if (init && init.mode === "open") {
        try {
          mo.observe(sr, { childList: true, subtree: true });
        } catch (_e) {
          /* ignore */
        }
      }
      return sr;
    };
    onDestroy(() => {
      try {
        mo.disconnect();
      } catch (_e) {
        /* already disconnected */
      }
      Element.prototype.attachShadow = origAttach;
    });
    return mo;
  };

  // ---- Composite stability detection ----
  // v0.2: minimum viable version. Combines mutation quiescence + aria-busy +
  // spinner absence + optional Aura inFlightXHRs for Lightning.
  // v0.3 will add: network-ignore-list fetch/XHR patching, long-animation-frame
  // PerformanceObserver, and postMessage-based signals for Sigma.
  const SPINNER_SELECTOR =
    "[aria-busy='true'], .slds-spinner, lightning-spinner, .loading-spinner, .dashboardSpinner";

  const auraIdle = () => {
    try {
      // @ts-ignore — Aura injects window.$A on Lightning pages
      const $A = w.$A;
      if (
        !$A ||
        !$A.clientService ||
        typeof $A.clientService.inFlightXHRs !== "function"
      ) {
        return true;
      }
      return $A.clientService.inFlightXHRs().length === 0;
    } catch (_e) {
      return true;
    }
  };

  const spinnerIdle = () => {
    try {
      const spinners = document.querySelectorAll(SPINNER_SELECTOR);
      for (const s of spinners) {
        const style = getComputedStyle(s);
        if (style.display !== "none" && style.visibility !== "hidden")
          return false;
      }
      return true;
    } catch (_e) {
      return true;
    }
  };

  const isStableNow = () => spinnerIdle() && auraIdle();

  const waitStable = (opts) => {
    opts = opts || {};
    const quietMs = typeof opts.quietMs === "number" ? opts.quietMs : 500;
    const timeoutMs =
      typeof opts.timeoutMs === "number" ? opts.timeoutMs : 15000;

    return new Promise((resolve, reject) => {
      const start = performance.now();
      let lastChange = performance.now();
      const bump = () => {
        lastChange = performance.now();
      };

      const mo = observeAll(document, bump);

      const cleanup = () => {
        try {
          mo.disconnect();
        } catch (_e) {
          /* already disconnected */
        }
      };

      const tick = () => {
        const now = performance.now();
        if (now - start > timeoutMs) {
          cleanup();
          return reject(new Error("frontier waitStable timeout"));
        }
        const quietFor = now - lastChange;
        if (quietFor >= quietMs && isStableNow()) {
          cleanup();
          return resolve({
            quietFor: Math.round(quietFor),
            totalMs: Math.round(now - start),
            signals: {
              aura: auraIdle() ? "idle" : "busy",
              spinners: spinnerIdle() ? "idle" : "visible",
            },
          });
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  };

  // ---- Public surface ----
  w.__frontier = {
    __version: VERSION,
    __installedAt: new Date().toISOString(),
    __destroy() {
      while (disposers.length) {
        const fn = disposers.pop();
        try {
          fn && fn();
        } catch (_e) {
          /* ignore disposer errors */
        }
      }
      try {
        delete w.__frontier;
      } catch (_e) {
        w.__frontier = undefined;
      }
    },
    summary() {
      return {
        version: VERSION,
        installedAt: this.__installedAt,
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        aura: {
          detected: !!w.$A,
          idle: auraIdle(),
        },
        spinners: {
          idle: spinnerIdle(),
        },
      };
    },
    observeAll,
    waitStable,
    isStableNow,
    toastWatcher: createToastWatcher(),
  };

  // ---- Toast watcher ----
  // Covers Salesforce toast variants. start() begins observation + clears
  // the seen list; drain() returns collected toasts and resets; stop()
  // disconnects the observer. Designed to bracket a single action: call
  // start() before the click, drain() after verification.
  function createToastWatcher() {
    const seen = [];
    let mo = null;
    const selectors = [
      "force-toast-container force-toast",
      "lightning-toast",
      ".toastContainer .toastMessage",
      ".slds-notify--toast",
      ".slds-notify_toast",
    ].join(", ");
    const classify = (el) => {
      const cls =
        (el.className || "").toString() +
        " " +
        (el.getAttribute("data-key") || "");
      if (/success/i.test(cls)) return "success";
      if (/error/i.test(cls)) return "error";
      if (/warning/i.test(cls)) return "warning";
      return "info";
    };
    const collect = () => {
      try {
        const nodes = document.querySelectorAll(selectors);
        for (const el of nodes) {
          const kind = classify(el);
          const text = (el.textContent || "").trim().slice(0, 240);
          const now = Date.now();
          const dupe = seen.some(
            (t) => t.kind === kind && t.text === text && now - t.at < 1500,
          );
          if (!dupe) seen.push({ kind, text, at: now });
        }
      } catch (_e) {
        /* ignore */
      }
    };
    return {
      start() {
        seen.length = 0;
        if (mo) {
          try {
            mo.disconnect();
          } catch (_e) {
            /* ignore */
          }
        }
        collect(); // catch any already-visible toast
        mo = new MutationObserver(collect);
        try {
          mo.observe(document.body, { childList: true, subtree: true });
        } catch (_e) {
          /* body may not exist yet at injection time — retry on next tick */
          setTimeout(() => {
            try {
              mo &&
                mo.observe(document.body, { childList: true, subtree: true });
            } catch (_e2) {
              /* give up */
            }
          }, 10);
        }
      },
      drain() {
        collect(); // capture any toasts that appeared between last tick and drain
        const out = seen.slice();
        seen.length = 0;
        return out;
      },
      stop() {
        if (mo) {
          try {
            mo.disconnect();
          } catch (_e) {
            /* ignore */
          }
          mo = null;
        }
      },
    };
  }
})();
