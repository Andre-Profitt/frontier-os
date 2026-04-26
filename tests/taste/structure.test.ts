// Structural tests for the taste library.
//
// Phase 5 ships content (rubrics + anti-examples) rather than code. These
// tests enforce the canonical shape documented in taste/README.md so an
// edit that breaks the schema is caught at typecheck/test time rather than
// at "the next agent reads it" time.
//
// Run:
//   node --import tsx --test tests/taste/structure.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
const TASTE_DIR = resolve(REPO_ROOT, "taste");
const RUBRICS_DIR = resolve(TASTE_DIR, "rubrics");
const ANTI_EXAMPLES_DIR = resolve(TASTE_DIR, "anti_examples");

interface RubricFile {
  rubricId: string;
  version: string;
  summary: string;
  criteria: Array<{
    id: string;
    title: string;
    rationale: string;
    weight: number;
  }>;
  non_goals: string[];
  calibration?: {
    exemplar?: string;
    exemplars?: string[];
    anti_examples?: string[];
  };
}

function listJson(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => resolve(dir, f));
}

function listMarkdown(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => resolve(dir, f));
}

// --- top-level layout -----------------------------------------------------

test("taste/ exists with the expected subdirectories and README", () => {
  assert.ok(statSync(TASTE_DIR).isDirectory());
  assert.ok(statSync(RUBRICS_DIR).isDirectory());
  assert.ok(statSync(ANTI_EXAMPLES_DIR).isDirectory());
  assert.ok(statSync(resolve(TASTE_DIR, "README.md")).isFile());
});

