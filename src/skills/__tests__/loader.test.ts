// Skill loader tests + drift assertion against config/model-policy.json.
//
// The drift test is the load-bearing one — it catches the case where
// someone adds a task class to model-policy.json without authoring a skill,
// or vice versa. R3 (review swarm) will assume `loadSkill(taskClass)` is
// always non-null when the policy lists the class; this test enforces that
// invariant from the schema side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  loadSkills,
  loadSkill,
  loadSkillFile,
  loadPromptTemplate,
  isToolAllowed,
  DEFAULT_SKILLS_DIR,
  DEFAULT_FORBID,
  SkillLoadError,
} from "../loader.ts";
import { ModelRegistry } from "../../inference/model-registry.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..", "..");

// --- live skills/ load + drift -------------------------------------------

test("loadSkills(): every shipped skill in skills/ validates and loads", () => {
  const skills = loadSkills();
  // The 5 v1 task classes (must equal config/model-policy.json:classes).
  const taskClasses = skills.map((s) => s.taskClass).sort();
  assert.deepEqual(taskClasses, [
    "adversarial_review",
    "merge_arbiter",
    "patch_builder",
    "research_extraction",
    "routine_summary",
  ]);
  for (const s of skills) {
    assert.equal(typeof s.summary, "string");
    assert.ok(s.summary.length > 0, `${s.skillId} has empty summary`);
    assert.ok(
      s.allowedTools.length > 0 || s.skillId === "merge_arbiter",
      `${s.skillId} has no allowedTools`,
    );
  }
});

test("loadSkills(): no drift between skills/ and config/model-policy.json:classes", () => {
  const skills = loadSkills();
  const skillClasses = new Set(skills.map((s) => s.taskClass));
  const registry = new ModelRegistry();
  const policyClasses = new Set(Object.keys(registry.policy.classes));

  // Every policy class has a skill.
  for (const cls of policyClasses) {
    assert.ok(
      skillClasses.has(cls),
      `policy class "${cls}" has no skill in skills/${cls}/`,
    );
  }
  // Every skill points at a policy class.
  for (const cls of skillClasses) {
    assert.ok(
      policyClasses.has(cls),
      `skill taskClass "${cls}" not declared in config/model-policy.json:classes`,
    );
  }
});

test("loadSkills(): every skill's promptTemplate file exists", () => {
  for (const s of loadSkills()) {
    // loader throws if the file is missing — reaching this assert means
    // the path resolved and the file is present.
    assert.equal(typeof s.promptTemplatePath, "string");
    const body = loadPromptTemplate(s);
    assert.ok(body.length > 0, `${s.skillId} prompt template is empty`);
  }
});

test("loadSkills(): DEFAULT_FORBID injected into every skill's forbiddenTools", () => {
  for (const s of loadSkills()) {
    for (const denied of DEFAULT_FORBID) {
      assert.ok(
        s.forbiddenTools.includes(denied),
        `${s.skillId} missing default-forbid "${denied}"`,
      );
    }
  }
});

test("loadSkill(): missing taskClass returns null", () => {
  assert.equal(loadSkill("does-not-exist"), null);
});

test("loadSkill(): known taskClass returns the loaded skill", () => {
  const s = loadSkill("patch_builder");
  assert.ok(s);
  assert.equal(s?.skillId, "patch_builder");
});

// --- isToolAllowed --------------------------------------------------------

test("isToolAllowed: allowed tool returns true", () => {
  const s = loadSkill("patch_builder")!;
  assert.equal(isToolAllowed(s, "exec.test"), true);
});

test("isToolAllowed: forbidden tool returns false (default-forbid)", () => {
  const s = loadSkill("patch_builder")!;
  assert.equal(isToolAllowed(s, "exec.git.push"), false);
});

test("isToolAllowed: tool not in either list is denied (closed-by-default)", () => {
  const s = loadSkill("patch_builder")!;
  assert.equal(isToolAllowed(s, "imaginary.tool"), false);
});

// --- error paths via temp dirs --------------------------------------------

function withTempSkillsDir<T>(
  build: (dir: string) => void,
  fn: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "skills-test-"));
  try {
    build(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSkill(dir: string, name: string, payload: object): void {
  const sub = resolve(dir, name);
  mkdirSync(sub, { recursive: true });
  writeFileSync(resolve(sub, "skill.json"), JSON.stringify(payload));
  writeFileSync(resolve(sub, "SKILL.md"), `# ${name}\n`);
}

test("loadSkills: schema violation throws SkillLoadError", () => {
  withTempSkillsDir(
    (dir) => {
      writeSkill(dir, "bad", {
        // missing required fields (skillId, taskClass, ...)
        version: "v1",
      });
    },
    (dir) => {
      assert.throws(() => loadSkills(dir), SkillLoadError);
    },
  );
});

test("loadSkills: duplicate taskClass across two skill dirs throws", () => {
  withTempSkillsDir(
    (dir) => {
      const base = {
        version: "v1",
        taskClass: "shared_class",
        summary: "x",
        allowedTools: ["read.file"],
        forbiddenTools: [],
        sideEffects: ["local_write"],
        verifierMode: "none",
      };
      writeSkill(dir, "skill_a", { ...base, skillId: "skill_a" });
      writeSkill(dir, "skill_b", { ...base, skillId: "skill_b" });
    },
    (dir) => {
      assert.throws(() => loadSkills(dir), /duplicate taskClass/);
    },
  );
});

test("loadSkills: missing promptTemplate file throws", () => {
  withTempSkillsDir(
    (dir) => {
      const sub = resolve(dir, "missing_template");
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        resolve(sub, "skill.json"),
        JSON.stringify({
          skillId: "missing_template",
          version: "v1",
          taskClass: "missing_template",
          summary: "x",
          allowedTools: ["read.file"],
          forbiddenTools: [],
          sideEffects: ["local_write"],
          verifierMode: "none",
          promptTemplate: "GHOST.md",
        }),
      );
      // intentionally do not write GHOST.md
    },
    (dir) => {
      assert.throws(() => loadSkills(dir), /promptTemplate/);
    },
  );
});

test("loadSkills: overlap between allowedTools and forbiddenTools throws", () => {
  withTempSkillsDir(
    (dir) => {
      writeSkill(dir, "contradictory", {
        skillId: "contradictory",
        version: "v1",
        taskClass: "contradictory",
        summary: "x",
        allowedTools: ["exec.git.push", "read.file"],
        forbiddenTools: ["exec.shell.write"], // exec.git.push will be added by DEFAULT_FORBID
        sideEffects: ["local_write"],
        verifierMode: "none",
      });
    },
    (dir) => {
      assert.throws(
        () => loadSkills(dir),
        /both allowedTools and forbiddenTools/,
      );
    },
  );
});

test("loadSkills: empty skills/ dir returns empty array", () => {
  withTempSkillsDir(
    () => {
      // no skills written
    },
    (dir) => {
      assert.deepEqual(loadSkills(dir), []);
    },
  );
});

test("loadSkillFile: parses a single skill.json by absolute path", () => {
  const path = resolve(DEFAULT_SKILLS_DIR, "patch_builder", "skill.json");
  const s = loadSkillFile(path);
  assert.equal(s.skillId, "patch_builder");
  assert.equal(s.taskClass, "patch_builder");
});

// --- repo-root constant sanity --------------------------------------------

test("DEFAULT_SKILLS_DIR resolves to <repo>/skills", () => {
  assert.equal(DEFAULT_SKILLS_DIR, resolve(REPO_ROOT, "skills"));
});
