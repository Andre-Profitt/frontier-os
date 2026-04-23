// Failure Refinery — Registry (Phase 6.4).
//
// Append-only JSONL stores for rule proposals and promoted (active) rules.
// Files live at:
//   ~/.frontier/refinery/proposals.jsonl
//   ~/.frontier/refinery/rules.jsonl
//
// "Append-only" means we never rewrite either file — every state change is
// a new line. Promotion copies the proposal's JSON into rules.jsonl with
// `promotedAt` and leaves the proposal row intact in proposals.jsonl.
// Revocation (not yet implemented) will append a tombstone line with
// `{ ruleId, revokedAt }` rather than deleting.
//
// Uniqueness: ruleId is deterministic (see rules.ts#deriveRuleId), so
// re-running the Refinery on the same failure pattern produces the same
// ruleId. `appendProposal` is idempotent per ruleId — second call with the
// same id is a no-op and returns { appended: false }.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import type { PolicyRuleProposal } from "./rules.ts";

export interface PromotedRule extends PolicyRuleProposal {
  promotedAt: string;
  promotedBy: string;
}

export interface AppendProposalResult {
  appended: boolean;
  ruleId: string;
  path: string;
  /** Null if the file had no prior entry for this ruleId. */
  duplicateOf: string | null;
}

export interface PromoteResult {
  promoted: boolean;
  ruleId: string;
  rule: PromotedRule | null;
  /** "already_promoted" | "not_proposed" | "ok" */
  status: "ok" | "already_promoted" | "not_proposed";
}

export interface RefineryPaths {
  root: string;
  proposals: string;
  rules: string;
  revocations: string;
}

export interface RuleTombstone {
  ruleId: string;
  revokedAt: string;
  revokedBy: string;
  reason: string;
}

export interface RevokeResult {
  revoked: boolean;
  ruleId: string;
  tombstone: RuleTombstone | null;
  /** "ok" | "already_revoked" | "not_promoted" */
  status: "ok" | "already_revoked" | "not_promoted";
}

const REFINERY_SESSION_LABEL = "refinery";

/** Return resolved directory + file paths, creating parents if missing. */
export function defaultPaths(rootDir?: string): RefineryPaths {
  const root = rootDir ?? resolve(homedir(), ".frontier", "refinery");
  mkdirSync(root, { recursive: true });
  return {
    root,
    proposals: resolve(root, "proposals.jsonl"),
    rules: resolve(root, "rules.jsonl"),
    revocations: resolve(root, "rules-revoked.jsonl"),
  };
}

/** Load every revocation tombstone. Latest row per ruleId wins (append-only). */
export function loadTombstones(rootDir?: string): RuleTombstone[] {
  const paths = defaultPaths(rootDir);
  const lines = readJsonlLines(paths.revocations);
  const seen = new Map<string, RuleTombstone>();
  for (const line of lines) {
    const obj = safeParse<RuleTombstone>(line);
    if (!obj || typeof obj.ruleId !== "string") continue;
    seen.set(obj.ruleId, obj);
  }
  return [...seen.values()];
}

/** Load every proposal currently on disk, oldest first. Dedup on ruleId (latest wins). */
export function loadProposals(rootDir?: string): PolicyRuleProposal[] {
  const paths = defaultPaths(rootDir);
  const lines = readJsonlLines(paths.proposals);
  const seen = new Map<string, PolicyRuleProposal>();
  for (const line of lines) {
    const obj = safeParse<PolicyRuleProposal>(line);
    if (!obj || typeof obj.ruleId !== "string") continue;
    seen.set(obj.ruleId, obj);
  }
  return [...seen.values()];
}

/**
 * Load every currently-active rule. Latest row per ruleId wins; any rule
 * with a tombstone in rules-revoked.jsonl is filtered out unless
 * `includeRevoked` is set. Autopromote + rule-matching both see the
 * filtered view so a revoked rule stops firing.
 */
export function loadRules(
  rootDir?: string,
  opts: { includeRevoked?: boolean } = {},
): PromotedRule[] {
  const paths = defaultPaths(rootDir);
  const lines = readJsonlLines(paths.rules);
  const seen = new Map<string, PromotedRule>();
  for (const line of lines) {
    const obj = safeParse<PromotedRule>(line);
    if (!obj || typeof obj.ruleId !== "string") continue;
    seen.set(obj.ruleId, obj);
  }
  if (opts.includeRevoked) return [...seen.values()];
  const revoked = new Set(loadTombstones(rootDir).map((t) => t.ruleId));
  return [...seen.values()].filter((r) => !revoked.has(r.ruleId));
}

/**
 * Append a proposal. Idempotent per ruleId — re-seeing the same signature
 * won't duplicate rows, though it WILL refresh the evidence (we write a
 * new row with the updated count/lastSeen, and the loader picks the latest).
 *
 * Set `allowRefresh: false` to hard-skip any ruleId we've seen before.
 */
