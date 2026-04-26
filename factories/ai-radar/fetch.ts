// factories/ai-radar/fetch.ts
//
// Tiny HTTP GET wrapper with timeout, body cap, and a fixed user-agent.
// Returns a normalized `FetchResult` rather than throwing — callers
// translate the result into per-source classification.
//
// Unit tests mock through the `Fetcher` interface; live network is
// only exercised in the `FACTORY_LIVE=1` smoke path of run.test.ts.

export interface FetchResult {
  status: number;
  body: string;
  bytes: number;
  /** null on success or capped success; non-null on transport failure. */
  error: string | null;
  /** true when the body was capped at maxBytes. */
  truncated: boolean;
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  headers?: Record<string, string>;
}

export type Fetcher = (url: string, opts: FetchOptions) => Promise<FetchResult>;

export const httpGet: Fetcher = async (url, opts) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": opts.userAgent,
        accept: "*/*",
        ...(opts.headers ?? {}),
      },
      signal: controller.signal,
      redirect: "follow",
    });

    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      const bytes = Buffer.byteLength(text, "utf8");
      return {
        status: res.status,
        body: text,
        bytes,
        error: null,
        truncated: false,
      };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = Buffer.from(step.value);
      total += chunk.byteLength;
      if (total > opts.maxBytes) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // best effort
        }
        break;
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    return {
      status: res.status,
      body: buf.toString("utf8"),
      bytes: buf.byteLength,
      error: null,
      truncated,
    };
  } catch (e) {
    const err = e as Error & { name?: string };
    const isAbort = err.name === "AbortError" || /aborted/i.test(err.message);
    return {
      status: 0,
      body: "",
      bytes: 0,
      error: isAbort ? "timeout" : err.message,
      truncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
};
