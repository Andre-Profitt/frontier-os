// Sigma adapter credential loader.
//
// Source order (first defined wins for each key):
//   1. FRONTIER_SIGMA_* environment variable (e.g. FRONTIER_SIGMA_BASE_URL)
//   2. key=value parsed from /Users/test/code/apps/sigma-gtm-poc/.env
//
// Any missing required key yields a ConfigError. Callers surface it as a
// failed AdapterResult with a hint string — we never throw into the dispatcher.

import { readFileSync } from "node:fs";

export interface SigmaConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  orgId: string;
  accountEmail: string;
}

export class SigmaConfigError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "SigmaConfigError";
    this.hint = hint;
  }
}

const DEFAULT_ENV_PATH = "/Users/test/code/apps/sigma-gtm-poc/.env";

const REQUIRED_KEYS = [
  "SIGMA_BASE_URL",
  "SIGMA_CLIENT_ID",
  "SIGMA_CLIENT_SECRET",
  "SIGMA_ORG_ID",
  "SIGMA_ACCOUNT_EMAIL",
] as const;

type RequiredKey = (typeof REQUIRED_KEYS)[number];

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double) but leave inner content.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readDotEnv(path: string): Record<string, string> {
  try {
    const text = readFileSync(path, "utf8");
    return parseDotEnv(text);
  } catch {
    return {};
  }
}

/**
 * Load Sigma credentials from FRONTIER_SIGMA_* env vars and/or the sigma-gtm-poc
 * .env file. Returns a SigmaConfig or throws SigmaConfigError if any required
 * key is missing from both sources.
 */
export function loadSigmaConfig(
  options: { envPath?: string } = {},
): SigmaConfig {
  const envPath = options.envPath ?? DEFAULT_ENV_PATH;
  const fileEnv = readDotEnv(envPath);

  const resolved: Partial<Record<RequiredKey, string>> = {};
  const missing: RequiredKey[] = [];

  for (const key of REQUIRED_KEYS) {
    const frontierKey = `FRONTIER_${key}`;
    const envOverride = process.env[frontierKey];
    const envValue =
      envOverride !== undefined && envOverride !== ""
        ? envOverride
        : fileEnv[key];
    if (envValue === undefined || envValue === "") {
      missing.push(key);
    } else {
      resolved[key] = envValue;
    }
  }

  if (missing.length > 0) {
    const hint =
      `Missing Sigma credentials: ${missing.join(", ")}. ` +
      `Set FRONTIER_${missing[0]} env var, or add ${missing.join("/")} to ${envPath}.`;
    throw new SigmaConfigError(
      `Sigma adapter cannot load credentials (missing ${missing.length} key(s))`,
      hint,
    );
  }

  return {
    baseUrl: resolved["SIGMA_BASE_URL"]!.replace(/\/+$/, ""),
    clientId: resolved["SIGMA_CLIENT_ID"]!,
    clientSecret: resolved["SIGMA_CLIENT_SECRET"]!,
    orgId: resolved["SIGMA_ORG_ID"]!,
    accountEmail: resolved["SIGMA_ACCOUNT_EMAIL"]!,
  };
}
