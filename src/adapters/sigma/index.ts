// Sigma adapter — thin REST wrapper around Sigma's v2 API.
//
// Auth: OAuth2 client credentials against POST {base}/v2/auth/token with
// grant_type=client_credentials. Response has access_token (JWT) + expires_in.
// We cache the token inside the createSigmaAdapter closure (per-instance,
// not module-level); on 401 we clear and refresh once then retry. A second
// 401 surfaces as a failed result with a clear hint.
//
// All commands here are read-only. Any 4xx other than 401 returns failed with
// the response body truncated into observedState for diagnosis.

import type { AdapterImpl } from "../../registry.ts";
import { adapterCommandSpec } from "../../registry.ts";
import { buildResult, failedResult } from "../../result.ts";
import type {
  AdapterInvocation,
  AdapterManifest,
  AdapterResult,
} from "../../schemas.ts";
import {
  loadSigmaConfig,
  SigmaConfigError,
  type SigmaConfig,
} from "./config.ts";

interface TokenCache {
  accessToken: string;
  /** Unix ms at which the token should be considered stale. */
  expiresAtMs: number;
}

interface SigmaRequestResult {
  status: number;
  bodyText: string;
  bodyJson: unknown;
  url: string;
}

/** Treat tokens as stale 60s before their real expiry to avoid clock-skew 401s. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function requireStringArg(invocation: AdapterInvocation, key: string): string {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `${invocation.command} requires arguments.${key} (non-empty string)`,
    );
  }
  return raw.trim();
}

function optionalLimit(
  invocation: AdapterInvocation,
  fallback: number,
): number {
  const args = (invocation.arguments ?? {}) as Record<string, unknown>;
  const raw = args["limit"];
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 500) {
    throw new Error(
      `${invocation.command} arguments.limit must be a positive integer <= 500`,
    );
  }
  return n;
}

// ---- adapter factory ----

export async function createSigmaAdapter(
  manifest: AdapterManifest,
): Promise<AdapterImpl> {
  // Token cache lives in this closure — one cache per createSigmaAdapter()
  // instance, and only for the lifetime of the process.
  let tokenCache: TokenCache | null = null;
  let cachedConfig: SigmaConfig | null = null;
  let cachedConfigError: SigmaConfigError | null = null;

  function resolveConfig(): SigmaConfig {
    if (cachedConfig) return cachedConfig;
    if (cachedConfigError) throw cachedConfigError;
    try {
      cachedConfig = loadSigmaConfig();
      return cachedConfig;
    } catch (err) {
      if (err instanceof SigmaConfigError) {
        cachedConfigError = err;
      }
      throw err;
    }
  }

  async function fetchToken(config: SigmaConfig): Promise<TokenCache> {
    const url = `${config.baseUrl}/v2/auth/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Sigma auth failed: HTTP ${response.status} ${response.statusText} — ${truncate(text, 500)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Sigma auth returned non-JSON body: ${truncate(text, 300)}`,
      );
    }
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const accessToken = obj["access_token"];
    const expiresIn = obj["expires_in"];
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new Error(
        `Sigma auth response missing access_token (keys: ${Object.keys(obj).join(",")})`,
      );
    }
    const expiresSeconds =
      typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
    return {
      accessToken,
      expiresAtMs: Date.now() + expiresSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS,
    };
  }

  async function ensureToken(
    config: SigmaConfig,
    forceRefresh = false,
  ): Promise<string> {
    if (forceRefresh || !tokenCache || Date.now() >= tokenCache.expiresAtMs) {
      tokenCache = await fetchToken(config);
    }
    return tokenCache.accessToken;
  }

  async function sigmaRequestPost(
    config: SigmaConfig,
    path: string,
    body: unknown,
  ): Promise<SigmaRequestResult> {
    const url = `${config.baseUrl}${path}`;
    let token = await ensureToken(config);
    const payload = JSON.stringify(body ?? {});
    let response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: payload,
    });
    let bodyText = await response.text();
    if (response.status === 401) {
      tokenCache = null;
      try {
        token = await ensureToken(config, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Sigma token refresh after POST 401 failed: ${msg}`);
      }
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: payload,
      });
      bodyText = await response.text();
      if (response.status === 401) {
        throw new Error(
          `Sigma POST returned 401 twice — credentials may be revoked or lack scope. Body: ${truncate(bodyText, 400)}`,
        );
      }
    }
    let bodyJson: unknown = null;
    if (bodyText.length > 0) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        /* non-JSON; leave null */
      }
    }
    return { status: response.status, bodyText, bodyJson, url };
  }

  async function sigmaRequest(
    config: SigmaConfig,
    path: string,
  ): Promise<SigmaRequestResult> {
    const url = `${config.baseUrl}${path}`;
    let token = await ensureToken(config);
    let response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    let bodyText = await response.text();

    // One retry on 401: refresh token then re-send.
    if (response.status === 401) {
      tokenCache = null;
      try {
        token = await ensureToken(config, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Sigma token refresh after 401 failed: ${msg}`);
      }
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      bodyText = await response.text();
      if (response.status === 401) {
        throw new Error(
          `Sigma returned 401 twice — credentials may be revoked or lack scope. Body: ${truncate(bodyText, 400)}`,
        );
      }
    }

    let bodyJson: unknown = null;
    if (bodyText.length > 0) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        // Leave bodyJson null; caller inspects bodyText.
      }
    }
    return { status: response.status, bodyText, bodyJson, url };
  }

  async function callSigma(
    invocation: AdapterInvocation,
    path: string,
    successSummary: (bodyJson: unknown) => string,
  ): Promise<AdapterResult> {
    let config: SigmaConfig;
    try {
      config = resolveConfig();
    } catch (err) {
      if (err instanceof SigmaConfigError) {
        return failedResult(invocation, err, {
          observedState: { hint: err.hint },
        });
      }
      return failedResult(invocation, err);
    }

    let response: SigmaRequestResult;
    try {
      response = await sigmaRequest(config, path);
    } catch (err) {
      return failedResult(invocation, err, {
        observedState: {
          invocation: { method: "GET", url: `${config.baseUrl}${path}` },
        },
      });
    }

    const invocationRecord = {
      method: "GET",
      url: response.url,
      status: response.status,
    };

    if (response.status < 200 || response.status >= 300) {
      return failedResult(
        invocation,
        new Error(`Sigma HTTP ${response.status} on ${path}`),
        {
          observedState: {
            invocation: invocationRecord,
            body: response.bodyJson ?? truncate(response.bodyText, 2000),
          },
        },
      );
    }

    return buildResult({
      invocation,
      status: "success",
      summary: successSummary(response.bodyJson),
      observedState: {
        invocation: invocationRecord,
        data: response.bodyJson,
      },
      verification: { status: "passed", checks: ["trace_grade"] },
    });
  }

  // ---- command handlers ----

  async function whoamiCommand(
    invocation: AdapterInvocation,
  ): Promise<AdapterResult> {
    return callSigma(invocation, "/v2/members/me", (body) => {
      const obj = (body ?? {}) as Record<string, unknown>;
      const email =
        typeof obj["email"] === "string" ? (obj["email"] as string) : "?";
      const memberId =
        typeof obj["memberId"] === "string"
          ? (obj["memberId"] as string)
          : typeof obj["id"] === "string"
            ? (obj["id"] as string)
            : "?";
      return `whoami: ${email} (memberId=${memberId})`;
    });
  }

  async function listWorkbooksCommand(
    invocation: AdapterInvocation,
  ): Promise<AdapterResult> {
    const limit = optionalLimit(invocation, 25);
    return callSigma(invocation, `/v2/workbooks${qs({ limit })}`, (body) => {
      const obj = (body ?? {}) as Record<string, unknown>;
      const entries = obj["entries"];
      const count = Array.isArray(entries) ? entries.length : 0;
      return `workbooks: ${count} entry(ies) (limit=${limit})`;
    });
  }

  async function inspectWorkbookCommand(
    invocation: AdapterInvocation,
  ): Promise<AdapterResult> {
    const workbookId = requireStringArg(invocation, "workbookId");

    let config: SigmaConfig;
    try {
      config = resolveConfig();
    } catch (err) {
      if (err instanceof SigmaConfigError) {
        return failedResult(invocation, err, {
          observedState: { hint: err.hint },
        });
      }
      return failedResult(invocation, err);
    }

    const metaPath = `/v2/workbooks/${encodeURIComponent(workbookId)}`;
    const pagesPath = `/v2/workbooks/${encodeURIComponent(workbookId)}/pages`;

    let metaRes: SigmaRequestResult;
    let pagesRes: SigmaRequestResult;
    try {
      metaRes = await sigmaRequest(config, metaPath);
      pagesRes = await sigmaRequest(config, pagesPath);
    } catch (err) {
      return failedResult(invocation, err);
    }

    if (metaRes.status < 200 || metaRes.status >= 300) {
      return failedResult(
        invocation,
        new Error(
          `Sigma HTTP ${metaRes.status} fetching workbook ${workbookId}`,
        ),
        {
          observedState: {
            invocation: {
              method: "GET",
              url: metaRes.url,
              status: metaRes.status,
            },
            body: metaRes.bodyJson ?? truncate(metaRes.bodyText, 2000),
          },
        },
      );
    }
    if (pagesRes.status < 200 || pagesRes.status >= 300) {
      return failedResult(
        invocation,
        new Error(
          `Sigma HTTP ${pagesRes.status} fetching pages for ${workbookId}`,
        ),
        {
          observedState: {
            invocation: {
              method: "GET",
              url: pagesRes.url,
              status: pagesRes.status,
            },
            body: pagesRes.bodyJson ?? truncate(pagesRes.bodyText, 2000),
          },
        },
      );
    }

    const metaObj = (metaRes.bodyJson ?? {}) as Record<string, unknown>;
    const name =
      typeof metaObj["name"] === "string" ? (metaObj["name"] as string) : "?";
    const pagesObj = (pagesRes.bodyJson ?? {}) as Record<string, unknown>;
    const pageEntries = pagesObj["entries"];
    const pageCount = Array.isArray(pageEntries) ? pageEntries.length : 0;

    return buildResult({
      invocation,
      status: "success",
      summary: `workbook "${name}" (${workbookId}): ${pageCount} page(s)`,
      observedState: {
        invocation: {
          method: "GET",
          metaUrl: metaRes.url,
          pagesUrl: pagesRes.url,
          metaStatus: metaRes.status,
          pagesStatus: pagesRes.status,
        },
        workbook: metaRes.bodyJson,
        pages: pagesRes.bodyJson,
      },
      verification: { status: "passed", checks: ["trace_grade"] },
    });
  }

  async function listMembersCommand(
    invocation: AdapterInvocation,
  ): Promise<AdapterResult> {
    const limit = optionalLimit(invocation, 25);
    return callSigma(invocation, `/v2/members${qs({ limit })}`, (body) => {
      const obj = (body ?? {}) as Record<string, unknown>;
      const entries = obj["entries"];
      const count = Array.isArray(entries) ? entries.length : 0;
      return `members: ${count} entry(ies) (limit=${limit})`;
    });
  }

  async function listDatasetsCommand(
    invocation: AdapterInvocation,
  ): Promise<AdapterResult> {
    const limit = optionalLimit(invocation, 25);
    return callSigma(invocation, `/v2/datasets${qs({ limit })}`, (body) => {
      const obj = (body ?? {}) as Record<string, unknown>;
      const entries = obj["entries"];
      const count = Array.isArray(entries) ? entries.length : 0;
      return `datasets: ${count} entry(ies) (limit=${limit})`;
    });
  }

  type CommandHandler = (
    invocation: AdapterInvocation,
  ) => Promise<AdapterResult>;

  async function refreshWorkbookCommand(
    invocation: AdapterInvocation,
  ): Promise<AdapterResult> {
    const args = (invocation.arguments ?? {}) as Record<string, unknown>;
    const workbookId =
      typeof args["workbookId"] === "string" ? args["workbookId"] : "";
    if (!workbookId) {
      return failedResult(
        invocation,
        new Error("refresh-workbook requires arguments.workbookId (string)"),
      );
    }
    const path = `/v2/workbooks/${encodeURIComponent(workbookId)}/materializations/schedule`;
    const body: Record<string, unknown> = {};
    if (typeof args["name"] === "string") body["name"] = args["name"];

    // Propose mode: return the exact URL + JSON we WOULD POST. No API call.
    if (invocation.mode === "propose") {
      let baseUrl = "(config unloaded)";
      try {
        baseUrl = resolveConfig().baseUrl;
      } catch {
        /* config failure falls through but propose still succeeds — intent
           preview is useful even without live creds */
      }
      return buildResult({
        invocation,
        status: "success",
        summary: `propose: would POST ${baseUrl}${path}`,
        observedState: {
          mode: "propose",
          method: "POST",
          endpoint: path,
          url: `${baseUrl}${path}`,
          workbookId,
          body,
        },
        sideEffects: [
          {
            class: "shared_write",
            target: `sigma workbook ${workbookId}`,
            summary:
              "would trigger a Sigma workbook materialization (shared dataset refresh)",
          },
        ],
        verification: {
          status: "passed",
          checks: ["trace_grade"],
        },
      });
    }

    // Apply mode: real POST.
    let config: SigmaConfig;
    try {
      config = resolveConfig();
    } catch (err) {
      if (err instanceof SigmaConfigError) {
        return failedResult(invocation, err, {
          observedState: { hint: err.hint },
        });
      }
      return failedResult(invocation, err);
    }

    let response: SigmaRequestResult;
    try {
      response = await sigmaRequestPost(config, path, body);
    } catch (err) {
      return failedResult(invocation, err, {
        observedState: {
          endpoint: path,
          host: config.baseUrl,
          workbookId,
        },
      });
    }

    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      return failedResult(
        invocation,
        new Error(`Sigma POST ${path} returned ${response.status}`),
        {
          observedState: {
            endpoint: path,
            host: config.baseUrl,
            workbookId,
            status: response.status,
            body: response.bodyJson ?? truncate(response.bodyText, 400),
          },
        },
      );
    }

    const respRec = (response.bodyJson ?? {}) as Record<string, unknown>;
    const scheduleId =
      typeof respRec["scheduleId"] === "string"
        ? respRec["scheduleId"]
        : typeof respRec["id"] === "string"
          ? respRec["id"]
          : null;
    return buildResult({
      invocation,
      status: "success",
      summary: `refreshed workbook ${workbookId} — scheduleId=${scheduleId ?? "?"}`,
      observedState: {
        mode: "apply",
        endpoint: path,
        host: config.baseUrl,
        workbookId,
        status: response.status,
        scheduleId,
        response: response.bodyJson,
      },
      sideEffects: [
        {
          class: "shared_write",
          target: `sigma workbook ${workbookId}`,
          summary: `triggered materialization${scheduleId ? ` (scheduleId=${scheduleId})` : ""}`,
        },
      ],
      verification: {
        status: "passed",
        checks: ["trace_grade"],
      },
    });
  }

  const HANDLERS: Record<string, CommandHandler> = {
    whoami: whoamiCommand,
    "list-workbooks": listWorkbooksCommand,
    "inspect-workbook": inspectWorkbookCommand,
    "list-members": listMembersCommand,
    "list-datasets": listDatasetsCommand,
    "refresh-workbook": refreshWorkbookCommand,
  };

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
            `sigma adapter has no handler for command "${invocation.command}" yet`,
          ),
        );
      }
      try {
        return await handler(invocation);
      } catch (err) {
        return failedResult(invocation, err);
      }
    },
  };
}
