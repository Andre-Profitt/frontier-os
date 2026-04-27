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
  // Patch P regression hook: every callClass invocation pushes its
  // modelOverride here (or undefined when caller didn't pin). Tests
  // can read this to assert reviewer round-robin distribution.
  readonly seenModelOverrides: Array<string | undefined> = [];

  enqueue(...responses: Array<StubResponse>): void {
    this.queue.push(...responses);
  }

  setModelKey(key: string): void {
    this.modelKey = key;
  }

  async callClass(_opts: BrokerCallOptions): Promise<BrokerCallResult> {
    this.seenModelOverrides.push(_opts.modelOverride);
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

// Patch P: reviewerModelKeys distributes round-robin across reviewers.
// Pre-Patch-P, all reviewers funneled to the broker's primary; this
// pins the new diversity contract.
test("runReviewSwarm (Patch P): reviewerModelKeys round-robin per reviewer", async () => {
  const broker = new StubBroker();
  for (let i = 0; i < 3; i++) {
    broker.enqueue({ ok: true, assistantText: deliverable(1, `s${i}`) });
  }
  await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline", sizeBytes: 4 },
      reviewerCount: 3,
      reviewerModelKeys: ["nim:A", "nim:B"], // 2 keys, 3 reviewers → wrap
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
      now: () => 1_700_000_000_000,
    },
  );
  // r1 → A, r2 → B, r3 → A (wrap)
  assert.deepEqual(broker.seenModelOverrides, ["nim:A", "nim:B", "nim:A"]);
});

test("runReviewSwarm (Patch P): no reviewerModelKeys → no modelOverride passed (broker primary)", async () => {
  // Pin the back-compat path: when caller doesn't list models, every
  // reviewer call gets `undefined` for modelOverride and the broker
  // picks the policy primary.
  const broker = new StubBroker();
  for (let i = 0; i < 2; i++) {
    broker.enqueue({ ok: true, assistantText: deliverable(1) });
  }
  await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline", sizeBytes: 4 },
      reviewerCount: 2,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
      now: () => 1_700_000_000_000,
    },
  );
  assert.deepEqual(broker.seenModelOverrides, [undefined, undefined]);
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

// --- Patch V: builderVerificationRecord pass-through to reviewer prompt --

test("runReviewSwarm (Patch V): builderVerificationRecord input is rendered into reviewer prompt", async () => {
  // Pre-Patch-V the reviewer template's {{builderVerificationRecord}}
  // slot was always empty — the orchestrator didn't extract the
  // builder's verification data. Now the orchestrator can pass a
  // structured record (formatted from candidate.builderVerification)
  // and reviewers actually see what the builder claimed.
  const broker = new StubBroker();
  broker.enqueue({ ok: true, assistantText: deliverable(0) });
  // Capture the rendered prompt by stubbing loadPromptTemplate.
  const TEMPLATE_WITH_SLOT =
    "Diff:\n{{diff}}\n\nVerification:\n{{builderVerificationRecord}}";
  let capturedPrompt = "";
  const originalCallClass = broker.callClass.bind(broker);
  broker.callClass = async (opts) => {
    const msg = opts.messages?.[0];
    if (msg && typeof msg.content === "string") capturedPrompt = msg.content;
    return originalCallClass(opts);
  };
  const verificationRecord =
    "typecheck: exit_code=0 (passed)\ntests: exit_code=0 (passed)\nran_at: 2026-04-27T00:00:00.000Z";
  await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 1,
      builderVerificationRecord: verificationRecord,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE_WITH_SLOT,
    },
  );
  assert.match(capturedPrompt, /typecheck: exit_code=0/);
  assert.match(capturedPrompt, /tests: exit_code=0/);
  // Slot is fully substituted — no literal `{{builderVerificationRecord}}` left.
  assert.doesNotMatch(capturedPrompt, /\{\{builderVerificationRecord\}\}/);
});

