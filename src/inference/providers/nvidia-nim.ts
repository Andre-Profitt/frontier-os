// NVIDIA NIM provider. NIM exposes an OpenAI-compatible inference API
// (POST /v1/chat/completions, /v1/models, /v1/embeddings) per the
// official docs, so we extend the generic OpenAI-compatible client and
// only override the auth/base-URL defaults.
//
// Auth: prefers NVIDIA_API_KEY, falls back to NIM_API_KEY.
// Base URL: https://integrate.api.nvidia.com/v1 by default; can be
// overridden for self-hosted NIM containers via NIM_BASE_URL.

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
}

export function resolveNIMConfig(source: NIMConfigSource = {}): ProviderConfig {
  const env = source.env ?? process.env;
  const apiKey = env.NVIDIA_API_KEY ?? env.NIM_API_KEY;
  const baseUrl = env.NIM_BASE_URL ?? NIM_DEFAULT_BASE_URL;
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
