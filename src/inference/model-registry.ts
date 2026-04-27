// Model registry — reads config/model-policy.json and exposes typed
// access to providers, classes, and per-class model lists.
//
// Local-only by default; the registry never enables NIM unless the
// policy explicitly does so AND the env auth is present.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { resolveCredential } from "../core/credentials.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
const DEFAULT_POLICY_PATH = resolve(REPO_ROOT, "config", "model-policy.json");

export interface ProviderEntry {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string | null;
  envKeyVar?: string;
  envKeyVarFallback?: string;
  baseUrlOverrideEnvVar?: string;
  defaultRpm: number;
  defaultMaxParallel: number;
}

export interface ClassModel {
  provider: string;
  model: string;
}

// Patch O: per-class arbiter gate defaults. The orchestrator reads
// these when the operator hasn't passed the corresponding CLI flag.
// Calibrated to observed real-data (see config/model-policy.json's
// patch_builder.gates comment for the rationale on the chosen values).
// Operator-passed CLI flags always override.
export interface ClassGates {
  qualityFloor?: number;
  minRubricCoverage?: number;
  minReviewCoverage?: number;
  requireTests?: boolean;
}

export interface ClassEntry {
  summary: string;
  models: ClassModel[];
  maxParallel: number;
  gates?: ClassGates;
}

export interface PolicyDefaults {
  rateLimitTargetFraction: number;
  backoff: { baseMs: number; maxMs: number; factor: number };
  requestTimeoutMs: number;
}

export interface ModelPolicy {
  version: string;
  summary: string;
  providers: Record<string, ProviderEntry>;
  classes: Record<string, ClassEntry>;
  defaults: PolicyDefaults;
}

export interface RegistryOptions {
  policyPath?: string;
  env?: NodeJS.ProcessEnv;
  // Test seam — inject the credential resolver. When `env` is also
  // injected (test mode), the default is a no-op resolver so tests can
  // pin "this env has nothing" without leaking ~/.env. In production
  // (no `env` passed), the default is the real resolver which reads
  // dotenv files.
  resolveCredentialImpl?: (key: string) => string | undefined;
}

export class ModelRegistry {
  readonly policy: ModelPolicy;
  private env: NodeJS.ProcessEnv;
  private resolveCredentialImpl: (key: string) => string | undefined;

  constructor(opts: RegistryOptions = {}) {
    const path = opts.policyPath ?? DEFAULT_POLICY_PATH;
    if (!existsSync(path)) {
      throw new Error(`model-policy.json not found at ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    this.policy = JSON.parse(raw) as ModelPolicy;
    this.env = opts.env ?? process.env;
    // If env is injected explicitly, the resolver defaults to no-op
    // (tests stay hermetic). If env is process.env, the resolver
    // defaults to the real one (production behaviour).
    if (opts.resolveCredentialImpl !== undefined) {
      this.resolveCredentialImpl = opts.resolveCredentialImpl;
    } else if (opts.env !== undefined) {
      this.resolveCredentialImpl = () => undefined;
    } else {
      this.resolveCredentialImpl = resolveCredential;
    }
  }

  listProviderNames(): string[] {
    return Object.keys(this.policy.providers);
  }

  listEnabledProviders(): string[] {
    return Object.entries(this.policy.providers)
      .filter(([, p]) => this.providerEffectivelyEnabled(p))
      .map(([name]) => name);
  }

  providerEntry(name: string): ProviderEntry | null {
    return this.policy.providers[name] ?? null;
  }

  // A provider is effectively enabled iff:
  //   - policy says enabled: true
  //   - any required envKeyVar / fallback resolves (cloud providers)
  //   - or a baseUrl is configured locally (local providers)
  //
  // Patch N (2026-04-27): "resolves" now means via the credential
  // resolver (process.env first, then ~/frontier-os/.env, then ~/.env),
  // not just process.env directly. Pre-Patch-N this method returned
  // false for any provider whose key lived in a dotenv file even
  // though the actual call would have succeeded — confusing.
  providerEffectivelyEnabled(p: ProviderEntry): boolean {
    if (!p.enabled) return false;
    if (p.envKeyVar) {
      const direct = this.lookupCredential(p.envKeyVar);
      const fallback = p.envKeyVarFallback
        ? this.lookupCredential(p.envKeyVarFallback)
        : "";
      if (!direct && !fallback) return false;
    }
    return true;
  }

  // Resolve auth for a provider. Returns the resolved key or null.
  // Goes through the credential resolver (Patch N) so dotenv files
  // are picked up without a manual `export`.
  resolveApiKey(name: string): string | null {
    const entry = this.policy.providers[name];
    if (!entry) return null;
    if (entry.apiKey !== undefined && entry.apiKey !== null) {
      return entry.apiKey;
    }
    if (entry.envKeyVar) {
      const v = this.lookupCredential(entry.envKeyVar);
      if (v) return v;
      if (entry.envKeyVarFallback) {
        const v2 = this.lookupCredential(entry.envKeyVarFallback);
        if (v2) return v2;
      }
    }
    return null;
  }

  // Two-tier lookup: process.env first (allows opts.env test seam
  // and explicit shell exports to override), then the credential
  // resolver (dotenv search path). Returns "" when nothing matches
  // so calling code can keep its existing falsy-check shape.
  private lookupCredential(key: string): string {
    const fromEnv = this.env[key];
    if (fromEnv) return fromEnv;
    const fromResolver = this.resolveCredentialImpl(key);
    return fromResolver ?? "";
  }

  resolveBaseUrl(name: string): string | null {
    const entry = this.policy.providers[name];
    if (!entry) return null;
    if (entry.baseUrlOverrideEnvVar) {
      const override = this.env[entry.baseUrlOverrideEnvVar];
      if (override) return override;
    }
    return entry.baseUrl ?? null;
  }

  classEntry(taskClass: string): ClassEntry | null {
    return this.policy.classes[taskClass] ?? null;
  }

  // Patch O: per-class gate defaults for the arbiter. Returns the
  // class's gates object (possibly empty) or undefined if no class
  // entry exists. Caller decides how to merge with CLI flags + arbiter
  // built-in defaults; this only reports what the policy says.
  classGates(taskClass: string): ClassGates | undefined {
    const entry = this.classEntry(taskClass);
    if (!entry) return undefined;
    return entry.gates ?? undefined;
  }

  // Filter a class's model list to those whose providers are
  // effectively enabled. Order is preserved (policy author intent).
  resolveClassModels(taskClass: string): ClassModel[] {
    const entry = this.classEntry(taskClass);
    if (!entry) return [];
    return entry.models.filter((m) => {
      const p = this.providerEntry(m.provider);
      return p !== null && this.providerEffectivelyEnabled(p);
    });
  }

  defaults(): PolicyDefaults {
    return this.policy.defaults;
  }
}
