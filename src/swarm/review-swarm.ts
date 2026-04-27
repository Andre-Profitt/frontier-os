// Review swarm — N parallel reviewers attack one diff via the broker.
//
// Pattern (per the architecture critique):
//   - load skill `adversarial_review` from src/skills/loader.ts
//   - interpolate the diff into the skill's prompt template
//   - dispatch N parallel broker.callClass({taskClass}) calls
//   - parse each reviewer's JSON deliverable per skills/adversarial_review/SKILL.md
//   - aggregate into a ReviewPacket (schema: review-packet.schema.json)
//
// Reviewers are read-only — they don't write to the repo, don't spawn
// worktrees, don't mutate state. The PermissionGate could still be applied
// at the broker call boundary, but for v1 the skill's allowedTools list
// alone is sufficient (review reads files, doesn't write).
//
// The broker is injected so tests can use a stub. Production callers
// build a default broker once and reuse it.

import { readFileSync } from "node:fs";

import type { InferenceBroker } from "../inference/broker.ts";
import { loadPromptTemplate, loadSkill, type Skill } from "../skills/loader.ts";

export type FindingCategory =
  | "bug"
  | "contract_violation"
  | "false_green"
  | "risk"
  | "style";

export type FindingSeverity = "high" | "medium" | "low";

export interface Finding {
  category: FindingCategory;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  claim: string;
  evidence?: string;
  antiExample?: string;
}

export interface ReviewerOutput {
  patchId?: string;
  reviewerId: string;
  findings: Finding[];
  verificationsRun?: string[];
  summary: string;
}

export interface ReviewerRun {
  reviewerId: string;
  modelKey?: string;
  ok: boolean;
  elapsedMs?: number;
  errorMessage?: string;
  output?: ReviewerOutput | null;
  rawText?: string;
}

export interface DiffSource {
  kind: "file" | "stdin" | "ref" | "inline";
  path?: string;
  ref?: string;
  sizeBytes?: number;
}

export interface ReviewPacket {
  packetId: string;
  scannedAt: string;
  taskClass: string;
  diffSource: DiffSource;
  reviewerCount: number;
  // Reviewers whose JSON deliverable parsed cleanly into a ReviewerOutput.
  validReviewerCount: number;
  // Reviewers that returned ok=true but text was unparseable; rawText kept.
  invalidReviewerCount: number;
  // Reviewers where the broker call itself failed (rejection or exception).
  failedReviewerCount: number;
  // validReviewerCount / reviewerCount. Arbiter MUST gate on this before
  // treating an empty findings list as 'reviewClean' — otherwise every
  // reviewer returning unparseable text aggregates to totalFindings=0
  // (false clean). See GPT Pro review Issue #2.
  reviewCoverage: number;
  modelsUsed: string[];
  reviewers: ReviewerRun[];
  totalFindings: number;
  findingsBySeverity: Record<FindingSeverity, number>;
  findingsByCategory: Record<string, number>;
  elapsedMs: number;
}

export interface ReviewSwarmInput {
  // Unified diff text. Caller is responsible for resolving --diff <path> /
  // git ref → string.
  diff: string;
  // Where the diff came from (for the packet's audit trail).
  diffSource: DiffSource;
  // Number of parallel reviewers. Defaults to 3.
  reviewerCount?: number;
  // Override task class. Defaults to "adversarial_review".
  taskClass?: string;
  // Optional packet ID. Defaults to a slug-safe timestamp+random.
  packetId?: string;
  // Optional patch ID — surfaced to reviewers for citation.
  patchId?: string;
  // Optional task ID — passed to the reviewer prompt's {{taskId}} slot.
  // The skill template uses it for context ("reviewer of patchX on
  // taskY"). Defaults to "" if not provided; missing-variable
  // substitution would otherwise leave the literal `{{taskId}}` in
  // the prompt, which models treat as documentation noise.
  taskId?: string;
  // Patch P: pin specific models per reviewer for true adversarial
  // diversity. Distributed round-robin: reviewer i uses
  // reviewerModelKeys[i % reviewerModelKeys.length]. When undefined,
  // the broker picks the policy primary for every reviewer (the prior
  // pre-Patch-P behavior — all reviewers funnel to the same model,
  // which defeats the policy's "diversity matters more than raw
  // quality" comment on adversarial_review).
  reviewerModelKeys?: string[];
  // Patch V: structured record of the builder's self-verification —
  // typecheck/test exit codes captured by the builder swarm and
  // formatted by the orchestrator. Renders into the reviewer prompt's
  // {{builderVerificationRecord}} slot. Pre-Patch-V this was always
  // empty because the orchestrator didn't extract it; reviewers
  // therefore couldn't cross-check the builder's claimed exit codes
  // against the diff content, contributing to false-positive bug
  // findings. When undefined, falls back to "" (legacy behavior).
  builderVerificationRecord?: string;
  // Test seam: load a Skill instead of going to disk. Default: loadSkill(taskClass).
  loadSkillImpl?: (taskClass: string) => Skill | null;
  // Test seam: load the SKILL.md prose body. Default: loadPromptTemplate(skill).
  loadPromptTemplateImpl?: (skill: Skill) => string;
  // Test seam.
  now?: () => number;
}

