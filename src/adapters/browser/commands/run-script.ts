import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface RunScriptArgs extends CdpAttachOptions {
  /** A JavaScript expression to evaluate inside the target page. */
  expression: string;
  awaitPromise?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_EXPRESSION_LENGTH = 20_000;

export async function runScriptCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as unknown as RunScriptArgs;
  if (typeof args.expression !== "string" || args.expression.length === 0) {
    throw new Error(
      "run-script requires `arguments.expression` (non-empty string)",
    );
  }
  if (args.expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(
      `run-script expression exceeds ${MAX_EXPRESSION_LENGTH} chars`,
    );
  }

  const session = await attach(args);
  try {
    // Wrap the user expression in a safe boundary: evaluate as an async IIFE,
    // `await` the inner expression so user promises resolve, catch exceptions,
    // and serialize the result to JSON in-page so CDP never tries to
    // deep-serialize a DOM node or a Promise.
    const wrapped = `
      (async () => {
        try {
          const __r = await (${args.expression});
          return { ok: true, value: JSON.parse(JSON.stringify(__r ?? null)) };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      })()
    `;
    const evalOpts: Parameters<typeof evaluate>[1] = {
      expression: wrapped,
      awaitPromise: args.awaitPromise ?? true,
      returnByValue: true,
    };
    if (args.timeoutMs !== undefined) {
      evalOpts.timeout = args.timeoutMs;
    } else {
      evalOpts.timeout = DEFAULT_TIMEOUT_MS;
    }
    const result = await evaluate<
      { ok: true; value: unknown } | { ok: false; error: string }
    >(session, evalOpts);

    if (!result.ok) {
      return buildResult({
        invocation,
        status: "failed",
        summary: `script threw: ${result.error}`,
        observedState: {
          targetId: session.target.id,
          url: session.target.url,
        },
      });
    }
    return buildResult({
      invocation,
      status: "success",
      summary: `script evaluated in "${session.target.title}"`,
      observedState: {
        targetId: session.target.id,
        url: session.target.url,
        value: result.value,
      },
      sideEffects: [
        {
          class: "shared_write",
          target: session.target.url,
          summary:
            "bounded JS eval in active page context (may have page-side effects depending on expression)",
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
