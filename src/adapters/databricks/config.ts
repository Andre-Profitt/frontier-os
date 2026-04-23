// Tiny .databrickscfg INI parser — reads [DEFAULT] host + token.
//
// The Databricks CLI writes ~/.databrickscfg in a simple INI format:
//
//   [DEFAULT]
//   host  = https://dbc-XXXX.cloud.databricks.com
//   token = dapiXXXX...
//
// This parser handles the narrow shape we actually use: a single [DEFAULT]
// profile with host + token key/value pairs, whitespace around `=` allowed,
// blank lines and `#` / `;` comments ignored. Env vars override file values:
//
//   FRONTIER_DATABRICKS_HOST  → overrides host
//   FRONTIER_DATABRICKS_TOKEN → overrides token
//
// Never throws. Returns { ok: true, host, token } on success, or
// { ok: false, reason } with a human-readable hint on failure so the adapter
// can surface it in a failed AdapterResult instead of crashing.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DatabricksCredsOk {
  ok: true;
  host: string;
  token: string;
  source: "env" | "cfg" | "mixed";
}

export interface DatabricksCredsErr {
  ok: false;
  reason: string;
}

export type DatabricksCreds = DatabricksCredsOk | DatabricksCredsErr;

/** Normalize host: strip trailing slash, require https://. */
function normalizeHost(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

/** Parse a minimal INI body and return the [DEFAULT] section key/values. */
function parseDefaultSection(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inDefault = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inDefault = line.slice(1, -1).trim().toUpperCase() === "DEFAULT";
      continue;
    }
    if (!inDefault) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (key !== "") out[key] = val;
  }
  return out;
}

export interface ResolveCredsOptions {
  /** Override the cfg path (testing). Defaults to ~/.databrickscfg. */
  cfgPath?: string;
  /** Override env (testing). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve Databricks host + token from env first, then ~/.databrickscfg.
 * Either source can supply either field; mismatches are fine (env wins per
 * field). Returns ok=false with a specific hint if neither fully resolves.
 */
export function resolveDatabricksCreds(
  options: ResolveCredsOptions = {},
): DatabricksCreds {
  const env = options.env ?? process.env;
  const cfgPath = options.cfgPath ?? resolve(homedir(), ".databrickscfg");

  const envHost = env["FRONTIER_DATABRICKS_HOST"]?.trim();
  const envToken = env["FRONTIER_DATABRICKS_TOKEN"]?.trim();

  let cfgHost: string | undefined;
  let cfgToken: string | undefined;
  let cfgRead = false;
  try {
    const body = readFileSync(cfgPath, "utf8");
    const section = parseDefaultSection(body);
    cfgHost = section["host"];
    cfgToken = section["token"];
    cfgRead = true;
  } catch {
    // File missing or unreadable — rely on env only.
  }

  const hostRaw = envHost && envHost !== "" ? envHost : cfgHost;
  const tokenRaw = envToken && envToken !== "" ? envToken : cfgToken;

  if (!cfgRead && !envHost && !envToken) {
    return {
      ok: false,
      reason:
        "no ~/.databrickscfg; set FRONTIER_DATABRICKS_HOST + FRONTIER_DATABRICKS_TOKEN",
    };
  }

  if (!hostRaw || hostRaw.trim() === "") {
    return {
      ok: false,
      reason:
        "databricks host not found; set FRONTIER_DATABRICKS_HOST or [DEFAULT] host in ~/.databrickscfg",
    };
  }

  const host = normalizeHost(hostRaw);
  if (!host) {
    return {
      ok: false,
      reason: `databricks host "${hostRaw}" is not a valid https:// URL`,
    };
  }

  if (!tokenRaw || tokenRaw.trim() === "") {
    return {
      ok: false,
      reason:
        "databricks token not found; set FRONTIER_DATABRICKS_TOKEN or [DEFAULT] token in ~/.databrickscfg",
    };
  }

  let source: DatabricksCredsOk["source"] = "cfg";
  if (envHost && envToken) source = "env";
  else if (envHost || envToken) source = "mixed";

  return { ok: true, host, token: tokenRaw, source };
}
