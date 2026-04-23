// RunPod GraphQL client.
//
// Wraps the single public endpoint at https://api.runpod.io/graphql and
// exposes typed helpers for the pod lifecycle operations we care about:
//   - listPods()      — fetch `myself.pods` + runtime metadata
//   - podStatus(id)   — same but filtered to a single pod
//   - stopPod(id)     — issue `podStop` mutation (preserves volume state)
//   - costSummary()   — aggregate list output (no separate endpoint)
//
// Auth: RUNPOD_API_KEY read from process.env first, then from a search path
// of sibling .env files. If the key is missing from all locations,
// construction THROWS with a clear "export RUNPOD_API_KEY ..." message so
// command handlers can surface it via failedResult().
//
// Search path (first hit wins):
//   1. process.env.RUNPOD_API_KEY
//   2. ~/code/labs/kaggle-nemotron/.env  (where the real key lives today,
//      per the user's Kaggle Nemotron project)
//   3. ~/frontier-os/.env                (standard frontier-os override)
//   4. ~/.env                            (home-level global env)
//
// Retry: transient network errors and 5xx responses are retried up to 3
// attempts with 500ms / 1s / 2s backoff. GraphQL-layer errors (the response
// has a non-empty `errors` array) are NOT retried — they indicate a schema
// mismatch or auth issue and the caller needs to see them immediately.
//
// Schema assumptions (documented here so fixing field names later is a
// single-file edit):
//
//   query Myself {
//     myself {
//       pods {
//         id
//         name
//         desiredStatus        # "RUNNING" | "EXITED" | "TERMINATED" | ...
//         costPerHr            # Float, USD/hour
//         machineId
//         imageName
//         podType
//         lastStatusChange     # ISO 8601 string — assumed field name
//         runtime {
//           ports {
//             ip
//             isIpPublic
//             privatePort
//             publicPort
//             type
//           }
//         }
//       }
//     }
//   }
//
//   mutation StopPod($input: PodStopInput!) {
//     podStop(input: $input) { id desiredStatus }
//   }
//
// If RunPod's real GraphQL schema uses a different field name for the
// last-status-change timestamp (e.g. `statusChangedAt`, `lastStateChange`),
// update MYSELF_PODS_QUERY and the `lastStatusChange` reference in
// normalizePod() below. The rest of the adapter stack reads from the
// normalized shape and won't need to change.

import {
  resolveCredential,
  KNOWN_ADAPTER_PATHS,
} from "../../core/credentials.ts";

/**
 * Resolve the RunPod API key. Checks process.env first, then the Kaggle
 * Nemotron .env (where the real key lives), then frontier-os/.env, then
 * ~/.env. Delegates to the shared credential resolver in core/credentials.
 * Exported for the idle-killer watcher's preflight check.
 */
export function resolveRunpodApiKey(): string | undefined {
  const extra = KNOWN_ADAPTER_PATHS["runpod"];
  const opts = extra ? { extraPaths: extra } : {};
  return resolveCredential("RUNPOD_API_KEY", opts);
}

export interface RunpodPort {
  ip: string | null;
  isIpPublic: boolean | null;
  privatePort: number | null;
  publicPort: number | null;
  type: string | null;
}

export interface RunpodRuntime {
  ports: RunpodPort[];
}

export interface RunpodPod {
  id: string;
  name: string | null;
  desiredStatus: string;
  costPerHr: number;
  machineId: string | null;
  imageName: string | null;
  podType: string | null;
  /** ISO 8601 string, or null if RunPod hasn't surfaced a timestamp yet. */
  lastStatusChange: string | null;
  runtime: RunpodRuntime | null;
}

export interface StopPodResult {
  id: string;
  desiredStatus: string;
}

const RUNPOD_GRAPHQL_ENDPOINT = "https://api.runpod.io/graphql";

const MYSELF_PODS_QUERY = `
query Myself {
  myself {
    pods {
      id
      name
      desiredStatus
      costPerHr
      machineId
      imageName
      podType
      lastStatusChange
      runtime {
        ports {
          ip
          isIpPublic
          privatePort
          publicPort
          type
        }
      }
    }
  }
}
`.trim();

const POD_STOP_MUTATION = `
mutation StopPod($input: PodStopInput!) {
  podStop(input: $input) {
    id
    desiredStatus
  }
}
`.trim();

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

interface MyselfQueryData {
  myself: {
    pods: unknown[] | null;
  } | null;
}

interface PodStopMutationData {
  podStop: {
    id: string;
    desiredStatus: string;
  } | null;
}

/** Thrown from the constructor when RUNPOD_API_KEY is missing. */
export class RunpodMissingCredentialsError extends Error {
  constructor() {
    super(
      "RUNPOD_API_KEY not set — export it or add to frontier-os/.env to enable",
    );
    this.name = "RunpodMissingCredentialsError";
  }
}

/** Thrown when the GraphQL response contains an `errors` array. */
export class RunpodGraphQLError extends Error {
  readonly errors: Array<{ message: string; path?: Array<string | number> }>;
  constructor(
    errors: Array<{ message: string; path?: Array<string | number> }>,
  ) {
    const summary = errors.map((e) => e.message).join("; ");
    super(`RunPod GraphQL error: ${summary}`);
    this.name = "RunpodGraphQLError";
    this.errors = errors;
  }
}

/** Thrown when we exhaust retries against the HTTP transport. */
export class RunpodTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RunpodTransportError";
    if (status !== undefined) this.status = status;
  }
}

