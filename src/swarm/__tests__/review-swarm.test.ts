// Review swarm tests. The broker is fully stubbed — these tests exercise
// orchestration (parallel dispatch, JSON parsing, aggregation), not real
// model calls.
//
// We also assert that the JSON-extraction tolerates the common ways
// reviewers wrap their deliverable (markdown fences, leading prose,
// nested objects). Non-JSON output must surface as ok=true with
// output=null and rawText populated, never a crash.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runReviewSwarm,
  renderPrompt,
  tryParseReviewerOutput,
  ReviewSwarmError,
  type ReviewerOutput,
} from "../review-swarm.ts";
import type {
  AttemptRecord,
  BrokerCallOptions,
  BrokerCallResult,
  InferenceBroker,
} from "../../inference/broker.ts";
import type { Skill } from "../../skills/loader.ts";

// --- helpers --------------------------------------------------------------

function syntheticSkill(): Skill {
  return {
    skillId: "adversarial_review",
    version: "v1",
    taskClass: "adversarial_review",
    summary: "test",
    allowedRoles: ["reviewer"],
    allowedTools: ["read.file", "read.repo"],
    forbiddenTools: ["exec.git.push", "launchd.apply"],
    maxParallel: 6,
    sideEffects: ["local_write"],
    verifierMode: "none",
    promptTemplate: "SKILL.md",
    antiExamples: [],
    skillDir: "/tmp/synthetic-skill",
    promptTemplatePath: "/tmp/synthetic-skill/SKILL.md",
  };
}

const TEMPLATE = [
  "Review the diff:",
  "{{diff}}",
  "You are reviewer {{reviewerId}} of {{reviewerCount}}.",
  "patchId: {{patchId}}",
].join("\n");

// Stub broker. Tests enqueue partial responses; the stub constructs a
// proper BrokerCallResult including selectedResponse (the canonical post-
// Patch-A shape). Test inputs may pass `assistantText` (becomes
// selectedResponse.text) or `body` (becomes selectedResponse.rawBody +
// falls back to JSON.stringify for text). Mirroring the broker's real
// normalizeResponse keeps the tests honest about the contract.
interface StubResponse {
  ok?: boolean;
  status?: number;
  modelKey?: string;
  durationMs?: number;
  assistantText?: string;
  body?: unknown;
}

class StubBroker implements Pick<InferenceBroker, "callClass"> {
  private queue: Array<StubResponse> = [];
  private modelKey = "stub:model-1";

  enqueue(...responses: Array<StubResponse>): void {
    this.queue.push(...responses);
  }

  setModelKey(key: string): void {
    this.modelKey = key;
  }

  async callClass(_opts: BrokerCallOptions): Promise<BrokerCallResult> {
    const next = this.queue.shift();
    if (!next) {
      return {
        ok: false,
        taskClass: _opts.taskClass,
        attempts: [],
        selected: null,
        selectedResponse: null,
        totalDurationMs: 1,
        rejected: "all-attempts-failed",
      };
    }
    const record: AttemptRecord = {
      modelKey: next.modelKey ?? this.modelKey,
      provider: "stub",
      model: "model-1",
      attemptNumber: 1,
      bucketGranted: true,
      bucketWaitedMs: 0,
      status: next.status ?? 200,
      ok: next.ok ?? true,
      durationMs: next.durationMs ?? 5,
      retryAfterMs: null,
    };
    let selectedResponse = null;
    if (record.ok) {
      const text =
        next.assistantText ??
        (next.body !== undefined && next.body !== null
          ? JSON.stringify(next.body)
          : "");
      selectedResponse = { text, rawBody: next.body ?? null };
    }
    return {
      ok: record.ok,
      taskClass: _opts.taskClass,
      attempts: [record],
      selected: record.ok ? record : null,
      selectedResponse,
      totalDurationMs: record.durationMs,
      rejected: record.ok ? null : "all-attempts-failed",
    };
  }
}

