// Load and validate adapter manifests from ./manifests/adapters/*.adapter.json
// and route invocations to the right adapter implementation.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  validateAdapterManifest,
  type AdapterInvocation,
  type AdapterManifest,
  type AdapterResult,
} from "./schemas.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_DIR = resolve(__dirname, "..", "manifests", "adapters");

export interface AdapterImpl {
  manifest: AdapterManifest;
  invoke(invocation: AdapterInvocation): Promise<AdapterResult>;
}

type AdapterFactory = (manifest: AdapterManifest) => Promise<AdapterImpl>;

const factories: Record<string, AdapterFactory> = {
  browser: async (manifest) => {
    const mod = await import("./adapters/browser/index.ts");
    return mod.createBrowserAdapter(manifest);
  },
  salesforce: async (manifest) => {
    const mod = await import("./adapters/salesforce/index.ts");
    return mod.createSalesforceAdapter(manifest);
  },
  runpod: async (manifest) => {
    const mod = await import("./adapters/runpod/index.ts");
    return mod.createRunpodAdapter(manifest);
  },
  github: async (manifest) => {
    const mod = await import("./adapters/github/index.ts");
    return mod.createGithubAdapter(manifest);
  },
  terminal: async (manifest) => {
    const mod = await import("./adapters/terminal/index.ts");
    return mod.createTerminalAdapter(manifest);
  },
  research: async (manifest) => {
    const mod = await import("./adapters/research/index.ts");
    return mod.createResearchAdapter(manifest);
  },
  nvidia: async (manifest) => {
    const mod = await import("./adapters/nvidia/index.ts");
    return mod.createNvidiaAdapter(manifest);
  },
  kaggle: async (manifest) => {
    const mod = await import("./adapters/kaggle/index.ts");
    return mod.createKaggleAdapter(manifest);
  },
  databricks: async (manifest) => {
    const mod = await import("./adapters/databricks/index.ts");
    return mod.createDatabricksAdapter(manifest);
  },
  sigma: async (manifest) => {
    const mod = await import("./adapters/sigma/index.ts");
    return mod.createSigmaAdapter(manifest);
  },
  azure: async (manifest) => {
    const mod = await import("./adapters/azure/index.ts");
    return mod.createAzureAdapter(manifest);
  },
};

export function loadManifests(): AdapterManifest[] {
  const files = readdirSync(MANIFEST_DIR).filter((f) =>
    f.endsWith(".adapter.json"),
  );
  const manifests: AdapterManifest[] = [];
  for (const file of files) {
    const path = resolve(MANIFEST_DIR, file);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!validateAdapterManifest(raw)) {
      throw new Error(
        `manifest ${file} failed schema validation: ${JSON.stringify(
          validateAdapterManifest.errors,
          null,
          2,
        )}`,
      );
    }
    manifests.push(raw as AdapterManifest);
  }
  return manifests.sort((a, b) => a.adapterId.localeCompare(b.adapterId));
}

export function findManifest(adapterId: string): AdapterManifest {
  const all = loadManifests();
  const found = all.find((m) => m.adapterId === adapterId);
  if (!found) throw new Error(`unknown adapter: ${adapterId}`);
  return found;
}

export async function resolveAdapter(adapterId: string): Promise<AdapterImpl> {
  const manifest = findManifest(adapterId);
  const factory = factories[adapterId];
  if (!factory) {
    throw new Error(
      `adapter ${adapterId} has a manifest but no implementation yet`,
    );
  }
  return factory(manifest);
}

export function adapterCommandSpec(manifest: AdapterManifest, command: string) {
  const spec = manifest.commands.find((c) => c.command === command);
  if (!spec) {
    throw new Error(
      `adapter ${manifest.adapterId} does not expose command "${command}"`,
    );
  }
  return spec;
}
