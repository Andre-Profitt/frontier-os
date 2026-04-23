// CDP Network.* event subscription — awaits an XHR/fetch that matches a
// URL regex + optional method + optional status predicate.
//
// Subscribed to:
//   Network.requestWillBeSent  -- captures request metadata by requestId
//   Network.responseReceived   -- fires when a server response arrives
//   Network.loadingFailed      -- fires when a request fails at the protocol
//                                  level (DNS, CORS, connection refused)
//
// A matcher with statusPredicate defaults to "any status > 0" so a 404 or
// 500 response counts as a match — the loop's job is to confirm the server
// saw the request, not to infer semantic success. Commands that need HTTP
// success should pass `{statusPredicate: (s) => s >= 200 && s < 400}`.

import type { CdpSession } from "../cdp.ts";

export interface NetworkMatcher {
  /** URL regex — matched against the response URL (falls back to request URL). */
  urlRegex: RegExp;
  /** Optional HTTP method filter, case-insensitive. */
  method?: string;
  /** Optional status code predicate. Default: any status > 0 (any server response). */
  statusPredicate?: (status: number) => boolean;
  /** If true, loadingFailed events also count as a match (useful when the
   *  server is expected to be unreachable but we still want to confirm the
   *  client attempted the fetch). Default false. */
  acceptLoadingFailed?: boolean;
}

export interface NetworkMatchResult {
  requestId: string;
  url: string;
  method: string;
  /** HTTP status code, or 0 if matched via loadingFailed. */
  status: number;
  /** When the match resolved, in ms since epoch. */
  matchedAtMs: number;
  /** The CDP event kind that produced the match. */
  source: "responseReceived" | "loadingFailed";
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function awaitNetworkMatch(
  session: CdpSession,
  matcher: NetworkMatcher,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<NetworkMatchResult> {
  const { Network } = session.client;
  await Network.enable({ maxTotalBufferSize: 10_000_000 });

  return new Promise<NetworkMatchResult>((resolve, reject) => {
    interface Started {
      url: string;
      method: string;
    }
    const started = new Map<string, Started>();
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const settle = (result: NetworkMatchResult | Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const matchesUrl = (url: string): boolean => matcher.urlRegex.test(url);

    const matchesMethod = (method: string): boolean => {
      if (!matcher.method) return true;
      return method.toUpperCase() === matcher.method.toUpperCase();
    };

    const matchesStatus = (status: number): boolean => {
      if (matcher.statusPredicate) return matcher.statusPredicate(status);
      return status > 0;
    };

    const onRequestWillBeSent = (params: {
      requestId: string;
      request: { url: string; method: string };
    }): void => {
      started.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
      });
    };

    const onResponseReceived = (params: {
      requestId: string;
      response: { status: number; url?: string };
    }): void => {
      const start = started.get(params.requestId);
      const url = params.response.url ?? start?.url ?? "";
      const method = start?.method ?? "GET";
      const status = params.response.status;
      if (!matchesUrl(url)) return;
      if (!matchesMethod(method)) return;
      if (!matchesStatus(status)) return;
      settle({
        requestId: params.requestId,
        url,
        method,
        status,
        matchedAtMs: Date.now(),
        source: "responseReceived",
      });
    };

    const onLoadingFailed = (params: {
      requestId: string;
      errorText?: string;
    }): void => {
      if (!matcher.acceptLoadingFailed) return;
      const start = started.get(params.requestId);
      if (!start) return;
      if (!matchesUrl(start.url)) return;
      if (!matchesMethod(start.method)) return;
      settle({
        requestId: params.requestId,
        url: start.url,
        method: start.method,
        status: 0,
        matchedAtMs: Date.now(),
        source: "loadingFailed",
      });
    };

    // CRI exposes CDP events via callable listeners on the domain object.
    // There's no clean off() — the session close when the command finishes
    // drops all listeners.
    // @ts-ignore — CRI listener typing is loose on the event name form
    Network.requestWillBeSent(onRequestWillBeSent);
    // @ts-ignore
    Network.responseReceived(onResponseReceived);
    // @ts-ignore
    Network.loadingFailed(onLoadingFailed);

    timer = setTimeout(() => {
      settle(
        new Error(
          `awaitNetworkMatch timeout after ${timeoutMs}ms for ${matcher.urlRegex}`,
        ),
      );
    }, timeoutMs);
  });
}