test("runReviewSwarm (Patch V): builderVerificationRecord undefined → empty string substituted (regression)", async () => {
  // Backwards compatible: callers that don't pass the new field still
  // get the prior behavior — slot renders empty rather than leaking
  // the literal `{{builderVerificationRecord}}` into the prompt.
  const broker = new StubBroker();
  broker.enqueue({ ok: true, assistantText: deliverable(0) });
  const TEMPLATE_WITH_SLOT =
    "Diff:\n{{diff}}\n\nVerification:\n{{builderVerificationRecord}}";
  let capturedPrompt = "";
  const originalCallClass = broker.callClass.bind(broker);
  broker.callClass = async (opts) => {
    const msg = opts.messages?.[0];
    if (msg && typeof msg.content === "string") capturedPrompt = msg.content;
    return originalCallClass(opts);
  };
  await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 1,
      // builderVerificationRecord omitted
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE_WITH_SLOT,
    },
  );
  // Slot substituted with empty string — no literal placeholder visible.
  assert.doesNotMatch(capturedPrompt, /\{\{builderVerificationRecord\}\}/);
  // The "Verification:" label is present but followed by empty content.
  assert.match(capturedPrompt, /Verification:\n\s*$/);
});

// --- Patch R blocker #3: pinned reviewer modelKey on failure ----

test("runReviewSwarm (Patch R): pinned reviewer + broker rejection → modelKey=pinnedModelKey on failed run", async () => {
  // Pin the contract: when reviewerModelKeys is set, the round-robin
  // model assignment must survive even when the broker call fails.
  // Without this, model_event aggregation in the quality ledger loses
  // the pinned-reviewer failure signal — failure rates for the
  // intentionally-targeted model become invisible.
  // Note: reviewers run via Promise.all and call broker.callClass in
  // map-index order synchronously. Queue order is FIFO. Enqueue ok:false
  // FIRST so reviewer 1 (modelKey nim:A) gets the rejection.
  const broker = new StubBroker();
  broker.enqueue({ ok: false }); // reviewer 1 → broker returns ok=false
  broker.enqueue({ ok: true, assistantText: deliverable(1) }); // reviewer 2 → ok
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 2,
      reviewerModelKeys: ["nim:A", "nim:B"],
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  const failed = packet.reviewers.find((r) => !r.ok);
  assert.ok(failed, "expected one failed reviewer");
  assert.equal(
    failed?.modelKey,
    "nim:A",
    "failed pinned reviewer must carry its assigned modelKey for ledger attribution",
  );
});

test("runReviewSwarm (Patch R): pinned reviewer + broker exception → modelKey=pinnedModelKey on failed run", async () => {
  // Same contract for the exception path (callClass throws). Use a
  // broker that throws on the first call and succeeds on the second.
  class ThrowingBroker {
    private calls = 0;
    async callClass(opts: BrokerCallOptions): Promise<BrokerCallResult> {
      this.calls += 1;
      if (this.calls === 1) {
        throw new Error("network down");
      }
      const record: AttemptRecord = {
        modelKey: opts.modelOverride ?? "stub:default",
        provider: "stub",
        model: "model-1",
        attemptNumber: 1,
        bucketGranted: true,
        bucketWaitedMs: 0,
        status: 200,
        ok: true,
        durationMs: 5,
        retryAfterMs: null,
      };
      return {
        ok: true,
        taskClass: opts.taskClass,
        attempts: [record],
        selected: record,
        selectedResponse: { text: deliverable(1), rawBody: null },
        totalDurationMs: 5,
        rejected: null,
      };
    }
  }
  const broker = new ThrowingBroker();
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 2,
      reviewerModelKeys: ["nim:A", "nim:B"],
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  const failed = packet.reviewers.find((r) => !r.ok);
  assert.ok(failed, "expected one failed reviewer");
  assert.equal(
    failed?.modelKey,
    "nim:A",
    "failed pinned reviewer (exception path) must carry its assigned modelKey",
  );
  assert.match(failed?.errorMessage ?? "", /network down/);
});

