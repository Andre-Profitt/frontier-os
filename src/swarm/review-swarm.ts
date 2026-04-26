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
  const reviewerPromises = Array.from({ length: reviewerCount }).map(
    async (_, i): Promise<ReviewerRun> => {
      const reviewerId = `r${i + 1}`;
      const tStart = now();
      const filledPrompt = renderPrompt(promptTemplate, {
        diff: input.diff,
        reviewerId,
        reviewerCount: String(reviewerCount),
        patchId,
      });
      try {
        const callRes = await deps.broker.callClass({
          taskClass,
          messages: [{ role: "user", content: filledPrompt }],
        });
        const elapsedMs = now() - tStart;
        if (!callRes.ok || !callRes.selected) {
          return {
            reviewerId,
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
        return {
          reviewerId,
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
  for (const r of reviewers) {
    if (!r.output) continue;
    for (const f of r.output.findings) {
      totalFindings += 1;
      findingsBySeverity[f.severity] =
        (findingsBySeverity[f.severity] ?? 0) + 1;
      findingsByCategory[f.category] =
        (findingsByCategory[f.category] ?? 0) + 1;
    }
  }

  return {
    packetId,
    scannedAt: new Date(now()).toISOString(),
    taskClass,
    diffSource: input.diffSource,
    reviewerCount,
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
export function tryParseReviewerOutput(
  text: string,
  reviewerIdFallback: string,
): ReviewerOutput | null {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const findings = Array.isArray(parsed.findings)
        ? (parsed.findings as Finding[])
        : null;
      const summary =
        typeof parsed.summary === "string" ? parsed.summary : null;
      if (findings === null || summary === null) continue;
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