export interface ReviewSwarmDeps {
  broker: InferenceBroker;
}

export class ReviewSwarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSwarmError";
  }
}

const DEFAULT_REVIEWER_COUNT = 3;
const DEFAULT_TASK_CLASS = "adversarial_review";

export async function runReviewSwarm(
  deps: ReviewSwarmDeps,
  input: ReviewSwarmInput,
): Promise<ReviewPacket> {
  const now = input.now ?? Date.now;
  const taskClass = input.taskClass ?? DEFAULT_TASK_CLASS;
  const reviewerCount = input.reviewerCount ?? DEFAULT_REVIEWER_COUNT;
  const packetId = input.packetId ?? newPacketId(now());
  const patchId = input.patchId ?? packetId;

  if (reviewerCount < 1) {
    throw new ReviewSwarmError(
      `reviewerCount must be ≥ 1; got ${reviewerCount}`,
    );
  }

  const loadSkillFn = input.loadSkillImpl ?? loadSkill;
  const loadTemplateFn = input.loadPromptTemplateImpl ?? loadPromptTemplate;

  const skill = loadSkillFn(taskClass);
  if (!skill) {
    throw new ReviewSwarmError(
      `no skill found for taskClass "${taskClass}" — author skills/${taskClass}/skill.json`,
    );
  }
  const promptTemplate = loadTemplateFn(skill);

  const t0 = now();

  // Spawn N reviewer calls in parallel. Each gets its own reviewerId; the
  // broker handles per-class concurrency — its semaphore is the truth on
  // how many run at once.
  const reviewerModelKeys = input.reviewerModelKeys ?? [];
  const reviewerPromises = Array.from({ length: reviewerCount }).map(
    async (_, i): Promise<ReviewerRun> => {
      const reviewerId = `r${i + 1}`;
      const tStart = now();
      const pinnedModelKey =
        reviewerModelKeys.length > 0
          ? reviewerModelKeys[i % reviewerModelKeys.length]
          : undefined;
      const filledPrompt = renderPrompt(promptTemplate, {
        diff: input.diff,
        reviewerId,
        reviewerCount: String(reviewerCount),
        patchId,
        taskId: input.taskId ?? "",
        // Patch V: pass the orchestrator-formatted verification record
        // through to the reviewer prompt. Falls back to "" when the
        // caller didn't supply one (e.g. tests that exercise the swarm
        // in isolation, or pre-Patch-V orchestrator paths). Empty
        // string still substitutes cleanly so the literal placeholder
        // `{{builderVerificationRecord}}` never reaches the model.
        builderVerificationRecord: input.builderVerificationRecord ?? "",
      });
      try {
        const callRes = await deps.broker.callClass({
          taskClass,
          messages: [{ role: "user", content: filledPrompt }],
          ...(pinnedModelKey !== undefined
            ? { modelOverride: pinnedModelKey }
            : {}),
        });
        const elapsedMs = now() - tStart;
        if (!callRes.ok || !callRes.selected) {
          // Patch R blocker #3: when the reviewer was pinned via
          // round-robin, attribute the failure to the *intended* model.
          // Without this, the quality ledger's model_event aggregation
          // drops failures for the pinned model entirely (modelKey
          // undefined → "if (!reviewer.modelKey) continue;" in
          // writer.ts), making pinned-reviewer failure rates invisible.
          // Don't invent a modelKey for unpinned calls — undefined is
          // the correct signal there.
          return {
            reviewerId,
            ...(pinnedModelKey !== undefined
              ? { modelKey: pinnedModelKey }
              : {}),
            ok: false,
            elapsedMs,
            errorMessage: `broker rejected: ${callRes.rejected ?? "unknown"}`,
          };
        }
        const rawText = callRes.selectedResponse?.text ?? "";
        const parsed = tryParseReviewerOutput(rawText, reviewerId);
        const run: ReviewerRun = {
          reviewerId,
          modelKey: callRes.selected.modelKey,
          ok: true,
          elapsedMs,
        };
        if (parsed) {
          run.output = parsed;
        } else {
          run.output = null;
          run.rawText = rawText;
          run.errorMessage =
            "reviewer returned non-JSON or schema-mismatched text; rawText preserved";
        }
        return run;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Same attribution rule as the broker-rejection branch above.
        return {
          reviewerId,
          ...(pinnedModelKey !== undefined ? { modelKey: pinnedModelKey } : {}),
          ok: false,
          elapsedMs: now() - tStart,
          errorMessage: `exception during broker call: ${message}`,
        };
      }
    },
  );

  const reviewers = await Promise.all(reviewerPromises);

  const elapsedMs = now() - t0;

  // Aggregate.
  const modelsUsed = Array.from(
    new Set(
      reviewers
        .map((r) => r.modelKey)
        .filter((m): m is string => typeof m === "string"),
    ),
  ).sort();
  const findingsBySeverity: Record<FindingSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  const findingsByCategory: Record<string, number> = {};
  let totalFindings = 0;
  let validReviewerCount = 0;
  let invalidReviewerCount = 0;
  let failedReviewerCount = 0;
  for (const r of reviewers) {
    if (!r.ok) {
      failedReviewerCount += 1;
      continue;
    }
    // ok=true with output=null means broker call succeeded but the text
    // could not be parsed as a ReviewerOutput. The arbiter must NOT treat
    // this as "reviewer found nothing" — it's "reviewer didn't review."
    if (!r.output) {
      invalidReviewerCount += 1;
      continue;
    }
    validReviewerCount += 1;
    for (const f of r.output.findings) {
      totalFindings += 1;
      findingsBySeverity[f.severity] =
        (findingsBySeverity[f.severity] ?? 0) + 1;
      findingsByCategory[f.category] =
        (findingsByCategory[f.category] ?? 0) + 1;
    }
  }
  const reviewCoverage =
    reviewerCount > 0 ? validReviewerCount / reviewerCount : 0;

  return {
    packetId,
    scannedAt: new Date(now()).toISOString(),
    taskClass,
    diffSource: input.diffSource,
    reviewerCount,
    validReviewerCount,
    invalidReviewerCount,
    failedReviewerCount,
    reviewCoverage,
    modelsUsed,
    reviewers,
    totalFindings,
    findingsBySeverity,
    findingsByCategory,
    elapsedMs,
  };
}