export interface RunpodClientOptions {
  /** Override the endpoint for testing. Defaults to the real RunPod URL. */
  endpoint?: string;
  /** Max retry attempts for transient failures. Default 3. */
  maxAttempts?: number;
  /** Override fetch for testing. Defaults to global fetch (Node 22). */
  fetchImpl?: typeof fetch;
}

function isTransient(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePod(raw: unknown): RunpodPod {
  const p = (raw ?? {}) as Record<string, unknown>;
  const runtimeRaw = p["runtime"] as Record<string, unknown> | null | undefined;
  let runtime: RunpodRuntime | null = null;
  if (runtimeRaw && typeof runtimeRaw === "object") {
    const portsRaw = runtimeRaw["ports"];
    const ports: RunpodPort[] = Array.isArray(portsRaw)
      ? portsRaw.map((pr) => {
          const x = (pr ?? {}) as Record<string, unknown>;
          return {
            ip: typeof x["ip"] === "string" ? (x["ip"] as string) : null,
            isIpPublic:
              typeof x["isIpPublic"] === "boolean"
                ? (x["isIpPublic"] as boolean)
                : null,
            privatePort:
              typeof x["privatePort"] === "number"
                ? (x["privatePort"] as number)
                : null,
            publicPort:
              typeof x["publicPort"] === "number"
                ? (x["publicPort"] as number)
                : null,
            type: typeof x["type"] === "string" ? (x["type"] as string) : null,
          };
        })
      : [];
    runtime = { ports };
  }
  return {
    id: String(p["id"] ?? ""),
    name: typeof p["name"] === "string" ? (p["name"] as string) : null,
    desiredStatus: String(p["desiredStatus"] ?? "UNKNOWN"),
    costPerHr:
      typeof p["costPerHr"] === "number" ? (p["costPerHr"] as number) : 0,
    machineId:
      typeof p["machineId"] === "string" ? (p["machineId"] as string) : null,
    imageName:
      typeof p["imageName"] === "string" ? (p["imageName"] as string) : null,
    podType: typeof p["podType"] === "string" ? (p["podType"] as string) : null,
    lastStatusChange:
      typeof p["lastStatusChange"] === "string"
        ? (p["lastStatusChange"] as string)
        : null,
    runtime,
  };
}

export class RunpodClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RunpodClientOptions = {}) {
    const apiKey = resolveRunpodApiKey();
    if (!apiKey || apiKey.trim() === "") {
      throw new RunpodMissingCredentialsError();
    }
    this.apiKey = apiKey;
    this.endpoint = options.endpoint ?? RUNPOD_GRAPHQL_ENDPOINT;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Low-level GraphQL call with retry on transient transport errors. */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const backoffs = [500, 1000, 2000];
    let lastErr: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ query, variables }),
        });

        if (!response.ok) {
          if (isTransient(response.status) && attempt < this.maxAttempts - 1) {
            lastErr = new RunpodTransportError(
              `HTTP ${response.status} ${response.statusText}`,
              response.status,
            );
            await sleep(backoffs[attempt] ?? 2000);
            continue;
          }
          throw new RunpodTransportError(
            `HTTP ${response.status} ${response.statusText}`,
            response.status,
          );
        }

        const body = (await response.json()) as GraphQLResponse<T>;
        if (body.errors && body.errors.length > 0) {
          // GraphQL-layer errors are NOT retried — they indicate schema/auth
          // mismatch and retrying will just make it worse.
          throw new RunpodGraphQLError(body.errors);
        }
        if (body.data === undefined) {
          throw new RunpodTransportError("RunPod response missing `data`");
        }
        return body.data;
      } catch (err) {
        lastErr = err;
        // Only retry transport-level failures. GraphQL errors bubble up.
        if (err instanceof RunpodGraphQLError) throw err;
        if (err instanceof RunpodTransportError && err.status !== undefined) {
          if (!isTransient(err.status) || attempt >= this.maxAttempts - 1) {
            throw err;
          }
        }
        if (attempt >= this.maxAttempts - 1) break;
        await sleep(backoffs[attempt] ?? 2000);
      }
    }

    if (lastErr instanceof Error) throw lastErr;
    throw new RunpodTransportError("RunPod request failed for unknown reason");
  }

  /** Fetch all pods for the authenticated user. */
  async listPods(): Promise<RunpodPod[]> {
    const data = await this.graphql<MyselfQueryData>(MYSELF_PODS_QUERY);
    const rawPods = data.myself?.pods ?? [];
    return rawPods.map(normalizePod);
  }

  /** Fetch a single pod by id. Returns null if not found. */
  async podStatus(podId: string): Promise<RunpodPod | null> {
    const pods = await this.listPods();
    return pods.find((p) => p.id === podId) ?? null;
  }

  /** Stop a running pod. Preserves state; does NOT destroy the volume. */
  async stopPod(podId: string): Promise<StopPodResult> {
    const data = await this.graphql<PodStopMutationData>(POD_STOP_MUTATION, {
      input: { podId },
    });
    if (!data.podStop) {
      throw new RunpodTransportError(
        `podStop returned null for podId=${podId}`,
      );
    }
    return {
      id: data.podStop.id,
      desiredStatus: data.podStop.desiredStatus,
    };
  }
}

/** Convenience wrapper — construct a client, surface the auth error cleanly. */
export function createRunpodClient(
  options: RunpodClientOptions = {},
): RunpodClient {
  return new RunpodClient(options);
}
