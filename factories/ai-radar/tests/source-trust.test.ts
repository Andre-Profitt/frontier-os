// factories/ai-radar/tests/source-trust.test.ts
//
// Pure-function tests for source-trust.ts. No network, no filesystem.
//
// Run:
//   node --import tsx --test factories/ai-radar/tests/source-trust.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  trustScore,
  trustOrdinal,
  pickTrustTier,
  TIER_PRECEDENCE,
} from "../source-trust.ts";
import type { TrustTier } from "../types.ts";

test("TIER_PRECEDENCE is ordered official > maintainer > community > rumor", () => {
  assert.deepEqual(TIER_PRECEDENCE, [
    "official",
    "maintainer",
    "community",
    "rumor",
  ]);
});

test("trustOrdinal: lower index for more-trusted tier", () => {
  assert.equal(trustOrdinal("official"), 0);
  assert.equal(trustOrdinal("maintainer"), 1);
  assert.equal(trustOrdinal("community"), 2);
  assert.equal(trustOrdinal("rumor"), 3);
});

test("trustScore: official is highest, rumor is lowest, monotone", () => {
  const off = trustScore("official");
  const main = trustScore("maintainer");
  const com = trustScore("community");
  const rum = trustScore("rumor");
  assert.ok(off > main, `official=${off} should exceed maintainer=${main}`);
  assert.ok(main > com, `maintainer=${main} should exceed community=${com}`);
  assert.ok(com > rum, `community=${com} should exceed rumor=${rum}`);
});

test("trustScore: scores stay in [0,1]", () => {
  const tiers: TrustTier[] = ["official", "maintainer", "community", "rumor"];
  for (const t of tiers) {
    const s = trustScore(t);
    assert.ok(s >= 0 && s <= 1, `tier=${t} score=${s} out of [0,1]`);
  }
});

test("pickTrustTier: most-trusted of two wins", () => {
  assert.equal(pickTrustTier("official", "rumor"), "official");
  assert.equal(pickTrustTier("rumor", "official"), "official");
  assert.equal(pickTrustTier("maintainer", "community"), "maintainer");
  assert.equal(pickTrustTier("community", "community"), "community");
});

test("pickTrustTier across the full ladder", () => {
  // Just sanity-check that picking among all four returns "official".
  const tiers: TrustTier[] = ["rumor", "community", "maintainer", "official"];
  let acc: TrustTier = "rumor";
  for (const t of tiers) {
    acc = pickTrustTier(acc, t);
  }
  assert.equal(acc, "official");
});
