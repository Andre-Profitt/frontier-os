import { attach, type CdpAttachOptions } from "../cdp.ts";
import { captureDomTree, type CaptureOptions } from "../inject/dom-tree.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface InspectDomArgs extends CdpAttachOptions, CaptureOptions {
  /** If true, install the frontier page-side helper before capturing. Default true. */
  withHelper?: boolean;
}

export async function inspectDomCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as InspectDomArgs;

  const attachOpts: CdpAttachOptions = {};
  if (args.host !== undefined) attachOpts.host = args.host;
  if (args.port !== undefined) attachOpts.port = args.port;
  if (args.target !== undefined) attachOpts.target = args.target;
  attachOpts.installHelper = args.withHelper ?? true;

  const session = await attach(attachOpts);
  try {
    const captureOpts: CaptureOptions = {};
    if (args.maxDepth !== undefined) captureOpts.maxDepth = args.maxDepth;
    if (args.maxNodes !== undefined) captureOpts.maxNodes = args.maxNodes;
    if (args.elementNodesOnly !== undefined)
      captureOpts.elementNodesOnly = args.elementNodesOnly;
    if (args.rootSelector !== undefined)
      captureOpts.rootSelector = args.rootSelector;

    const snapshot = await captureDomTree(session, captureOpts);

    return buildResult({
      invocation,
      status: "success",
      summary: `captured ${snapshot.totalNodes} nodes${
        snapshot.truncated ? " (truncated)" : ""
      } from ${session.target.url} (${snapshot.interactiveNodes} interactive${
        snapshot.shadowRootsSeen > 0
          ? `, ${snapshot.shadowRootsSeen} shadow roots`
          : ""
      }${snapshot.iframesSeen > 0 ? `, ${snapshot.iframesSeen} iframes` : ""})`,
      observedState: {
        targetId: session.target.id,
        url: session.target.url,
        helperInstalled: session.helperInstalled,
        totalNodes: snapshot.totalNodes,
        interactiveNodes: snapshot.interactiveNodes,
        truncated: snapshot.truncated,
        shadowRootsSeen: snapshot.shadowRootsSeen,
        iframesSeen: snapshot.iframesSeen,
        tree: snapshot.root,
      },
      artifacts: [
        {
          kind: "dom_snapshot",
          ref: `${session.target.id}#${args.rootSelector ?? "body"}`,
          note: `${snapshot.totalNodes} nodes, ${snapshot.interactiveNodes} interactive`,
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
