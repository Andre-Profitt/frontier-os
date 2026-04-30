// factories/ai-radar/source-trust.ts
//
// Trust tier definitions, ordering, and a tier→score mapping.
//
// Why a static tier in v0 (per the handoff spec, Tier section):
//   Tier A: official docs / changelogs / official GitHub release
//     Can trigger upgrade candidate.
//   Tier B: maintainer post / repo issue / release branch / accepted paper
//     Can trigger investigation or eval candidate.
//   Tier C: Discord / YouTube / Twitter / Reddit / newsletter
//     Can trigger research only.
//   Tier D: anonymous rumor / aggregator
//     Store only if corroborated.
//
// PR #8 uses ONLY the declared tier (from sources.json).
//
// PR #9+ will overlay a learned reliability model on top of this
// (see ~/code/apps/radar/radar/calibration/source_quality.py for the
// shape — it is feedback-driven and per (source, predicate)).

import type { TrustTier } from "./types.ts";

/**
 * Tier precedence: index 0 = most trusted, index 3 = least.
 * Used by `trustOrdinal` and `pickTrustTier`.
 */
export const TIER_PRECEDENCE: readonly TrustTier[] = [
  "official",
  "maintainer",
  "community",
  "rumor",
] as const;

export function trustOrdinal(tier: TrustTier): number {
  const idx = TIER_PRECEDENCE.indexOf(tier);
  if (idx < 0) {
    // Unknown tier shouldn't be reachable through the type system, but
    // be defensive: treat as rumor.
    return TIER_PRECEDENCE.length - 1;
  }
  return idx;
}

/**
 * Map a tier to a [0,1] score, monotone with trust.
 * official=1.00, maintainer=0.75, community=0.50, rumor=0.25.
 *
 * The intent is NOT to look like a probability. It is a coarse
 * comparator that the digest/upgrade-planner can use as a default
 * weight before any learned reliability is available.
 */
export function trustScore(tier: TrustTier): number {
  const ordinal = trustOrdinal(tier);
  const span = TIER_PRECEDENCE.length; // 4
  // Map ordinal 0..span-1 → 1.00, 0.75, 0.50, 0.25
  return (span - ordinal) / span;
}

/** Return the more-trusted of two tiers. */
export function pickTrustTier(a: TrustTier, b: TrustTier): TrustTier {
  return trustOrdinal(a) <= trustOrdinal(b) ? a : b;
}
