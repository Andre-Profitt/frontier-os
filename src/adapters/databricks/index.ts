// Databricks adapter — thin REST wrapper over the workspace REST API.
//
// Why a hand-rolled wrapper rather than an SDK: there is no first-party
// TypeScript/JavaScript SDK for Databricks that matches the Frontier OS
// adapter shape (non-throwing, manifest-declared commands, structured
// observedState). Node 22's global fetch is plenty for five read-only GETs.
//
// Design notes:
// - Read-only in v1. Every command is idempotent; sideEffectClass=none. Writes
//   (create-cluster, run-now, workspace import, etc.) are a future phase and
//   will require a new manifest + a separate approval class.
// - Credentials come from ~/.databrickscfg [DEFAULT] by default. Env vars
//   FRONTIER_DATABRICKS_HOST / FRONTIER_DATABRICKS_TOKEN override.
// - Never throws. All failure modes (no cfg, 401, 404, timeout) return a
//   status=failed AdapterResult with a specific hint in observedState so
//   callers can diagnose without tailing executor logs.
// - No retries. Read-only GETs against a known-reachable host either succeed
//   or fail fast; the caller can re-invoke. Adding retries here duplicates
//   policy that belongs higher up.
//
// Endpoints used (all GET):
//   /api/2.0/preview/scim/v2/Me             — whoami
//   /api/2.1/clusters/list                  — list-clusters
//   /api/2.2/jobs/list?limit=20             — list-jobs
//   /api/2.2/jobs/get?job_id=N              — job-status (settings)
//   /api/2.2/jobs/runs/list?job_id=N&limit=5— job-status (recent runs)
//   /api/2.0/workspace/list?path=<path>     — workspace-ls