test("runReviewSwarm (Patch R): unpinned reviewer + broker rejection → modelKey undefined (no regression)", async () => {
  // Non-regression: when no reviewerModelKeys is set, failed reviewers
  // still leave modelKey undefined. The fix only attributes failures
  // to the *known* pinned key — it must NOT invent a key for unpinned
  // calls.
  const broker = new StubBroker();
  broker.enqueue(); // ok=false
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 1,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  const failed = packet.reviewers[0];
  assert.equal(failed?.ok, false);
  assert.equal(failed?.modelKey, undefined);
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

// --- finding schema validation (Patch E1 / GPT Pro Blocker #3) ----------
//
// Pre-Patch-E1, tryParseReviewerOutput accepted any object with a
// findings[] array and a summary string — without checking that each
// finding's category/severity matched the schema enums. A reviewer
// returning `category: "contract violation"` (with space) parsed as
// "valid coverage" but its finding never reached the arbiter properly,
// recreating the false-clean trap that Patch B was supposed to close.

test("tryParseReviewerOutput: invalid severity → null (whole reviewer poisoned)", () => {
  const bad = JSON.stringify({
    findings: [{ category: "bug", severity: "HIGH", claim: "case wrong" }],
    summary: "x",
  });
  assert.equal(tryParseReviewerOutput(bad, "r1"), null);
});

test("tryParseReviewerOutput: invalid category → null", () => {
  const bad = JSON.stringify({
    findings: [
      { category: "contract violation", severity: "high", claim: "space" },
    ],
    summary: "x",
  });
  assert.equal(tryParseReviewerOutput(bad, "r1"), null);
});

test("tryParseReviewerOutput: empty claim → null", () => {
  const bad = JSON.stringify({
    findings: [{ category: "bug", severity: "high", claim: "" }],
    summary: "x",
  });
  assert.equal(tryParseReviewerOutput(bad, "r1"), null);
});

test("tryParseReviewerOutput: missing claim → null", () => {
  const bad = JSON.stringify({
    findings: [{ category: "bug", severity: "high" }],
    summary: "x",
  });
  assert.equal(tryParseReviewerOutput(bad, "r1"), null);
});

test("tryParseReviewerOutput: wrong type for line → null", () => {
  const bad = JSON.stringify({
    findings: [{ category: "bug", severity: "high", claim: "x", line: "12" }],
    summary: "x",
  });
  assert.equal(tryParseReviewerOutput(bad, "r1"), null);
});

test("tryParseReviewerOutput: one bad + one good finding → null (any-bad poisons all)", () => {
  // The whole reviewer either followed the contract or didn't — no
  // partial credit. v1 design: half-accepting a reviewer makes the
  // arbiter's reviewClean signal much harder to reason about.
  const mixed = JSON.stringify({
    findings: [
      { category: "bug", severity: "high", claim: "good one" },
      { category: "BAD_CATEGORY", severity: "high", claim: "bad one" },
    ],
    summary: "x",
  });
  assert.equal(tryParseReviewerOutput(mixed, "r1"), null);
});

test("tryParseReviewerOutput: all valid findings → still accepted", () => {
  const ok = JSON.stringify({
    findings: [
      {
        category: "bug",
        severity: "high",
        claim: "real finding",
        file: "x.ts",
        line: 5,
      },
      { category: "contract_violation", severity: "medium", claim: "another" },
    ],
    summary: "x",
  });
  const parsed = tryParseReviewerOutput(ok, "r1");
  assert.ok(parsed);
  assert.equal(parsed?.findings.length, 2);
});

test("runReviewSwarm: reviewer returning malformed severity → invalidReviewerCount, coverage drops", async () => {
  // End-to-end: the swarm sees the malformed output as invalid
  // (output=null, rawText preserved). Coverage drops below 1.0. Arbiter
  // would catch this via the reviewCoverage gate (Patch B+D).
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: deliverable(1), // valid
  });
  broker.enqueue({
    ok: true,
    assistantText: JSON.stringify({
      findings: [{ category: "bug", severity: "HIGH", claim: "case wrong" }],
      summary: "x",
    }),
  });
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
  assert.equal(packet.validReviewerCount, 1);
  assert.equal(packet.invalidReviewerCount, 1);
  assert.equal(packet.reviewCoverage, 0.5);
  // The valid reviewer's finding still reached the aggregate.
  assert.equal(packet.findingsByCategory["bug"], 1);
  assert.equal(packet.findingsBySeverity.high, 1);
});