test("taste/README.md mentions both rubrics and anti_examples", () => {
  const md = readFileSync(resolve(TASTE_DIR, "README.md"), "utf8");
  assert.match(md, /rubrics\//);
  assert.match(md, /anti_examples\//);
});

// --- rubric schema --------------------------------------------------------

test("every rubric JSON file conforms to the canonical schema", () => {
  const files = listJson(RUBRICS_DIR);
  assert.ok(files.length >= 2, "expected at least 2 rubrics");
  for (const path of files) {
    const raw = readFileSync(path, "utf8");
    let parsed: RubricFile;
    try {
      parsed = JSON.parse(raw) as RubricFile;
    } catch (e) {
      assert.fail(
        `${basename(path)}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    assert.equal(
      typeof parsed.rubricId,
      "string",
      `${basename(path)}: rubricId must be a string`,
    );
    assert.ok(
      parsed.rubricId.length > 0,
      `${basename(path)}: rubricId must be non-empty`,
    );
    assert.match(
      parsed.version,
      /^v\d+$/,
      `${basename(path)}: version must match v<int>`,
    );
    assert.equal(typeof parsed.summary, "string");
    assert.ok(
      parsed.summary.length > 0,
      `${basename(path)}: summary must be non-empty`,
    );
    assert.ok(
      Array.isArray(parsed.criteria),
      `${basename(path)}: criteria must be array`,
    );
    assert.ok(
      parsed.criteria.length > 0,
      `${basename(path)}: criteria array must be non-empty`,
    );
    assert.ok(
      Array.isArray(parsed.non_goals),
      `${basename(path)}: non_goals must be array`,
    );

    const seen = new Set<string>();
    for (const c of parsed.criteria) {
      assert.match(
        c.id,
        /^[A-Z]\d+$/,
        `${basename(path)}: criterion id ${c.id} must match ^[A-Z]\\d+$`,
      );
      assert.ok(
        !seen.has(c.id),
        `${basename(path)}: duplicate criterion id ${c.id}`,
      );
      seen.add(c.id);
      assert.equal(typeof c.title, "string");
      assert.ok(
        c.title.length > 0,
        `${basename(path)}: ${c.id} title must be non-empty`,
      );
      assert.equal(typeof c.rationale, "string");
      assert.ok(
        c.rationale.length > 0,
        `${basename(path)}: ${c.id} rationale must be non-empty`,
      );
      assert.equal(typeof c.weight, "number");
      assert.ok(
        c.weight >= 1,
        `${basename(path)}: ${c.id} weight must be >= 1`,
      );
      assert.ok(
        Number.isInteger(c.weight),
        `${basename(path)}: ${c.id} weight must be integer`,
      );
    }
  }
});

test("factory_run rubric exists with R1..R10 covering the load-bearing properties", () => {
  const path = resolve(RUBRICS_DIR, "factory_run_rubric.json");
  const r = JSON.parse(readFileSync(path, "utf8")) as RubricFile;
  assert.equal(r.rubricId, "factory_run");
  const ids = new Set(r.criteria.map((c) => c.id));
  for (const required of ["R1", "R2", "R3", "R4"]) {
    assert.ok(ids.has(required), `factory_run rubric missing ${required}`);
  }
  // Heavyweight criteria must include the no-false-green and wrong-layer guards.
  const heavy = r.criteria.filter((c) => c.weight >= 2).map((c) => c.id);
  assert.ok(
    heavy.length >= 2,
    "factory_run rubric must have >= 2 heavyweight criteria",
  );
  // R4 (passed implies invariants) must be heavyweight — that's the load-bearing property.
  const r4 = r.criteria.find((c) => c.id === "R4");
  assert.ok(
    r4 && r4.weight >= 2,
    "R4 (passed implies invariants) must be weight >= 2",
  );
});

test("handoff rubric exists with H1 (repo identity is first claim) heavyweight", () => {
  const path = resolve(RUBRICS_DIR, "handoff_rubric.json");
  const r = JSON.parse(readFileSync(path, "utf8")) as RubricFile;
  assert.equal(r.rubricId, "handoff");
  const h1 = r.criteria.find((c) => c.id === "H1");
  assert.ok(
    h1,
    "handoff rubric must have H1 (repo identity is the first claim)",
  );
  assert.ok(h1.weight >= 2, "H1 must be weight >= 2");
});

// --- anti-example schema --------------------------------------------------

const REQUIRED_SECTIONS = [
  "## What happened",
  "## Why it was wrong",
  "## How to detect",
  "## Reference",
];

test("every anti-example markdown file has the canonical sections", () => {
  const files = listMarkdown(ANTI_EXAMPLES_DIR);
  assert.ok(files.length >= 1, "expected at least 1 anti-example");
  for (const path of files) {
    const md = readFileSync(path, "utf8");
    // Title is # ... on the first non-empty line.
    const firstHeading = md.split("\n").find((l) => l.startsWith("# "));
    assert.ok(
      firstHeading,
      `${basename(path)}: must have a top-level # heading`,
    );
    for (const section of REQUIRED_SECTIONS) {
      assert.ok(
        md.includes(section),
        `${basename(path)}: missing section "${section}"`,
      );
    }
    // Sections appear in the canonical order.
    let cursor = 0;
    for (const section of REQUIRED_SECTIONS) {
      const idx = md.indexOf(section, cursor);
      assert.ok(
        idx >= cursor,
        `${basename(path)}: section "${section}" out of order`,
      );
      cursor = idx + section.length;
    }
  }
});

test("wrong_repo_hallucination anti-example is present and references the live countermeasure", () => {
  const path = resolve(ANTI_EXAMPLES_DIR, "wrong_repo_hallucination.md");
  const md = readFileSync(path, "utf8");
  // Must reference the context-pack countermeasure and the eval criterion.
  assert.match(md, /frontier context pack/);
  assert.match(md, /C3/);
  assert.match(md, /repo\.marker/);
});

test("false_green_repair anti-example references deriveFinalClassification + C11 + R4", () => {
  const path = resolve(ANTI_EXAMPLES_DIR, "false_green_repair.md");
  const md = readFileSync(path, "utf8");
  assert.match(md, /deriveFinalClassification/);
  assert.match(md, /C11/);
  assert.match(md, /R4/);
});

test("narrow_alert_filter anti-example references assertLegacyAndFactoryCoverage + C9", () => {
  const path = resolve(ANTI_EXAMPLES_DIR, "narrow_alert_filter.md");
  const md = readFileSync(path, "utf8");
  assert.match(md, /assertLegacyAndFactoryCoverage/);
  assert.match(md, /C9/);
  assert.match(md, /ai-stack-local-smoke-20260425-035014/);
});

// --- cross-reference: every anti-example cited in a rubric exists --------

test("rubric calibration.anti_examples references resolve to actual files", () => {
  const files = listJson(RUBRICS_DIR);
  for (const path of files) {
    const r = JSON.parse(readFileSync(path, "utf8")) as RubricFile;
    const refs = r.calibration?.anti_examples ?? [];
    for (const ref of refs) {
      const m = ref.match(/^taste\/anti_examples\/([^\s]+\.md)/);
      assert.ok(
        m,
        `${basename(path)}: anti_example ref "${ref}" must point under taste/anti_examples/`,
      );
      const referenced = resolve(ANTI_EXAMPLES_DIR, m[1]!);
      assert.ok(
        statSync(referenced).isFile(),
        `${basename(path)}: anti_example ${m[1]} not found at ${referenced}`,
      );
    }
  }
});
