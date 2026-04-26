// Structural tests for the skills library.
//
// Each skill under skills/<id>/SKILL.md follows the Anthropic Agent
// Skills format: YAML frontmatter (name, description) plus a body with
// canonical sections. These tests catch a malformed skill at test time
// rather than when an agent loads it and silently misbehaves.
//
// Run:
//   node --import tsx --test tests/skills/structure.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
const SKILLS_DIR = resolve(REPO_ROOT, "skills");

const REQUIRED_SECTIONS = [
  "## When to use",
  "## Forbidden moves",
  "## Exact commands",
] as const;

const RECOMMENDED_SECTIONS = ["## Anti-patterns", "## Required evidence"];

interface ParsedSkill {
  id: string;
  path: string;
  frontmatter: Record<string, string>;
  body: string;
}

function parseSkillFile(filepath: string): ParsedSkill {
  const raw = readFileSync(filepath, "utf8");
  // Frontmatter contract: file MUST start with "---\n", contain a
  // closing "---\n", and have YAML-like key: value pairs in between.
  // Body follows the closing fence.
  if (!raw.startsWith("---\n")) {
    throw new Error(`${filepath}: missing leading frontmatter fence`);
  }
  const close = raw.indexOf("\n---\n", 4);
  if (close === -1) {
    throw new Error(`${filepath}: missing closing frontmatter fence`);
  }
  const fmRaw = raw.slice(4, close);
  const body = raw.slice(close + 5);
  const frontmatter: Record<string, string> = {};
  for (const line of fmRaw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(`${filepath}: malformed frontmatter line "${trimmed}"`);
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  const id = filepath.split("/skills/")[1]?.split("/SKILL.md")[0] ?? "";
  return { id, path: filepath, frontmatter, body };
}

function listSkillFiles(): ParsedSkill[] {
  const out: ParsedSkill[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const subdir = resolve(SKILLS_DIR, entry);
    if (!statSync(subdir).isDirectory()) continue;
    const skillFile = resolve(subdir, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new Error(`skills/${entry}/SKILL.md missing`);
    }
    out.push(parseSkillFile(skillFile));
  }
  return out;
}

// --- discovery ----------------------------------------------------------

test("skills/ directory exists and is non-empty", () => {
  assert.ok(existsSync(SKILLS_DIR), "skills/ directory must exist");
  const skills = listSkillFiles();
  assert.ok(
    skills.length >= 1,
    "at least one skill must be defined under skills/<id>/SKILL.md",
  );
});

// --- frontmatter contract ------------------------------------------------

test("every SKILL.md has a name + description in frontmatter", () => {
  const skills = listSkillFiles();
  for (const s of skills) {
    assert.ok(s.frontmatter.name, `${s.path}: frontmatter must include 'name'`);
    assert.ok(
      s.frontmatter.description,
      `${s.path}: frontmatter must include 'description'`,
    );
    assert.equal(
      s.frontmatter.name,
      s.id,
      `${s.path}: frontmatter name (${s.frontmatter.name}) must match folder id (${s.id})`,
    );
    assert.ok(
      s.frontmatter.description &&
        s.frontmatter.description.length >= 20 &&
        s.frontmatter.description.length <= 300,
      `${s.path}: description must be 20-300 chars (got ${s.frontmatter.description?.length ?? 0})`,
    );
  }
});

test("frontmatter description is a single line (no embedded newlines)", () => {
  const skills = listSkillFiles();
  for (const s of skills) {
    assert.equal(
      s.frontmatter.description?.includes("\n"),
      false,
      `${s.path}: description must be a single line`,
    );
  }
});

// --- body shape ---------------------------------------------------------

test("every SKILL.md has the required sections", () => {
  const skills = listSkillFiles();
  for (const s of skills) {
    for (const heading of REQUIRED_SECTIONS) {
      assert.ok(
        s.body.includes(heading),
        `${s.path}: missing required section "${heading}"`,
      );
    }
  }
});

test("every SKILL.md has at least one of the recommended sections", () => {
  const skills = listSkillFiles();
  for (const s of skills) {
    const hasOne = RECOMMENDED_SECTIONS.some((h) => s.body.includes(h));
    assert.ok(
      hasOne,
      `${s.path}: should include at least one of ${RECOMMENDED_SECTIONS.join(", ")}`,
    );
  }
});

test("Forbidden moves section is non-empty", () => {
  const skills = listSkillFiles();
  for (const s of skills) {
    const idx = s.body.indexOf("## Forbidden moves");
    assert.ok(idx >= 0, `${s.path}: missing Forbidden moves section`);
    // Take the slice up to the next ## heading.
    const rest = s.body.slice(idx + "## Forbidden moves".length);
    const nextHeading = rest.search(/\n##\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    // A meaningful Forbidden-moves section should have at least one
    // bulleted item — empty boilerplate is the failure mode this guards.
    assert.ok(
      /^\s*-\s+/m.test(section),
      `${s.path}: Forbidden moves section must include at least one "-" bullet`,
    );
  }
});

// --- AGENTS.md cross-link -----------------------------------------------

test("AGENTS.md exists and references the skills/ index", () => {
  const agentsPath = resolve(REPO_ROOT, "AGENTS.md");
  assert.ok(existsSync(agentsPath), "repo-root AGENTS.md must exist");
  const text = readFileSync(agentsPath, "utf8");
  assert.ok(
    text.includes("skills/"),
    "AGENTS.md must reference the skills/ directory",
  );
});

test("AGENTS.md hard rules section exists", () => {
  const text = readFileSync(resolve(REPO_ROOT, "AGENTS.md"), "utf8");
  assert.ok(
    text.includes("## Hard rules"),
    "AGENTS.md must declare a '## Hard rules' section so skills can inherit",
  );
});

// --- the four shipped skills must be present ---------------------------
//
// Concrete-first: hard-code the v1 skill set so a rename or accidental
// deletion is caught immediately. Add to this list when shipping a new
// skill (and update AGENTS.md "Skill discovery" alongside).

test("v1 skill set is present", () => {
  const expected = [
    "frontier-factory-supervisor",
    "factory-activation",
    "context-pack",
    "pr-review-packet",
  ];
  const actual = listSkillFiles().map((s) => s.id);
  for (const name of expected) {
    assert.ok(
      actual.includes(name),
      `expected skills/${name}/SKILL.md to exist (have: ${actual.join(", ")})`,
    );
  }
});