import { adapterCommandSpec, type AdapterImpl } from "../../registry.ts";
import { buildResult, failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";

import { resolveDatabricksCreds, type DatabricksCredsOk } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_JOB_LIMIT = 20;
const DEFAULT_CLUSTER_LIMIT = 20;
const DEFAULT_RUNS_LIMIT = 5;

// ---- transport ----

interface DbxFetchOk {
  ok: true;
  status: number;
  body: unknown;
}
interface DbxFetchErr {
  ok: false;
  status?: number;
  reason: string;
  hint: string;
  body?: unknown;
}
type DbxFetchResult = DbxFetchOk | DbxFetchErr;

/** GET a Databricks REST endpoint. Never throws. */
async function dbxGet(
  creds: DatabricksCredsOk,
  pathWithQuery: string,
  timeoutMs: number,
): Promise<DbxFetchResult> {
  const url = `${creds.host}${pathWithQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: "application/json",
        "User-Agent": "frontier-os-databricks-adapter/v1",
      },
      signal: controller.signal,
    });
    let body: unknown;
    const text = await response.text();
    if (text.length === 0) {
      body = null;
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        body = { rawBody: text.slice(0, 2000) };
      }
    }

    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        reason: "HTTP 401 unauthorized",
        hint: "token rejected; run `databricks configure --token` to refresh",
        body,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        status: 403,
        reason: "HTTP 403 forbidden",
        hint: "token lacks permission for this endpoint; check workspace roles",
        body,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        status: 404,
        reason: "HTTP 404 not found",
        hint: `path not found on ${creds.host}`,
        body,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: `HTTP ${response.status} ${response.statusText}`,
        hint: `unexpected status from ${creds.host}`,
        body,
      };
    }
    return { ok: true, status: response.status, body };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { name?: string };
    if (e.name === "AbortError") {
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        hint: `increase policy.maxRuntimeSeconds or check ${creds.host} reachability`,
      };
    }
    const msg = e.message || String(e);
    return {
      ok: false,
      reason: `network error: ${msg}`,
      hint: `check DNS/VPN for ${creds.host}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- shared helpers ----

async function dbxPost(
  creds: DatabricksCredsOk,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<DbxFetchResult> {
  const url = `${creds.host}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "frontier-os-databricks-adapter/v1",
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    let parsedBody: unknown;
    const text = await response.text();
    if (text.length === 0) {
      parsedBody = null;
    } else {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = { rawBody: text.slice(0, 2000) };
      }
    }
    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        reason: "HTTP 401 unauthorized",
        hint: "token rejected; run `databricks configure --token` to refresh",
        body: parsedBody,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        status: 403,
        reason: "HTTP 403 forbidden",
        hint: "token lacks permission to run jobs; check workspace roles",
        body: parsedBody,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        status: response.status,
        reason: `HTTP ${response.status} ${response.statusText}`,
        hint: `${path} rejected the POST; check payload + workspace state`,
        body: parsedBody,
      };
    }
    return { ok: true, status: response.status, body: parsedBody };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      reason: `fetch failed: ${message}`,
      hint: "network or host unreachable; check FRONTIER_DATABRICKS_HOST",
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function credsHeaderPreview(creds: DatabricksCredsOk): string {
  const suffix = creds.token.slice(-4);
  return `host=${creds.host} token=***${suffix} source=${creds.source}`;
}

function timeoutFor(invocation: AdapterInvocation): number {
  const sec = invocation.policy?.maxRuntimeSeconds;
  if (typeof sec === "number" && sec > 0) return sec * 1000;
  return DEFAULT_TIMEOUT_MS;
}

function toRec(x: unknown): Record<string, unknown> {
  return (x ?? {}) as Record<string, unknown>;
}

function str(x: unknown): string {
  return typeof x === "string" ? x : String(x ?? "");
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

// ---- command handlers ----

async function whoamiCommand(
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
): Promise<AdapterResult> {
  const result = await dbxGet(creds, "/api/2.0/preview/scim/v2/Me", timeoutMs);
  if (!result.ok) {
    return failedResult(invocation, new Error(result.reason), {
      observedState: {
        endpoint: "/api/2.0/preview/scim/v2/Me",
        host: creds.host,
        hint: result.hint,
        status: result.status,
        body: result.body,
      },
    });
  }
  const body = toRec(result.body);
  const userName = str(body["userName"]);
  const id = str(body["id"]);
  const displayName = str(body["displayName"]);
  return buildResult({
    invocation,
    status: "success",
    summary: `databricks whoami: ${userName || "(unknown)"} (id=${id || "?"})`,
    observedState: {
      endpoint: "/api/2.0/preview/scim/v2/Me",
      host: creds.host,
      userName,
      id,
      displayName,
      credsSource: creds.source,
      raw: body,
    },
    verification: { status: "passed", checks: ["trace_grade"] },
  });
}

async function listClustersCommand(
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
): Promise<AdapterResult> {
  const result = await dbxGet(creds, "/api/2.1/clusters/list", timeoutMs);
  if (!result.ok) {
    return failedResult(invocation, new Error(result.reason), {
      observedState: {
        endpoint: "/api/2.1/clusters/list",
        host: creds.host,
        hint: result.hint,
        status: result.status,
        body: result.body,
      },
    });
  }
  const body = toRec(result.body);
  const rawList = Array.isArray(body["clusters"])
    ? (body["clusters"] as unknown[])
    : [];
  const allClusters = rawList.map((raw) => {
    const c = toRec(raw);
    return {
      cluster_id: str(c["cluster_id"]),
      cluster_name: str(c["cluster_name"]),
      state: str(c["state"]),
      driver_node_type_id: str(c["driver_node_type_id"]),
    };
  });
  const clusters = allClusters.slice(0, DEFAULT_CLUSTER_LIMIT);
  const running = clusters.filter((c) => c.state === "RUNNING").length;
  return buildResult({
    invocation,
    status: "success",
    summary: `databricks clusters: ${allClusters.length} total (${running} running, showing ${clusters.length})`,
    observedState: {
      endpoint: "/api/2.1/clusters/list",
      host: creds.host,
      totalCount: allClusters.length,
      shown: clusters.length,
      runningCount: running,
      clusters,
    },
    verification: { status: "passed", checks: ["trace_grade"] },
  });
}

async function listJobsCommand(
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
): Promise<AdapterResult> {
  const result = await dbxGet(
    creds,
    `/api/2.2/jobs/list?limit=${DEFAULT_JOB_LIMIT}`,
    timeoutMs,
  );
  if (!result.ok) {
    return failedResult(invocation, new Error(result.reason), {
      observedState: {
        endpoint: "/api/2.2/jobs/list",
        host: creds.host,
        hint: result.hint,
        status: result.status,
        body: result.body,
      },
    });
  }
  const body = toRec(result.body);
  const rawList = Array.isArray(body["jobs"])
    ? (body["jobs"] as unknown[])
    : [];
  const jobs = rawList.map((raw) => {
    const j = toRec(raw);
    const settings = toRec(j["settings"]);
    const schedule = settings["schedule"];
    return {
      job_id: num(j["job_id"]) ?? str(j["job_id"]),
      name: str(settings["name"] ?? j["name"]),
      creator_user_name: str(j["creator_user_name"]),
      schedule: schedule ?? null,
    };
  });
  const hasMore = body["has_more"] === true;
  return buildResult({
    invocation,
    status: "success",
    summary: `databricks jobs: ${jobs.length} shown${hasMore ? " (more available)" : ""}`,
    observedState: {
      endpoint: "/api/2.2/jobs/list",
      host: creds.host,
      shown: jobs.length,
      hasMore,
      jobs,
    },
    verification: { status: "passed", checks: ["trace_grade"] },
  });
}

async function jobStatusCommand(
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
): Promise<AdapterResult> {
  const args = toRec(invocation.arguments);
  const rawJobId = args["job_id"] ?? args["jobId"];
  const jobIdNum = typeof rawJobId === "string" ? Number(rawJobId) : rawJobId;
  if (
    typeof jobIdNum !== "number" ||
    !Number.isInteger(jobIdNum) ||
    jobIdNum <= 0
  ) {
    return failedResult(
      invocation,
      new Error("job-status requires arguments.job_id (positive integer)"),
    );
  }

  const getRes = await dbxGet(
    creds,
    `/api/2.2/jobs/get?job_id=${jobIdNum}`,
    timeoutMs,
  );
  if (!getRes.ok) {
    return failedResult(invocation, new Error(getRes.reason), {
      observedState: {
        endpoint: "/api/2.2/jobs/get",
        host: creds.host,
        job_id: jobIdNum,
        hint: getRes.hint,
        status: getRes.status,
        body: getRes.body,
      },
    });
  }
  const runsRes = await dbxGet(
    creds,
    `/api/2.2/jobs/runs/list?job_id=${jobIdNum}&limit=${DEFAULT_RUNS_LIMIT}`,
    timeoutMs,
  );
  if (!runsRes.ok) {
    return failedResult(invocation, new Error(runsRes.reason), {
      observedState: {
        endpoint: "/api/2.2/jobs/runs/list",
        host: creds.host,
        job_id: jobIdNum,
        hint: runsRes.hint,
        status: runsRes.status,
        body: runsRes.body,
      },
    });
  }

  const jobBody = toRec(getRes.body);
  const settings = toRec(jobBody["settings"]);
  const runsBody = toRec(runsRes.body);
  const rawRuns = Array.isArray(runsBody["runs"])
    ? (runsBody["runs"] as unknown[])
    : [];
  const runs = rawRuns.slice(0, DEFAULT_RUNS_LIMIT).map((raw) => {
    const r = toRec(raw);
    const state = toRec(r["state"]);
    return {
      run_id: num(r["run_id"]) ?? str(r["run_id"]),
      run_name: str(r["run_name"]),
      life_cycle_state: str(state["life_cycle_state"]),
      result_state: str(state["result_state"]),
      start_time: num(r["start_time"]),
      end_time: num(r["end_time"]),
    };
  });

  const name = str(settings["name"]);
  const latest = runs[0];
  const latestDesc = latest
    ? `latest=${latest.life_cycle_state}${latest.result_state ? `/${latest.result_state}` : ""}`
    : "no runs";

  return buildResult({
    invocation,
    status: "success",
    summary: `databricks job ${jobIdNum} "${name}": ${runs.length} recent run(s), ${latestDesc}`,
    observedState: {
      host: creds.host,
      job_id: jobIdNum,
      name,
      creator_user_name: str(jobBody["creator_user_name"]),
      schedule: settings["schedule"] ?? null,
      recentRuns: runs,
    },
    verification: { status: "passed", checks: ["trace_grade"] },
  });
}

async function workspaceLsCommand(
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
): Promise<AdapterResult> {
  const args = toRec(invocation.arguments);
  const pathArg = args["path"];
  const path =
    typeof pathArg === "string" && pathArg.trim() !== "" ? pathArg.trim() : "/";
  const qp = `/api/2.0/workspace/list?path=${encodeURIComponent(path)}`;
  const result = await dbxGet(creds, qp, timeoutMs);

  if (!result.ok) {
    // 404 on workspace-ls is graceful — return failed but not a crash, with
    // a clear hint that the path doesn't exist.
    if (result.status === 404) {
      return failedResult(
        invocation,
        new Error(`workspace path not found: ${path}`),
        {
          observedState: {
            endpoint: "/api/2.0/workspace/list",
            host: creds.host,
            path,
            hint: `no such path on ${creds.host}`,
            status: 404,
            body: result.body,
          },
        },
      );
    }
    return failedResult(invocation, new Error(result.reason), {
      observedState: {
        endpoint: "/api/2.0/workspace/list",
        host: creds.host,
        path,
        hint: result.hint,
        status: result.status,
        body: result.body,
      },
    });
  }

  const body = toRec(result.body);
  const rawList = Array.isArray(body["objects"])
    ? (body["objects"] as unknown[])
    : [];
  const objects = rawList.map((raw) => {
    const o = toRec(raw);
    return {
      path: str(o["path"]),
      object_type: str(o["object_type"]),
      object_id: num(o["object_id"]),
      language:
        typeof o["language"] === "string" ? (o["language"] as string) : null,
    };
  });

  return buildResult({
    invocation,
    status: "success",
    summary: `databricks workspace ${path}: ${objects.length} object(s)`,
    observedState: {
      endpoint: "/api/2.0/workspace/list",
      host: creds.host,
      path,
      count: objects.length,
      objects,
    },
    verification: { status: "passed", checks: ["trace_grade"] },
  });
}

// ---- dispatcher ----

type CommandHandler = (
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
) => Promise<AdapterResult>;

async function runJobCommand(
  invocation: AdapterInvocation,
  creds: DatabricksCredsOk,
  timeoutMs: number,
): Promise<AdapterResult> {
  const args = toRec(invocation.arguments);
  const rawJobId = args["job_id"] ?? args["jobId"];
  const jobIdNum = typeof rawJobId === "string" ? Number(rawJobId) : rawJobId;
  if (
    typeof jobIdNum !== "number" ||
    !Number.isInteger(jobIdNum) ||
    jobIdNum <= 0
  ) {
    return failedResult(
      invocation,
      new Error("run-job requires arguments.job_id (positive integer)"),
    );
  }
  const jobParams = toRec(args["job_parameters"]);
  const payload: Record<string, unknown> = { job_id: jobIdNum };
  if (Object.keys(jobParams).length > 0) payload["job_parameters"] = jobParams;

  // Propose mode: NO POST. Return the exact payload we WOULD send. Ghost
  // Shift + human review can inspect intent before a single billable minute
  // of cluster time is spent.
  if (invocation.mode === "propose") {
    return buildResult({
      invocation,
      status: "success",
      summary: `propose: would POST /api/2.2/jobs/run-now job_id=${jobIdNum}`,
      observedState: {
        mode: "propose",
        endpoint: "/api/2.2/jobs/run-now",
        host: creds.host,
        method: "POST",
        payload,
      },
      sideEffects: [
        {
          class: "billable_action",
          target: `${creds.host} job_id=${jobIdNum}`,
          summary: "would trigger a billable Databricks job run",
        },
      ],
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  }

  // Apply mode: real POST. Billable side effect — must be gated by
  // approval class ≥ 2 at the work-graph layer.
  const res = await dbxPost(creds, "/api/2.2/jobs/run-now", payload, timeoutMs);
  if (!res.ok) {
    return failedResult(invocation, new Error(res.reason), {
      observedState: {
        endpoint: "/api/2.2/jobs/run-now",
        host: creds.host,
        job_id: jobIdNum,
        hint: res.hint,
        status: res.status,
        body: res.body,
      },
    });
  }
  const body = toRec(res.body);
  const runId = num(body["run_id"]) ?? null;
  const numberInJob = num(body["number_in_job"]) ?? null;
  return buildResult({
    invocation,
    status: "success",
    summary: `started run_id=${runId ?? "?"} for job_id=${jobIdNum}`,
    observedState: {
      mode: "apply",
      endpoint: "/api/2.2/jobs/run-now",
      host: creds.host,
      job_id: jobIdNum,
      run_id: runId,
      number_in_job: numberInJob,
      response: body,
    },
    sideEffects: [
      {
        class: "billable_action",
        target: `${creds.host} job_id=${jobIdNum} run_id=${runId ?? "?"}`,
        summary: `triggered Databricks job run ${runId ?? ""}`,
      },
    ],
    artifacts: runId
      ? [
          {
            kind: "url",
            ref: `${creds.host}/#job/${jobIdNum}/run/${runId}`,
            note: `Databricks run ${runId} of job ${jobIdNum}`,
          },
        ]
      : [],
    verification: {
      status: "passed",
      checks: ["trace_grade"],
    },
  });
}