export function appendProposal(
  proposal: PolicyRuleProposal,
  opts: { rootDir?: string; allowRefresh?: boolean; actor?: string } = {},
): AppendProposalResult {
  const paths = defaultPaths(opts.rootDir);
  const allowRefresh = opts.allowRefresh ?? true;

  const existing = loadProposals(opts.rootDir).find(
    (p) => p.ruleId === proposal.ruleId,
  );
  if (existing && !allowRefresh) {
    return {
      appended: false,
      ruleId: proposal.ruleId,
      path: paths.proposals,
      duplicateOf: existing.ruleId,
    };
  }

  appendFileSync(paths.proposals, JSON.stringify(proposal) + "\n");
  emitRefineryEvent(
    "refinery.proposal_appended",
    {
      ruleId: proposal.ruleId,
      sourceKind: proposal.pattern.kind,
      suggestedAction: proposal.suggestedAction,
      count: proposal.evidence.count,
      refresh: Boolean(existing),
    },
    opts.actor ?? "refinery.registry",
  );

  return {
    appended: true,
    ruleId: proposal.ruleId,
    path: paths.proposals,
    duplicateOf: existing ? existing.ruleId : null,
  };
}

/**
 * Promote a proposal to an active rule. Appends one row to rules.jsonl and
 * emits a `refinery.rule_promoted` ledger event. Safe to re-run — a second
 * call returns { status: "already_promoted" } without another ledger write.
 */
export function promoteProposal(
  ruleId: string,
  opts: {
    rootDir?: string;
    promotedBy?: string;
    actor?: string;
  } = {},
): PromoteResult {
  const paths = defaultPaths(opts.rootDir);
  const already = loadRules(opts.rootDir).find((r) => r.ruleId === ruleId);
  if (already) {
    return {
      promoted: false,
      ruleId,
      rule: already,
      status: "already_promoted",
    };
  }
  const proposal = loadProposals(opts.rootDir).find((p) => p.ruleId === ruleId);
  if (!proposal) {
    return {
      promoted: false,
      ruleId,
      rule: null,
      status: "not_proposed",
    };
  }

  const promoted: PromotedRule = {
    ...proposal,
    promotedAt: new Date().toISOString(),
    promotedBy: opts.promotedBy ?? "operator",
  };
  appendFileSync(paths.rules, JSON.stringify(promoted) + "\n");
  emitRefineryEvent(
    "refinery.rule_promoted",
    {
      ruleId,
      sourceKind: proposal.pattern.kind,
      suggestedAction: proposal.suggestedAction,
      promotedBy: promoted.promotedBy,
    },
    opts.actor ?? "refinery.registry",
  );

  return { promoted: true, ruleId, rule: promoted, status: "ok" };
}

/**
 * Revoke a previously-promoted rule. Appends a tombstone row to
 * rules-revoked.jsonl and emits `refinery.rule_revoked`. Revocation is
 * idempotent — a second call returns `{ status: "already_revoked" }` with no
 * new row and no new event. Revocation is sticky: once revoked, the rule
 * stays filtered out of `loadRules()` (the default view) even if autopromote
 * would re-promote it after N passing nights.
 */
export function revokeRule(
  ruleId: string,
  opts: {
    rootDir?: string;
    revokedBy?: string;
    reason?: string;
    actor?: string;
  } = {},
): RevokeResult {
  const paths = defaultPaths(opts.rootDir);
  const tombstones = loadTombstones(opts.rootDir);
  const already = tombstones.find((t) => t.ruleId === ruleId);
  if (already) {
    return {
      revoked: false,
      ruleId,
      tombstone: already,
      status: "already_revoked",
    };
  }

  // loadRules({includeRevoked:true}) — we want to check existence, not the
  // filtered view, so the caller gets an accurate "not_promoted" vs
  // "already_revoked" distinction.
  const existing = loadRules(opts.rootDir, { includeRevoked: true }).find(
    (r) => r.ruleId === ruleId,
  );
  if (!existing) {
    return {
      revoked: false,
      ruleId,
      tombstone: null,
      status: "not_promoted",
    };
  }

  const tombstone: RuleTombstone = {
    ruleId,
    revokedAt: new Date().toISOString(),
    revokedBy: opts.revokedBy ?? "operator",
    reason: opts.reason ?? "",
  };
  appendFileSync(paths.revocations, JSON.stringify(tombstone) + "\n");
  emitRefineryEvent(
    "refinery.rule_revoked",
    {
      ruleId,
      revokedBy: tombstone.revokedBy,
      reason: tombstone.reason,
      suggestedAction: existing.suggestedAction,
      wasPromotedBy: existing.promotedBy,
    },
    opts.actor ?? "refinery.registry",
  );

  return { revoked: true, ruleId, tombstone, status: "ok" };
}

// ---- Internal helpers ----

function readJsonlLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

function safeParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/**
 * Emit a `refinery.*` ledger event. The EventKind union in events.ts does
 * NOT yet list these kinds — per Phase 6.4 constraints we are not allowed
 * to modify that file — so we cast the kind to `any` at the call site.
 * When the merge snippet lands, the cast becomes a no-op.
 */
function emitRefineryEvent(
  kind: string,
  payload: Record<string, unknown>,
  actor: string,
): void {
  try {
    const ledger = getLedger();
    const sessionId = newSessionId(REFINERY_SESSION_LABEL);
    ledger.ensureSession({
      sessionId,
      label: REFINERY_SESSION_LABEL,
      tags: ["refinery"],
    });
    ledger.appendEvent({
      sessionId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: kind as any,
      actor,
      payload,
    });
  } catch {
    // Ledger writes are best-effort — if the DB is locked or missing the
    // registry still appends to disk. Callers don't rely on event-order
    // side effects from this module.
  }
}

/** Ensure the parent dir of a path exists. Small helper used by callers. */
export function ensureRefineryDir(rootDir?: string): string {
  const paths = defaultPaths(rootDir);
  mkdirSync(dirname(paths.proposals), { recursive: true });
  return paths.root;
}
