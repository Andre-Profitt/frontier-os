// NVIDIA NIM provider. NIM exposes an OpenAI-compatible inference API
// (POST /v1/chat/completions, /v1/models, /v1/embeddings) per the
// official docs, so we extend the generic OpenAI-compatible client and
// only override the auth/base-URL defaults.
//
// Auth resolution order (Patch N):
//   1. process.env.NVIDIA_API_KEY
//   2. process.env.NIM_API_KEY
//   3. ~/frontier-os/.env (frontier-os override location)
//   4. ~/.env (home-level global)
//
// The dotenv search path comes from src/core/credentials.ts, the same
// resolver every other adapter uses. Pre-Patch-N this provider read
// process.env directly, which meant operators with NVIDIA_API_KEY in
// ~/.env had to remember to `export` it before invoking the CLI. The
// resolver makes the dotenv files first-class.
//
// Base URL: https://integrate.api.nvidia.com/v1 by default; can be
// overridden for self-hosted NIM containers via NIM_BASE_URL.

import { resolveCredential } from "../../core/credentials.ts";
import {
  OpenAICompatibleProvider,
  type ProviderConfig,
} from "./openai-compatible.ts";

export const NIM_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export interface NIMConfigSource {
  // Test seam — inject env. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
  // Test seam — inject fetch.
  fetchImpl?: typeof fetch;
  // Test seam — inject the credential resolver. Defaults to the real
  // one (process.env first, then dotenv search path).
  resolveCredentialImpl?: (key: string) => string | undefined;
}

export function resolveNIMConfig(source: NIMConfigSource = {}): ProviderConfig {
  const env = source.env ?? process.env;
  const resolve = source.resolveCredentialImpl ?? resolveCredential;
  // env takes priority (test seam ergonomics + explicit-export wins),
  // resolver is the dotenv fallback.
  const apiKey =
    env.NVIDIA_API_KEY ??
    env.NIM_API_KEY ??
    resolve("NVIDIA_API_KEY") ??
    resolve("NIM_API_KEY");
  const baseUrl =
    env.NIM_BASE_URL ?? resolve("NIM_BASE_URL") ?? NIM_DEFAULT_BASE_URL;
  const config: ProviderConfig = { baseUrl };
  if (apiKey) config.apiKey = apiKey;
  if (source.fetchImpl) config.fetchImpl = source.fetchImpl;
  return config;
}

export class NvidiaNIMProvider extends OpenAICompatibleProvider {
  constructor(source: NIMConfigSource = {}) {
    super("nvidia-nim", resolveNIMConfig(source));
  }
}