const HANDLERS: Record<string, CommandHandler> = {
  whoami: whoamiCommand,
  "list-clusters": listClustersCommand,
  "list-jobs": listJobsCommand,
  "job-status": jobStatusCommand,
  "workspace-ls": workspaceLsCommand,
  "run-job": runJobCommand,
};

export async function createDatabricksAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  return {
    manifest,
    async invoke(invocation: AdapterInvocation): Promise<AdapterResult> {
      // 1. Manifest sanity — command must be declared.
      const spec = adapterCommandSpec(manifest, invocation.command);
      // 2. Mode must be supported.
      if (!spec.supportedModes.includes(invocation.mode)) {
        return failedResult(
          invocation,
          new Error(
            `command "${invocation.command}" does not support mode "${invocation.mode}"`,
          ),
        );
      }
      // 3. Handler exists.
      const handler = HANDLERS[invocation.command];
      if (!handler) {
        return failedResult(
          invocation,
          new Error(
            `databricks adapter has no handler for command "${invocation.command}" yet`,
          ),
        );
      }
      // 4. Resolve credentials. Missing creds → failed (not crash).
      const creds = resolveDatabricksCreds();
      if (!creds.ok) {
        return failedResult(invocation, new Error(creds.reason), {
          observedState: {
            hint: creds.reason,
            command: invocation.command,
          },
        });
      }
      // 5. Dispatch. Unexpected exceptions surface as failed, not crash.
      const timeoutMs = timeoutFor(invocation);
      try {
        const res = await handler(invocation, creds, timeoutMs);
        return res;
      } catch (err) {
        return failedResult(invocation, err, {
          observedState: {
            credsPreview: credsHeaderPreview(creds),
            command: invocation.command,
          },
        });
      }
    },
  };
}
