import { attach, evaluate, type CdpAttachOptions } from "../cdp.ts";
import { buildResult } from "../../../result.ts";
import type { AdapterInvocation, AdapterResult } from "../../../schemas.ts";

interface InspectNetworkArgs extends CdpAttachOptions {
  sampleMs?: number;
  maxResources?: number;
  maxLiveRequests?: number;
}

interface PerformanceNetworkResource {
  url: string;
  origin: string | null;
  initiatorType: string | null;
  startTimeMs: number | null;
  durationMs: number | null;
  transferSize: number | null;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  nextHopProtocol: string | null;
  renderBlockingStatus: string | null;
  responseStatus: number | null;
}

interface NavigationNetworkResource {
  url: string;
  origin: string | null;
  type: string | null;
  startTimeMs: number | null;
  durationMs: number | null;
  transferSize: number | null;
  encodedBodySize: number | null;
  decodedBodySize: number | null;
  nextHopProtocol: string | null;
  responseStatus: number | null;
  domContentLoadedEventEndMs: number | null;
  loadEventEndMs: number | null;
}

interface PageNetworkSnapshot {
  capturedAt: string;
  readyState: string;
  online: boolean;
  title: string;
  url: string;
  resourceCountTotal: number;
  resources: PerformanceNetworkResource[];
  navigation: NavigationNetworkResource | null;
}

interface LiveNetworkRecord {
  requestId: string;
  url: string;
  origin: string | null;
  method: string | null;
  resourceType: string | null;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  protocol: string | null;
  remoteIpAddress: string | null;
  fromDiskCache: boolean;
  fromServiceWorker: boolean;
  servedFromCache: boolean;
  failed: boolean;
  errorText: string | null;
  encodedDataLength: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  sequence: number;
}

const DEFAULT_SAMPLE_MS = 750;
const DEFAULT_MAX_RESOURCES = 50;
const DEFAULT_MAX_LIVE_REQUESTS = 25;
const MAX_ALLOWED_SAMPLE_MS = 5000;
const MAX_ALLOWED_RESOURCES = 200;
const MAX_ALLOWED_LIVE_REQUESTS = 100;

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originForUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function summarizeOrigins(urls: Array<string | null | undefined>): Array<{
  origin: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const origin = originForUrl(url);
    if (!origin) continue;
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin));
}