// --- prompt rendering ----------------------------------------------------

// Substitute {{key}} with values. Unknown keys are left intact so missing
// substitutions surface in the model output rather than crashing here.
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/{{(\w+)}}/g, (match, key) => {
    return key in vars ? (vars[key] ?? match) : match;
  });
}

// --- JSON extraction -----------------------------------------------------

// The skill's prompt template asks for JSON; models still wrap it in
// markdown fences sometimes. Extract the first balanced `{...}` block.
// Returns null if no candidate parses or the parsed object isn't shaped
// like a ReviewerOutput.
// Allowed enum values, kept here so the validator stays a single source
// of truth. Mirrors review-packet.schema.json $defs.finding.
const FINDING_CATEGORIES: ReadonlySet<string> = new Set<FindingCategory>([
  "bug",
  "contract_violation",
  "false_green",
  "risk",
  "style",
]);
const FINDING_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>([
  "high",
  "medium",
  "low",
]);

// Validate a single finding against the schema enums + required-claim
// rule. v1: any malformed finding poisons the WHOLE reviewer output —
// "valid reviewer" must mean every finding is valid. (GPT Pro Patch-E
// review item E3.) Without this, `category: "contract violation"` (with
// space) parses as a generic string and counts as valid coverage, but
// the arbiter never sees a contract_violation finding → false-clean
// recreated.
function isValidFinding(raw: unknown): raw is Finding {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.category !== "string" || !FINDING_CATEGORIES.has(r.category))
    return false;
  if (typeof r.severity !== "string" || !FINDING_SEVERITIES.has(r.severity))
    return false;
  if (typeof r.claim !== "string" || r.claim.trim().length === 0) return false;
  // Optional fields: type-check only if present.
  if (r.file !== undefined && typeof r.file !== "string") return false;
  if (r.line !== undefined && typeof r.line !== "number") return false;
  if (r.evidence !== undefined && typeof r.evidence !== "string") return false;
  if (r.antiExample !== undefined && typeof r.antiExample !== "string")
    return false;
  return true;
}

export function tryParseReviewerOutput(
  text: string,
  reviewerIdFallback: string,
): ReviewerOutput | null {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const findingsRaw = Array.isArray(parsed.findings)
        ? parsed.findings
        : null;
      const summary =
        typeof parsed.summary === "string" ? parsed.summary : null;
      if (findingsRaw === null || summary === null) continue;

      // Validate every finding. Any bad finding fails the whole output —
      // we don't half-accept reviewers. (Reviewer either followed the
      // contract or didn't.) See E3 rationale above.
      let allValid = true;
      for (const f of findingsRaw) {
        if (!isValidFinding(f)) {
          allValid = false;
          break;
        }
      }
      if (!allValid) continue;
      const findings = findingsRaw as Finding[];

      return {
        ...(typeof parsed.patchId === "string"
          ? { patchId: parsed.patchId }
          : {}),
        reviewerId:
          typeof parsed.reviewerId === "string"
            ? parsed.reviewerId
            : reviewerIdFallback,
        findings,
        ...(Array.isArray(parsed.verificationsRun)
          ? { verificationsRun: parsed.verificationsRun as string[] }
          : {}),
        summary,
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// Pull every plausible {...} JSON block out of the raw text. Order: longest
// first, since reviewers may emit chatter wrapping the JSON.
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return candidates.sort((a, b) => b.length - a.length);
}

// Note: the previous `extractText` helper was removed when Patch A
// introduced BrokerCallResult.selectedResponse. Callers now read
// callRes.selectedResponse?.text directly — one canonical shape, no
// per-consumer re-extraction.

function newPacketId(nowMs: number): string {
  const ts = Math.floor(nowMs / 1000).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `review-${ts}-${rand}`;
}