function deliverable(findings: number, summary = "ok"): string {
  const arr = Array.from({ length: findings }, (_, i) => ({
    category: i % 2 === 0 ? "bug" : "style",
    severity: i % 3 === 0 ? "high" : "low",
    file: `src/file-${i}.ts`,
    line: i + 1,
    claim: `claim-${i}`,
    evidence: `evidence-${i}`,
  }));
  return JSON.stringify({
    reviewerId: "filled-by-aggregator",
    findings: arr,
    verificationsRun: ["exec.typecheck"],
    summary,
  });
}

// --- renderPrompt ---------------------------------------------------------

test("renderPrompt: substitutes known {{vars}}", () => {
  const out = renderPrompt(TEMPLATE, {
    diff: "DIFF",
    reviewerId: "r1",
    reviewerCount: "3",
    patchId: "p-1",
  });
  assert.ok(out.includes("DIFF"));
  assert.ok(out.includes("r1"));
  assert.ok(out.includes("3"));
  assert.ok(out.includes("p-1"));
});

test("renderPrompt: leaves unknown {{vars}} intact", () => {
  const out = renderPrompt("hello {{nope}}", { other: "x" });
  assert.equal(out, "hello {{nope}}");
});

// --- tryParseReviewerOutput ----------------------------------------------

test("tryParseReviewerOutput: bare JSON object", () => {
  const text = deliverable(2);
  const parsed = tryParseReviewerOutput(text, "r1");
  assert.ok(parsed);
  assert.equal(parsed?.findings.length, 2);
  assert.equal(parsed?.summary, "ok");
});

test("tryParseReviewerOutput: JSON wrapped in markdown fences + prose", () => {
  const text = `Here's my review:\n\n\`\`\`json\n${deliverable(1)}\n\`\`\`\nThanks.`;
  const parsed = tryParseReviewerOutput(text, "r1");
  assert.ok(parsed);
  assert.equal(parsed?.findings.length, 1);
});

test("tryParseReviewerOutput: prefers the longest balanced JSON block", () => {
  // Tiny inline {} that's not the deliverable, then the real one.
  const text = `Notes: {} (tbd)\n\n${deliverable(3)}`;
  const parsed = tryParseReviewerOutput(text, "r1");
  assert.ok(parsed);
  assert.equal(parsed?.findings.length, 3);
});

test("tryParseReviewerOutput: missing required fields → null", () => {
  const text = JSON.stringify({ summary: "no findings field" });
  assert.equal(tryParseReviewerOutput(text, "r1"), null);
});

test("tryParseReviewerOutput: non-JSON text → null", () => {
  assert.equal(tryParseReviewerOutput("LGTM, looks good!", "r1"), null);
});

test("tryParseReviewerOutput: reviewerId fallback when missing in payload", () => {
  const text = JSON.stringify({ findings: [], summary: "" });
  const parsed = tryParseReviewerOutput(text, "fallback-id");
  assert.equal(parsed?.reviewerId, "fallback-id");
});

// --- runReviewSwarm: orchestration ---------------------------------------

test("runReviewSwarm: spawns N reviewers in parallel, aggregates findings", async () => {
  const broker = new StubBroker();
  // 3 reviewers, each returns 2 findings.
  for (let i = 0; i < 3; i++) {
    broker.enqueue({
      ok: true,
      status: 200,
      assistantText: deliverable(2, `summary-${i}`),
    });
  }
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline", sizeBytes: 4 },
      reviewerCount: 3,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
      now: () => 1_700_000_000_000,
    },
  );
  assert.equal(packet.reviewerCount, 3);
  assert.equal(packet.reviewers.length, 3);
  for (const r of packet.reviewers) {
    assert.equal(r.ok, true);
    assert.equal(r.output?.findings.length, 2);
  }
  assert.equal(packet.totalFindings, 6);
  assert.equal(packet.taskClass, "adversarial_review");
  assert.deepEqual(packet.modelsUsed, ["stub:model-1"]);
});

