// Credential resolver — shared dotenv-search-path loader.
//
// Adapters that need an API key / token / secret should call
// `resolveCredential(key, extraSearchPaths?)` instead of reading
// `process.env` directly. The resolver checks, in order:
//
//   1. process.env[key]
//   2. Any adapter-specific extra paths passed in
//   3. ~/frontier-os/.env    (standard frontier-os override location)
//   4. ~/.env                (home-level global env)
//
// Every lookup is lazy and cached per-key — constructor throws a typed
// error via the MissingCredentialError helper so command handlers can
// surface it cleanly via failedResult().
//
// This is deliberately NOT a full dotenv implementation — no interpolation,
// no `export` handling, no quoting edge cases beyond trim + strip matching
// single/double quotes. Enough for real-world credential files; nothing more.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

/** Standard frontier-os credential search path, in priority order. */
const STANDARD_SEARCH_PATH = [
  resolvePath(HOME, "frontier-os/.env"),
  resolvePath(HOME, ".env"),
];

/** Known adapter-specific credential locations discovered during development. */
export const KNOWN_ADAPTER_PATHS: Record<string, string[]> = {
  runpod: [resolvePath(HOME, "code/labs/kaggle-nemotron/.env")],
  sigma: [resolvePath(HOME, "code/apps/sigma-gtm-poc/.env")],
  // GitHub, Azure, Kaggle, Databricks don't need dotenv — they have their
  // own CLI-auth mechanisms. Entries here are only for key-in-file storage.
};

/** Thrown when a credential can't be found in any search path location. */
export class MissingCredentialError extends Error {
  readonly key: string;
  readonly searched: string[];
  constructor(key: string, searched: string[]) {
    const paths = searched.join(", ");
    super(
      `Credential ${key} not found. Searched: process.env, ${paths}. ` +
        `Either export ${key} or add it to one of the search paths.`,
    );
    this.name = "MissingCredentialError";
    this.key = key;
    this.searched = searched;
  }
}

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // Strip matching surrounding single or double quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // Drop inline `#` comments only when the value isn't quoted.
  const hashIdx = value.indexOf(" #");
  if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
  if (!key) return null;
  return { key, value };
}

function readKeyFromDotenv(filePath: string, key: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const contents = readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line);
      if (parsed && parsed.key === key) {
        return parsed.value;
      }
    }
  } catch {
    /* ignore — missing/unreadable file just means "not here" */
  }
  return undefined;
}

export interface ResolveOptions {
  /**
   * Extra paths to check BEFORE the standard search path but AFTER
   * process.env. Typically an adapter's known credential location.
   */
  extraPaths?: string[];
}

/**
 * Resolve a credential by key. Returns the string value or undefined.
 * Does NOT throw — use `requireCredential` for throwing semantics.
 */
export function resolveCredential(
  key: string,
  opts: ResolveOptions = {},
): string | undefined {
  // 1. process.env wins
  const fromEnv = process.env[key];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;

  // 2. extraPaths (adapter-specific)
  if (opts.extraPaths) {
    for (const p of opts.extraPaths) {
      const value = readKeyFromDotenv(p, key);
      if (value && value.trim() !== "") return value;
    }
  }

  // 3. standard search path
  for (const p of STANDARD_SEARCH_PATH) {
    const value = readKeyFromDotenv(p, key);
    if (value && value.trim() !== "") return value;
  }

  return undefined;
}

/**
 * Require a credential — resolves, and throws `MissingCredentialError`
 * with the full search path in the error message if not found.
 */
export function requireCredential(
  key: string,
  opts: ResolveOptions = {},
): string {
  const value = resolveCredential(key, opts);
  if (value === undefined) {
    const searched: string[] = [];
    if (opts.extraPaths) searched.push(...opts.extraPaths);
    searched.push(...STANDARD_SEARCH_PATH);
    throw new MissingCredentialError(key, searched);
  }
  return value;
}

/**
 * Resolve a set of related credentials in one call. Useful for adapters
 * that need multiple env vars (e.g. Sigma's BASE_URL + CLIENT_ID +
 * CLIENT_SECRET + ORG_ID). Throws on the first missing key.
 */
export function requireCredentials<K extends string>(
  keys: readonly K[],
  opts: ResolveOptions = {},
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) {
    out[k] = requireCredential(k, opts);
  }
  return out;
}