test("runReviewSwarm: valid high-severity bug reaches the aggregate (regression check)", async () => {
  // Make sure the stricter validator doesn't accidentally drop legitimate
  // findings.
  const broker = new StubBroker();
  broker.enqueue({
    ok: true,
    assistantText: JSON.stringify({
      findings: [
        {
          category: "contract_violation",
          severity: "high",
          claim: "real defect",
          file: "src/foo.ts",
          line: 42,
        },
      ],
      summary: "found one",
    }),
  });
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline" },
      reviewerCount: 1,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  assert.equal(packet.validReviewerCount, 1);
  assert.equal(packet.totalFindings, 1);
  assert.equal(packet.findingsByCategory["contract_violation"], 1);
  assert.equal(packet.findingsBySeverity.high, 1);
});

// --- coverage fields (Patch B / GPT Pro Issue #2) ------------------------

test("runReviewSwarm: all reviewers return parseable JSON → reviewCoverage=1.0, validReviewerCount=N", async () => {
  const broker = new StubBroker();
  for (let i = 0; i < 3; i++) {
    broker.enqueue({ ok: true, assistantText: deliverable(1) });
  }
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
  assert.equal(packet.validReviewerCount, 3);
  assert.equal(packet.invalidReviewerCount, 0);
  assert.equal(packet.failedReviewerCount, 0);
  assert.equal(packet.reviewCoverage, 1);
});

test("runReviewSwarm: all reviewers return non-JSON → reviewCoverage=0, totalFindings=0 — must NOT look 'clean'", async () => {
  // The whole point of GPT Pro Issue #2: an arbiter reading totalFindings=0
  // from this packet without consulting reviewCoverage would falsely
  // conclude "no findings" when the truth is "no reviewer actually reviewed."
  const broker = new StubBroker();
  for (let i = 0; i < 3; i++) {
    broker.enqueue({ ok: true, assistantText: "I have no thoughts." });
  }
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
  assert.equal(packet.validReviewerCount, 0);
  assert.equal(packet.invalidReviewerCount, 3);
  assert.equal(packet.failedReviewerCount, 0);
  assert.equal(packet.reviewCoverage, 0);
  assert.equal(packet.totalFindings, 0); // looks clean — but coverage is 0
});

test("runReviewSwarm: broker rejection counts toward failedReviewerCount, not invalidReviewerCount", async () => {
  const broker = new StubBroker();
  broker.enqueue({ ok: true, assistantText: deliverable(1) });
  broker.enqueue(); // empty queue → ok=false (broker rejection)
  broker.enqueue({ ok: true, assistantText: "unparseable" });
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
  assert.equal(packet.validReviewerCount, 1);
  assert.equal(packet.invalidReviewerCount, 1);
  assert.equal(packet.failedReviewerCount, 1);
  assert.ok(Math.abs(packet.reviewCoverage - 1 / 3) < 1e-6);
});

test("runReviewSwarm: packet validates against review-packet.schema.json (with coverage fields)", async () => {
  const { validateReviewPacket } = await import("../../schemas.ts");
  const broker = new StubBroker();
  broker.enqueue({ ok: true, assistantText: deliverable(2) });
  broker.enqueue({ ok: true, assistantText: "garbage" });
  const packet = await runReviewSwarm(
    { broker: broker as unknown as InferenceBroker },
    {
      diff: "DIFF",
      diffSource: { kind: "inline", sizeBytes: 4 },
      reviewerCount: 2,
      loadSkillImpl: () => syntheticSkill(),
      loadPromptTemplateImpl: () => TEMPLATE,
    },
  );
  const valid = validateReviewPacket(packet);
  if (!valid) {
    console.error(JSON.stringify(validateReviewPacket.errors, null, 2));
  }
  assert.equal(valid, true);
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
