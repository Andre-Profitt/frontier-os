import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { attach, type CdpAttachOptions } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface CaptureScreenshotArgs extends CdpAttachOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number; // only meaningful for jpeg/webp
  fullPage?: boolean;
  outDir?: string;
}

const DEFAULT_OUT_DIR = resolve(
  process.env.HOME ?? ".",
  ".frontier",
  "artifacts",
);

export async function captureScreenshotCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as CaptureScreenshotArgs;
  const format = args.format ?? "png";
  const fullPage = args.fullPage ?? false;
  const outDir = args.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });

  const session = await attach(args);
  try {
    const { Page } = session.client;
    await Page.enable();
    const shotOpts: any = {
      format,
      captureBeyondViewport: fullPage,
    };
    if (format !== "png" && args.quality !== undefined) {
      shotOpts.quality = args.quality;
    }
    const { data } = await Page.captureScreenshot(shotOpts);

    const filename = `screenshot_${invocation.invocationId}.${format}`;
    const path = resolve(outDir, filename);
    writeFileSync(path, Buffer.from(data, "base64"));

    return buildResult({
      invocation,
      status: "success",
      summary: `captured ${format} screenshot of "${session.target.title}"`,
      observedState: {
        targetId: session.target.id,
        url: session.target.url,
        format,
        fullPage,
        bytes: data.length,
        path,
      },
      artifacts: [
        {
          kind: "screenshot",
          ref: path,
          note: `${format} screenshot of ${session.target.url}`,
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