test("runReviewSwarm: one reviewer returning non-JSON does not crash the packet", async () => {
  const broker = new StubBroker();
  broker.enqueue({ ok: true, assistantText: deliverable(1) });
  broker.enqueue({ ok: true, assistantText: "I cannot find any issues." });
  broker.enqueue({ ok: true, assistantText: deliverable(2) });
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 3,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  assert.equal(packet.reviewers.length, 3);
  const ok = packet.reviewers.filter((r) => r.ok && r.output);
  assert.equal(ok.length, 2);
  const bad = packet.reviewers.find((r) => r.ok && r.output === null);
  assert.ok(bad);
  assert.equal(bad?.rawText, "I cannot find any issues.");
  assert.match(bad?.errorMessage ?? "", /non-JSON|schema-mismatched/);
  assert.equal(packet.totalFindings, 3); // 1 + 2 from the two parsing reviewers
});

test("runReviewSwarm: broker rejection surfaces as ok=false reviewer", async () => {
  const broker = new StubBroker();
  // First reviewer's broker call returns no models.
  broker.enqueue(); // empty queue → broker returns ok=false
  broker.enqueue({ ok: true, assistantText: deliverable(1) });
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 2,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  const failed = packet.reviewers.find((r) => !r.ok);
  assert.ok(failed);
  assert.match(failed?.errorMessage ?? "", /broker rejected/);
});

test("runReviewSwarm: reviewerCount < 1 throws", async () => {
  const broker = new StubBroker();
  await assert.rejects(
    () =>
      runReviewSwarm(
        { broker: broker as unknown as InferenceBroker },
        {
          diff: "",
          diffSource: { kind: "inline" },
          reviewerCount: 0,
          loadSkillImpl: () => syntheticSkill(),
          loadPromptTemplateImpl: () => TEMPLATE,
        },
      ),
    ReviewSwarmError,
  );
});

test("runReviewSwarm: missing skill for taskClass throws ReviewSwarmError", async () => {
  const broker = new StubBroker();
  await assert.rejects(
    () =>
      runReviewSwarm(
        { broker: broker as unknown as InferenceBroker },
        {
          diff: "",
          diffSource: { kind: "inline" },
          reviewerCount: 1,
          taskClass: "no_such_class",
          loadSkillImpl: () => null,
          loadPromptTemplateImpl: () => TEMPLATE,
        },
      ),
    /no skill found/,
  );
});

test("runReviewSwarm: aggregates findingsBySeverity and findingsByCategory", async () => {
  const broker = new StubBroker();
  // Custom payload — 1 high-bug, 1 low-style, 1 medium-risk.
  const custom = JSON.stringify({
    reviewerId: "r1",
    findings: [
      { category: "bug", severity: "high", claim: "x" },
      { category: "style", severity: "low", claim: "y" },
      { category: "risk", severity: "medium", claim: "z" },
    ],
    summary: "mixed",
  } satisfies ReviewerOutput);
  broker.enqueue({ ok: true, assistantText: custom });
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "",
      diffSource: { kind: "inline" },
      reviewerCount: 1,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  assert.equal(packet.findingsBySeverity.high, 1);
  assert.equal(packet.findingsBySeverity.medium, 1);
  assert.equal(packet.findingsBySeverity.low, 1);
  assert.equal(packet.findingsByCategory.bug, 1);
  assert.equal(packet.findingsByCategory.style, 1);
  assert.equal(packet.findingsByCategory.risk, 1);
  assert.equal(packet.totalFindings, 3);
});

test("runReviewSwarm: body without OpenAI shape and no assistantText → ok=true, output=null, rawText is JSON of body", async () => {
  const broker = new StubBroker();
  // Provider returned a non-OpenAI body; no assistantText was extracted.
  // The review-swarm preserves the raw body as rawText so a human can
  // salvage what the model actually said.
  broker.enqueue({
    ok: true,
    body: { unexpected: "shape", note: "no choices[]" },
  });
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "",
      diffSource: { kind: "inline" },
      reviewerCount: 1,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  const r = packet.reviewers[0];
  assert.ok(r);
  assert.equal(r?.ok, true);
  assert.equal(r?.output, null);
  assert.match(r?.rawText ?? "", /unexpected/);
  assert.match(r?.errorMessage ?? "", /non-JSON|schema-mismatched/);
});
