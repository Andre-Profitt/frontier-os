// Node-side helper installer.
//
// Takes a live CdpSession and ensures the page-side helper (inject/helper.js)
// is installed in:
//   1. every new document loaded after this call (Page.addScriptToEvaluateOnNewDocument)
//   2. the currently-loaded document (direct Runtime.evaluate)
//   3. every out-of-process iframe that attaches (Target.setAutoAttach + sessionattached)
//   4. every SPA soft-navigation in the top frame (Page.frameNavigated re-eval safety net)
//
// The helper is idempotent — re-evaluating the source on a page that already
// has the same version installed is a no-op, so the belt-and-suspenders
// strategy above never causes duplicate install damage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { CdpSession } from "../cdp.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HELPER_PATH = resolve(__dirname, "helper.js");

let cachedHelperSrc: string | null = null;

function getHelperSrc(): string {
  if (cachedHelperSrc === null) {
    cachedHelperSrc = readFileSync(HELPER_PATH, "utf8");
  }
  return cachedHelperSrc;
}

export interface InstalledHelper {
  /** Identifier returned by Page.addScriptToEvaluateOnNewDocument. */
  scriptIdentifier: string;
  /** Disables the persistent injection and removes listeners. */
  close(): Promise<void>;
}

export async function installHelper(
  session: CdpSession,
): Promise<InstalledHelper> {
  const { Page, Runtime, Target } = session.client;
  const src = getHelperSrc();

  // 1. Enable the domains we need.
  await Promise.all([
    Page.enable(),
    Runtime.enable(),
    Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }),
  ]);

  // 2. Register for every new document from now on.
  const { identifier } = await Page.addScriptToEvaluateOnNewDocument({
    source: src,
    // runImmediately runs the script for the already-loaded document as well
    // as any new one. Supported in modern CDP; we still do an explicit
    // Runtime.evaluate below because runImmediately can silently no-op on
    // some frames.
    runImmediately: true,
  });

  // 3. Evaluate immediately in the current top-frame document so the helper
  //    is live before the first command runs against it.
  try {
    await Runtime.evaluate({
      expression: src,
      awaitPromise: false,
      returnByValue: true,
    });
  } catch (err) {
    // Non-fatal: if the current document is still loading we'll catch up on
    // frameNavigated below.
  }

  // 4. Re-install on every child session that attaches (OOPIFs, workers).
  const sessionAttachedHandler = async (params: {
    sessionId: string;
    targetInfo: { type: string };
    waitingForDebugger: boolean;
  }) => {
    // We only care about frame targets here; service workers don't render.
    if (
      params.targetInfo.type !== "iframe" &&
      params.targetInfo.type !== "page"
    ) {
      return;
    }
    try {
      await session.client.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: src, runImmediately: true },
        params.sessionId,
      );
    } catch (_e) {
      // Some child targets do not support the Page domain — safe to ignore.
    }
  };
  // chrome-remote-interface surfaces session lifecycle via Target.attachedToTarget
  // when autoAttach+flatten is enabled.
  // @ts-ignore — CRI type shim doesn't expose the raw event name here
  session.client.on("Target.attachedToTarget", sessionAttachedHandler);

  // 5. Re-eval on every top-frame navigation. This is the safety net for SPA
  //    soft-nav (pushState) where Page.addScriptToEvaluateOnNewDocument's
  //    "new document" semantics don't fire. The helper's idempotency guard
  //    makes re-eval free if it's already there.
  const frameNavigatedHandler = async (params: {
    frame: { id: string; parentId?: string; url: string };
  }) => {
    if (params.frame.parentId) return; // top frame only
    try {
      await Runtime.evaluate({
        expression: src,
        awaitPromise: false,
        returnByValue: true,
      });
    } catch (_e) {
      /* target may be gone */
    }
  };
  // @ts-ignore — event name routing differs between CDP event style and CRI listener style
  Page.frameNavigated(frameNavigatedHandler);

  return {
    scriptIdentifier: identifier,
    async close() {
      try {
        await Page.removeScriptToEvaluateOnNewDocument({
          identifier,
        });
      } catch (_e) {
        /* already detached */
      }
      // chrome-remote-interface doesn't expose individual listener removal
      // for domain events; relying on the session-level close() to drop all
      // listeners when the session goes away.
    },
  };
}
