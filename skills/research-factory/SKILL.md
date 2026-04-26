---
name: research-factory
description: Build a research run as durable artifacts — claim ledger, source ledger, packet markdown, review markdown — never as a chat-only summary. Claim-level memory beats report-level memory.
---

# research-factory

A normal AI research session produces a report and disappears. A dark
factory needs **claim-level memory** so later factories can reuse
findings without rereading the whole report. This skill governs the
artifact shape that makes that reuse possible.

## When to use

- The user asks "what should we know before building X?", "survey
  these tools", "find prior art for Y"
- A factory design decision depends on evidence (model choice,
  vendor, integration target, threshold)
- A claim is going to land in a SKILL.md, AGENTS.md hard rule, eval
  rubric, or anti-example — these need a citable origin

## Forbidden moves

- **Never write a report in chat without persisting claims.** The
  artifacts are the deliverable; the chat narrative is ephemeral.
- **Never cite a source without an entry in the source ledger.** If
  it's not in the source ledger, it doesn't exist for downstream
  consumers.
- **Never write a claim with no support entry.** Sourceless claims
  are rumor. The schema rejects them on append.
- **Never paste a long quote (>35 words) into `quoteOrSummary`.** The
  field is a substantiation hook, not a transcript. Summaries are
  fine; long quotes are not.
- **Never integrate an upstream tool (STORM, GPT Researcher,
  PaperQA2, Agent Laboratory, AI Scientist) without a claim ledger
  entry justifying the choice.** Integrating a tool is itself a
  decision that needs evidence.
- **Never edit an existing claim or source record in place.** The
  ledgers are append-only; corrections create a new record with
  `supersedes` pointing at the prior id.

## Exact commands

```bash
# 1. Lay out a fresh run directory + seeded markdown.
#    Programmatic — call from a worker or test:
node --import tsx -e '
  import { createPacket } from "./research/research-packet.ts";
  const layout = createPacket({
    rootDir: "research",
    topic: "your-topic-here",
    spec: {
      schema: "frontier_os.research.packet_spec.v1",
      question: "<the specific question>",
      scope: "<what is in vs out>",
      motivation: "<which lane will consume this>",
      acceptance: [
        "<criterion 1 — needs at least one supporting claim>",
        "<criterion 2 — ...>"
      ],
      tags: ["<tag1>", "<tag2>"]
    }
  });
  console.log(JSON.stringify(layout, null, 2));
'

# 2. Append claims and sources as you find evidence.
#    Use appendSource BEFORE appendClaim so the claim's support[].sourceId
#    resolves to a real ledger entry.

# 3. Verify the packet is internally consistent.
node --import tsx -e '
  import { createPacket, computeCompleteness } from "./research/research-packet.ts";
  // load the layout you saved earlier or recreate it from the run dir
  // ... then:
  const r = computeCompleteness(layout);
  console.log(JSON.stringify(r, null, 2));
'
```

A complete report has:

- `status: "complete"` (no orphaned claims, no unmet acceptance)
- `orphanedClaimIds: []`
- `unmetAcceptance: []`

`status: "broken"` means at least one claim points at a sourceId
that's not in the source ledger — fix before review.

## Artifact format (canonical)

Each run lives at `research/runs/<slug>-<runId>/` and contains:

| File                   | Schema marker                            |
| ---------------------- | ---------------------------------------- |
| `claim-ledger.ndjson`  | `frontier_os.research.claim_record.v1`   |
| `source-ledger.ndjson` | `frontier_os.research.source_record.v1`  |
| `research-packet.md`   | (markdown narrative; cites by `claimId`) |
| `review.md`            | (markdown adversarial pass)              |

The schema marker is on every record. Consumers MUST check the schema
marker before parsing — adding a field is a v2 bump, not a silent edit.

## Required evidence

A "research is done" claim needs:

- `computeCompleteness(layout).status === "complete"`
- Acceptance criteria all marked `[x]` in `research-packet.md`
- Adversarial review pass complete in `review.md` (every checkbox
  ticked or its non-applicability noted)
- Sources span at least two independent providers (not all from the
  same vendor / blog / org)
- At least one claim has a non-empty `usedFor` pointing at the lane
  this research is going to influence — research with no consumer
  is recreational

## Common anti-patterns

- "I read three papers and here's a summary" — no claim ledger. The
  next agent can't reuse the findings.
- "All my sources are from one vendor's blog" — single-vendor
  evidence is propaganda. Get one independent counter-source per
  major claim or downgrade confidence.
- "I'll just edit the old claim record to update it" — destroys the
  audit trail. Use `supersedes`.
- "The report is in the chat thread; the ledger is empty" — chat
  scrolls. Write the artifacts.

## Verification before reporting

```bash
# Acceptance check + status check before declaring done.
node --import tsx -e '
  import { computeCompleteness } from "./research/research-packet.ts";
  // Reconstruct the layout from the run dir paths and call:
  const r = computeCompleteness(layout);
  if (r.status !== "complete") {
    console.error("packet not complete:", r);
    process.exit(1);
  }
'
```

If status is not "complete", fix the gap before reporting findings.

## Scope (this PR)

This skill defines the artifact format only. Upstream tool
integrations (STORM-style outline, GPT Researcher web pipeline,
PaperQA2 paper RAG, Agent Laboratory experiments) come in later PRs
under `research/adapters/`. The format must be stable first so later
adapters write to a known shape.

## References

- Research-factory tests: `tests/research/ledgers.test.ts`,
  `tests/research/packet.test.ts`
- Templates: `research/templates/research-packet.md`,
  `research/templates/claim-ledger.example.json`
- Architecture: `feedback_dark_factory_rip_and_repurpose_2026-04-26.md`
  (memory) — the loops library context
