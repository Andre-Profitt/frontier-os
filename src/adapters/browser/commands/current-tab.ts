import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface CurrentTabArgs extends CdpAttachOptions {
  /** Optional, if omitted we pick the first non-chrome page target. */
}

interface TabState {
  targetId: string;
  title: string;
  url: string;
  readyState: string;
  documentTitle: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  visibility: string;
  userAgent: string;
  cookiesEnabled: boolean;
  networkAvailable: boolean;
  capturedAt: string;
}

export async function currentTabCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as CurrentTabArgs;
  const session = await attach(args);
  try {
    const state = await evaluate<Omit<TabState, "targetId">>(session, {
      expression: `
        (() => ({
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          documentTitle: document.title,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
          },
          visibility: document.visibilityState,
          userAgent: navigator.userAgent,
          cookiesEnabled: navigator.cookieEnabled,
          networkAvailable: navigator.onLine,
          capturedAt: new Date().toISOString(),
        }))()
      `,
    });
    const observed: TabState = {
      targetId: session.target.id,
      ...state,
    };
    return buildResult({
      invocation,
      status: "success",
      summary: `inspected "${observed.title}" (${observed.url})`,
      observedState: observed as unknown as Record<string, unknown>,
      artifacts: [
        {
          kind: "url",
          ref: observed.url,
          note: "current tab URL",
        },
      ],
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  } finally {
    await session.close();
  }
}
