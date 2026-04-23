// Failure Refinery — Rule Proposer (Phase 6.4).
//
// Take `HarvestedSignal[]` from the harvester and propose typed policy rules.
// One rule per signal that crosses the minFrequency threshold. Each proposal
// is advisory — the `registry.ts` append-only store persists them; an
// operator (or a future auto-promote policy) decides which ones go live.
//
// Suggested actions are the four levers the Refinery can pull:
//
//   add_rubric_pattern    — extend the verifier's trace_grade rubric with a
//                           new red-flag regex so the next run catches the
//                           same mistake at verification time.
//   reject_in_ghost_shift — refuse to run graphs that match the pattern
//                           during overnight autonomy.
//   raise_approval_class  — bump the effective approval class for matching
//                           nodes so they land in the human-review queue.
//   add_pre_tool_hook     — register a pre-tool hook that blocks the action
//                           entirely (for agent.* failures).
//
// Mapping: kind -> default action. Operators override by editing the
// proposals JSONL before promotion; we never silently change a proposal
// after it's written.

import type { HarvestedSignal } from "./harvester.ts";

export type SuggestedAction =
  | "add_rubric_pattern"
  | "reject_in_ghost_shift"
  | "raise_approval_class"
  | "add_pre_tool_hook";

export interface RulePattern {
  /** Source event kind this rule applies to. */
  kind: string;
  /** Optional verifier check / rejection code name. */
  checkName?: string;
  /** JS-compatible regex source that should match the event's reason line. */
  reasonRegex: string;
}

export interface PolicyRuleProposal {
  /** Deterministic id derived from the signal signature — stable across runs. */
  ruleId: string;
  pattern: RulePattern;
  /** Short human-readable rationale. */
  reason: string;
  suggestedAction: SuggestedAction;
  evidence: {
    signature: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    exampleEventIds: string[];
    exampleReasons: string[];
  };
  proposedAt: string;
}

export interface ProposeOptions {
  /** Minimum occurrences before we propose a rule. Default 2. */
  minFrequency?: number;
  /** Override "now" for deterministic tests. */
  nowIso?: string;
}

const DEFAULT_MIN_FREQUENCY = 2;

/** Primary entrypoint — turn signals into rule proposals. */
export function proposeRules(
  signals: HarvestedSignal[],
  opts: ProposeOptions = {},
): PolicyRuleProposal[] {
  const minFreq = opts.minFrequency ?? DEFAULT_MIN_FREQUENCY;
  const now = opts.nowIso ?? new Date().toISOString();

  const proposals: PolicyRuleProposal[] = [];
  for (const signal of signals) {
    if (signal.count < minFreq) continue;
    proposals.push(buildProposal(signal, now));
  }
  // Highest-count first so operators see the worst offenders when they cat
  // the proposals file.
  return proposals.sort((a, b) =>
    a.evidence.count === b.evidence.count
      ? a.evidence.lastSeen < b.evidence.lastSeen
        ? 1
        : -1
      : b.evidence.count - a.evidence.count,
  );
}

function buildProposal(
  signal: HarvestedSignal,
  nowIso: string,
): PolicyRuleProposal {
  const suggestedAction = chooseAction(signal);
  const reasonRegex = buildReasonRegex(signal.reasonNormalized);
  const pattern: RulePattern = {
    kind: signal.sourceKind,
    reasonRegex,
  };
  if (signal.checkName) pattern.checkName = signal.checkName;

  const ruleId = deriveRuleId(signal.signature);

  return {
    ruleId,
    pattern,
    reason: summarizeReason(signal),
    suggestedAction,
    evidence: {
      signature: signal.signature,
      count: signal.count,
      firstSeen: signal.firstSeen,
      lastSeen: signal.lastSeen,
      exampleEventIds: [...signal.exampleEventIds],
      exampleReasons: [...signal.exampleReasons],
    },
    proposedAt: nowIso,
  };
}

/**
 * Pick the default lever for a given signal. This is a heuristic, not a
 * policy — operators always get the final call.
 */
function chooseAction(signal: HarvestedSignal): SuggestedAction {
  if (
    signal.sourceKind === "work.verifier_fail" ||
    signal.sourceKind === "work.verifier_check"
  ) {
    // The verifier already caught this; tighten the rubric so we catch the
    // same class earlier.
    if (signal.checkName === "trace_grade") return "add_rubric_pattern";
    // Other verifier checks usually want human review.
    return "raise_approval_class";
  }
  if (signal.sourceKind === "ghost.graph_rejected") {
    return "reject_in_ghost_shift";
  }
  if (signal.sourceKind === "work.node_failed") {
    return "raise_approval_class";
  }
  if (signal.sourceKind === "work.node_skipped") {
    // Skips usually mean a dep failed — raising approval on the originating
    // branch forces a human to look.
    return "raise_approval_class";
  }
  if (signal.sourceKind === "agent.review") {
    return "add_pre_tool_hook";
  }
  return "raise_approval_class";
}

/**
 * Build a regex source that will match reasons normalized the same way the
 * harvester did. We escape regex metachars and re-anchor the placeholder
 * tokens (`<n>`, `<id>`, `<path>`, `<ts>`) as `.*` so downstream matchers
 * survive variation in those slots.
 */
export function buildReasonRegex(normalized: string): string {
  if (!normalized) return ".*";
  const placeholders: Record<string, string> = {
    "<n>": "\\S+",
    "<id>": "\\S+",
    "<path>": "\\S+",
    "<ts>": "\\S+",
  };
  // Protect placeholders with a sentinel that can't appear after regex escape.
  const sentinels: Array<[string, string]> = [];
  let i = 0;
  let working = normalized;
  for (const token of Object.keys(placeholders)) {
    while (working.includes(token)) {
      const sentinel = `__PH${i++}__`;
      sentinels.push([sentinel, placeholders[token]!]);
      working = working.replace(token, sentinel);
    }
  }
  let escaped = escapeRegex(working);
  for (const [sentinel, replacement] of sentinels) {
    escaped = escaped.replace(sentinel, replacement);
  }
  return `^${escaped}$`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeReason(signal: HarvestedSignal): string {
  const first = signal.exampleReasons[0] ?? signal.reasonNormalized;
  const tail =
    signal.count === 1 ? "1 occurrence" : `${signal.count} occurrences`;
  const check = signal.checkName ? ` (${signal.checkName})` : "";
  return `${signal.sourceKind}${check}: ${first} — ${tail}`;
}

/**
 * Deterministic, filesystem-safe rule id. We fold the signature through a
 * simple fnv-1a 32-bit hash so the id stays stable across runs of the same
 * signature but never leaks raw user paths/content into filenames.
 */
export function deriveRuleId(signature: string): string {
  return `rule_${fnv1a32(signature).toString(16).padStart(8, "0")}`;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit multiply by 0x01000193.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Exposed for tests. */
export const __test__ = {
  chooseAction,
  buildReasonRegex,
  escapeRegex,
  deriveRuleId,
  fnv1a32,
};
