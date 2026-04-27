#!/usr/bin/env tsx
// One-off live probe against NIM. Uses the production capacity-probe code
// but constructs the provider directly so we don't have to flip
// config/model-policy.json (and remember to revert it).
//
// Usage:
//   NVIDIA_API_KEY=... node --import tsx scripts/probe-nim.ts [model] [budget]
//
// Defaults: model=openai/gpt-oss-120b, budget=60 calls.
//
// Writes the merged record into state/inference/model-capacity.json (the
// same file the broker will eventually read at startup).

import { NvidiaNIMProvider } from "../src/inference/providers/nvidia-nim.ts";
import {
  probeModelCapacity,
  loadCapacityFile,
  mergeCapacityRecord,
  saveCapacityFile,
  DEFAULT_CAPACITY_PATH,
} from "../src/inference/capacity-probe.ts";

const model = process.argv[2] ?? "openai/gpt-oss-120b";
const budget = parseInt(process.argv[3] ?? "60", 10);

if (!process.env.NVIDIA_API_KEY && !process.env.NIM_API_KEY) {
  console.error(
    "NVIDIA_API_KEY (or NIM_API_KEY) must be set in the environment",
  );
  process.exit(2);
}

console.error(
  `probing nvidia-nim:${model} with budgetCalls=${budget}, latencySamples=3, rampSequence=[5,10,20,40,60,80]…`,
);

const provider = new NvidiaNIMProvider();
const t0 = Date.now();
const record = await probeModelCapacity({
  provider,
  model,
  budgetCalls: budget,
  latencySamples: 3,
  rampSequence: [5, 10, 20, 40, 60, 80],
  rateLimitTargetFraction: 0.65,
});
const elapsed = Date.now() - t0;

let file = loadCapacityFile(DEFAULT_CAPACITY_PATH);
file = mergeCapacityRecord(file, record);
file.scanner = {
  rateLimitTargetFraction: 0.65,
  budgetCallsPerModel: budget,
  latencySamples: 3,
};
saveCapacityFile(DEFAULT_CAPACITY_PATH, file);

console.log(
  JSON.stringify(
    {
      modelKey: record.modelKey,
      available: record.available,
      probeWallClockMs: elapsed,
      latency: record.latency,
      rateLimit: record.rateLimit,
      errors: record.errors,
      writtenTo: DEFAULT_CAPACITY_PATH,
    },
    null,
    2,
  ),
);