function topStatusCounts(records: LiveNetworkRecord[]): Array<{
  status: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = record.failed
      ? `failed:${record.errorText ?? "unknown"}`
      : record.status !== null
        ? String(record.status)
        : "pending";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export async function inspectNetworkCommand(
  invocation: AdapterInvocation,
): Promise<AdapterResult> {
  const args = (invocation.arguments ?? {}) as InspectNetworkArgs;
  const sampleMs = clampInteger(
    args.sampleMs,
    DEFAULT_SAMPLE_MS,
    0,
    MAX_ALLOWED_SAMPLE_MS,
  );
  const maxResources = clampInteger(
    args.maxResources,
    DEFAULT_MAX_RESOURCES,
    1,
    MAX_ALLOWED_RESOURCES,
  );
  const maxLiveRequests = clampInteger(
    args.maxLiveRequests,
    DEFAULT_MAX_LIVE_REQUESTS,
    1,
    MAX_ALLOWED_LIVE_REQUESTS,
  );

  const session = await attach(args);
  try {
    const snapshot = await evaluate<PageNetworkSnapshot>(session, {
      expression: `
        (() => {
          const maxResources = ${JSON.stringify(maxResources)};
          const asNumber = (value) =>
            typeof value === 'number' && Number.isFinite(value)
              ? Math.round(value * 1000) / 1000
              : null;
          const asString = (value) =>
            typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
          const toOrigin = (value) => {
            try {
              return new URL(value, location.href).origin;
            } catch {
              return null;
            }
          };
          const summarize = (entry) => ({
            url: entry.name,
            origin: toOrigin(entry.name),
            initiatorType: asString(entry.initiatorType),
            startTimeMs: asNumber(entry.startTime),
            durationMs: asNumber(entry.duration),
            transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
            encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
            decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
            nextHopProtocol: asString(entry.nextHopProtocol),
            renderBlockingStatus: asString(entry.renderBlockingStatus),
            responseStatus: Number.isFinite(entry.responseStatus) ? entry.responseStatus : null,
          });
          const resources = performance
            .getEntriesByType('resource')
            .map(summarize)
            .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0))
            .slice(0, maxResources);
          const navigationEntry = performance.getEntriesByType('navigation')[0];
          const navigation = navigationEntry
            ? {
                url: location.href,
                origin: toOrigin(location.href),
                type: asString(navigationEntry.type),
                startTimeMs: asNumber(navigationEntry.startTime),
                durationMs: asNumber(navigationEntry.duration),
                transferSize: Number.isFinite(navigationEntry.transferSize)
                  ? navigationEntry.transferSize
                  : null,
                encodedBodySize: Number.isFinite(navigationEntry.encodedBodySize)
                  ? navigationEntry.encodedBodySize
                  : null,
                decodedBodySize: Number.isFinite(navigationEntry.decodedBodySize)
                  ? navigationEntry.decodedBodySize
                  : null,
                nextHopProtocol: asString(navigationEntry.nextHopProtocol),
                responseStatus: Number.isFinite(navigationEntry.responseStatus)
                  ? navigationEntry.responseStatus
                  : null,
                domContentLoadedEventEndMs: asNumber(
                  navigationEntry.domContentLoadedEventEnd,
                ),
                loadEventEndMs: asNumber(navigationEntry.loadEventEnd),
              }
            : null;
          return {
            capturedAt: new Date().toISOString(),
            readyState: document.readyState,
            online: navigator.onLine,
            title: document.title,
            url: location.href,
            resourceCountTotal: performance.getEntriesByType('resource').length,
            resources,
            navigation,
          };
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    });

    const liveRecords = new Map<string, LiveNetworkRecord>();
    let nextSequence = 0;
    const remember = (requestId: string): LiveNetworkRecord => {
      const existing = liveRecords.get(requestId);
      if (existing) return existing;
      const created: LiveNetworkRecord = {
        requestId,
        url: "",
        origin: null,
        method: null,
        resourceType: null,
        status: null,
        statusText: null,
        mimeType: null,
        protocol: null,
        remoteIpAddress: null,
        fromDiskCache: false,
        fromServiceWorker: false,
        servedFromCache: false,
        failed: false,
        errorText: null,
        encodedDataLength: null,
        startedAt: null,
        finishedAt: null,
        sequence: nextSequence++,
      };
      liveRecords.set(requestId, created);
      return created;
    };

    const { Network } = session.client;
    await Network.enable({});
    Network.requestWillBeSent((params: {
      requestId: string;
      type?: string;
      request?: { url?: string; method?: string };
      wallTime?: number;
    }) => {
      const record = remember(params.requestId);
      if (typeof params.request?.url === "string") {
        record.url = params.request.url;
        record.origin = originForUrl(params.request.url);
      }
      if (typeof params.request?.method === "string") {
        record.method = params.request.method;
      }
      if (typeof params.type === "string") {
        record.resourceType = params.type;
      }
      if (record.startedAt === null) {
        record.startedAt =
          typeof params.wallTime === "number"
            ? new Date(params.wallTime * 1000).toISOString()
            : new Date().toISOString();
      }
    });
    Network.responseReceived((params: {
      requestId: string;
      type?: string;
      response?: {
        url?: string;
        status?: number;
        statusText?: string;
        mimeType?: string;
        protocol?: string;
        remoteIPAddress?: string;
        fromDiskCache?: boolean;
        fromServiceWorker?: boolean;
      };
    }) => {
      const record = remember(params.requestId);
      if (typeof params.type === "string") {
        record.resourceType = params.type;
      }
      if (typeof params.response?.url === "string") {
        record.url = params.response.url;
        record.origin = originForUrl(params.response.url);
      }
      record.status =
        typeof params.response?.status === "number" ? params.response.status : null;
      record.statusText =
        typeof params.response?.statusText === "string"
          ? params.response.statusText
          : null;
      record.mimeType =
        typeof params.response?.mimeType === "string"
          ? params.response.mimeType
          : null;
      record.protocol =
        typeof params.response?.protocol === "string"
          ? params.response.protocol
          : null;
      record.remoteIpAddress =
        typeof params.response?.remoteIPAddress === "string"
          ? params.response.remoteIPAddress
          : null;
      record.fromDiskCache = Boolean(params.response?.fromDiskCache);
      record.fromServiceWorker = Boolean(params.response?.fromServiceWorker);
      if (record.startedAt === null) {
        record.startedAt = new Date().toISOString();
      }
    });
    Network.requestServedFromCache((params: { requestId: string }) => {
      remember(params.requestId).servedFromCache = true;
    });
    Network.loadingFinished((params: {
      requestId: string;
      encodedDataLength?: number;
    }) => {
      const record = remember(params.requestId);
      record.finishedAt = new Date().toISOString();
      record.encodedDataLength =
        typeof params.encodedDataLength === "number"
          ? params.encodedDataLength
          : record.encodedDataLength;
    });
    Network.loadingFailed((params: {
      requestId: string;
      errorText?: string;
    }) => {
      const record = remember(params.requestId);
      record.failed = true;
      record.errorText =
        typeof params.errorText === "string" ? params.errorText : "loading failed";
      record.finishedAt = new Date().toISOString();
    });

    if (sampleMs > 0) {
      await wait(sampleMs);
    }
    await Network.disable();

    const liveRequests = [...liveRecords.values()]
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, maxLiveRequests)
      .map((record) => ({
        ...record,
        url: record.url || "(unknown)",
      }));

    const failedLiveRequests = liveRequests.filter((record) => record.failed).length;
    const cacheHits = liveRequests.filter(
      (record) =>
        record.fromDiskCache || record.fromServiceWorker || record.servedFromCache,
    ).length;
    const resourceOrigins = summarizeOrigins(snapshot.resources.map((item) => item.url));
    const liveOrigins = summarizeOrigins(liveRequests.map((item) => item.url));

    return buildResult({
      invocation,
      status: "success",
      summary: `captured ${snapshot.resources.length}/${snapshot.resourceCountTotal} recent resources and ${liveRequests.length} live requests from ${session.target.url}`,
      observedState: {
        targetId: session.target.id,
        title: snapshot.title,
        url: snapshot.url,
        helperInstalled: session.helperInstalled,
        sampledForMs: sampleMs,
        maxResources,
        maxLiveRequests,
        resourceCountTotal: snapshot.resourceCountTotal,
        recentResources: snapshot.resources,
        navigation: snapshot.navigation,
        liveRequests,
        liveRequestFailures: failedLiveRequests,
        liveCacheHits: cacheHits,
        topResourceOrigins: resourceOrigins.slice(0, 10),
        topLiveOrigins: liveOrigins.slice(0, 10),
        liveStatuses: topStatusCounts(liveRequests).slice(0, 10),
        readyState: snapshot.readyState,
        online: snapshot.online,
        capturedAt: snapshot.capturedAt,
      },
      artifacts: [
        {
          kind: "url",
          ref: snapshot.url,
          note: "network inspection target",
        },
        {
          kind: "trace",
          ref: `${session.target.id}#network`,
          note: `${snapshot.resources.length} recent resources, ${liveRequests.length} live requests`,
        },
      ],
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
      suggestedNextActions:
        liveRequests.length === 0 && snapshot.resources.length === 0
          ? [
              "page is network-idle and exposes no resource timing entries; rerun with a live target or larger sampleMs if you need fresh traffic",
            ]
          : [],
    });
  } finally {
    await session.close();
  }
}
