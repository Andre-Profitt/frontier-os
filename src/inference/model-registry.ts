// Model registry — reads config/model-policy.json and exposes typed
// access to providers, classes, and per-class model lists.
//
// Local-only by default; the registry never enables NIM unless the
// policy explicitly does so AND the env auth is present.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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

export interface ClassEntry {
  summary: string;
  models: ClassModel[];
  maxParallel: number;
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
}

export class ModelRegistry {
  readonly policy: ModelPolicy;
  private env: NodeJS.ProcessEnv;

  constructor(opts: RegistryOptions = {}) {
    const path = opts.policyPath ?? DEFAULT_POLICY_PATH;
    if (!existsSync(path)) {
      throw new Error(`model-policy.json not found at ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    this.policy = JSON.parse(raw) as ModelPolicy;
    this.env = opts.env ?? process.env;
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
  //   - any required envKeyVar / fallback is present (cloud providers)
  //   - or a baseUrl is configured locally (local providers)
  providerEffectivelyEnabled(p: ProviderEntry): boolean {
    if (!p.enabled) return false;
    if (p.envKeyVar) {
      const direct = this.env[p.envKeyVar];
      const fallback = p.envKeyVarFallback ? this.env[p.envKeyVarFallback] : "";
      if (!direct && !fallback) return false;
    }
    return true;
  }

  // Resolve auth for a provider. Returns the resolved key (env-driven)
  // or null for local providers / when missing.
  resolveApiKey(name: string): string | null {
    const entry = this.policy.providers[name];
    if (!entry) return null;
    if (entry.apiKey !== undefined && entry.apiKey !== null) {
      return entry.apiKey;
    }
    if (entry.envKeyVar) {
      const v = this.env[entry.envKeyVar];
      if (v) return v;
      if (entry.envKeyVarFallback) {
        const v2 = this.env[entry.envKeyVarFallback];
        if (v2) return v2;
      }
    }
    return null;
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
