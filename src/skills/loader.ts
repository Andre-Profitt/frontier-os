// Skill loader — reads skills/<task-class>/skill.json + SKILL.md.
//
// Loaded skills are the contract a worker accepts when it takes work in a
// given task class: which tools are allowed, which are forbidden even when
// the runtime would permit them, what side-effects a successful run may
// produce, and the prompt template the broker interpolates the task into.
//
// The loader does not enforce permissions — it surfaces the declared
// envelope so a future runtime (PR R2 worktree manager + broker pre-call
// hook) can gate tool calls. For now it asserts:
//   - every skill.json validates against schemas/skill.schema.json
//   - the declared promptTemplate file actually exists in the skill dir
//   - the default-forbid tools are present in forbiddenTools (defense in
//     depth: even if a future skill author forgets, the loader catches it
//     before deploy)
//
// A separate test asserts that skills/<class>/ exists for every class in
// config/model-policy.json:classes and vice versa — no drift between
// routing and contract.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSkill } from "../schemas.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
export const DEFAULT_SKILLS_DIR = resolve(REPO_ROOT, "skills");

// Tools that are denied for every worker unless explicitly listed in
// forbiddenTools — the loader inserts them if a skill author forgot.
// Keeping the policy in code (not just docs) means the deny list survives
// docs drift.
export const DEFAULT_FORBID = [
  "exec.git.push",
  "launchd.apply",
] as const satisfies readonly string[];

export type SkillRole =
  | "builder"
  | "reviewer"
  | "researcher"
  | "summarizer"
  | "triager"
  | "arbiter"
  | "planner";

export type SkillSideEffect =
  | "auth_change"
  | "billable_action"
  | "deploy"
  | "destructive_action"
  | "external_message"
  | "financial_action"
  | "local_write"
  | "none"
  | "pr_open"
  | "repo_write"
  | "shared_write"
  | "ticket_write";

export type VerifierMode = "none" | "required" | "required_before_side_effect";

export interface Skill {
  skillId: string;
  version: string;
  taskClass: string;
  summary: string;
  allowedRoles: SkillRole[];
  allowedTools: string[];
  forbiddenTools: string[];
  maxParallel: number;
  sideEffects: SkillSideEffect[];
  verifierMode: VerifierMode;
  qualityFloor?: number;
  promptTemplate: string;
  rubric?: string;
  antiExamples: string[];
  // Resolved at load time — absolute paths for convenience.
  skillDir: string;
  promptTemplatePath: string;
}

export class SkillLoadError extends Error {
  constructor(
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SkillLoadError";
  }
}

// Load every skill under `dir`. Throws on any validation failure — the
// repo-level test surfaces all errors at once via this single throw.
export function loadSkills(dir: string = DEFAULT_SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) {
    throw new SkillLoadError(`skills dir does not exist: ${dir}`);
  }
  const skills: Skill[] = [];
  const seenIds = new Set<string>();
  const seenClasses = new Set<string>();

  for (const entry of readdirSync(dir)) {
    const entryPath = resolve(dir, entry);
    if (!statSync(entryPath).isDirectory()) continue;
    const skillJsonPath = resolve(entryPath, "skill.json");
    if (!existsSync(skillJsonPath)) continue;

    const skill = loadSkillFile(skillJsonPath);
    if (seenIds.has(skill.skillId)) {
      throw new SkillLoadError(
        `duplicate skillId "${skill.skillId}" in ${entryPath}`,
      );
    }
    if (seenClasses.has(skill.taskClass)) {
      throw new SkillLoadError(
        `duplicate taskClass "${skill.taskClass}" in ${entryPath}`,
      );
    }
    seenIds.add(skill.skillId);
    seenClasses.add(skill.taskClass);
    skills.push(skill);
  }

  return skills.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

// Load one skill by its directory path's containing skill.json.
export function loadSkillFile(skillJsonPath: string): Skill {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(skillJsonPath, "utf8"));
  } catch (e) {
    throw new SkillLoadError(`cannot parse ${skillJsonPath}`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  if (!validateSkill(raw)) {
    throw new SkillLoadError(`schema validation failed for ${skillJsonPath}`, {
      errors: validateSkill.errors,
    });
  }
  // After validation `raw` matches the schema shape; cast and resolve paths.
  const r = raw as Omit<
    Skill,
    "skillDir" | "promptTemplatePath" | "antiExamples"
  > &
    Partial<Pick<Skill, "antiExamples" | "promptTemplate">>;
  const skillDir = dirname(skillJsonPath);
  const promptTemplate = r.promptTemplate ?? "SKILL.md";
  const promptTemplatePath = resolve(skillDir, promptTemplate);
  if (!existsSync(promptTemplatePath)) {
    throw new SkillLoadError(
      `${skillJsonPath} declares promptTemplate "${promptTemplate}" but ${promptTemplatePath} is missing`,
    );
  }

  // Defense in depth — make sure DEFAULT_FORBID is in forbiddenTools.
  // Set, not array dedupe, because skill.json may already include them.
  const forbiddenTools = Array.from(
    new Set([...(r.forbiddenTools ?? []), ...DEFAULT_FORBID]),
  ).sort();

  // Reject overlap: a tool in both allowedTools and forbiddenTools is a
  // policy bug. forbiddenTools always wins, but the author should know.
  const allowed = new Set(r.allowedTools ?? []);
  const overlap = forbiddenTools.filter((t) => allowed.has(t));
  if (overlap.length > 0) {
    throw new SkillLoadError(
      `${skillJsonPath} lists ${overlap.join(", ")} in both allowedTools and forbiddenTools (forbiddenTools wins, but the policy is contradictory)`,
    );
  }

  return {
    skillId: r.skillId,
    version: r.version,
    taskClass: r.taskClass,
    summary: r.summary,
    allowedRoles: (r.allowedRoles ?? []) as SkillRole[],
    allowedTools: r.allowedTools ?? [],
    forbiddenTools,
    maxParallel: r.maxParallel ?? 1,
    sideEffects: (r.sideEffects ?? []) as SkillSideEffect[],
    verifierMode: r.verifierMode,
    ...(r.qualityFloor !== undefined ? { qualityFloor: r.qualityFloor } : {}),
    promptTemplate,
    ...(r.rubric ? { rubric: r.rubric } : {}),
    antiExamples: r.antiExamples ?? [],
    skillDir,
    promptTemplatePath,
  };
}

export function loadSkill(
  taskClass: string,
  dir: string = DEFAULT_SKILLS_DIR,
): Skill | null {
  const skills = loadSkills(dir);
  return skills.find((s) => s.taskClass === taskClass) ?? null;
}

// Read the SKILL.md and extract ONLY the fenced block under
// "## Prompt template". The role / success-criteria / anti-patterns
// prose above is for the human curating the skill, not for the model.
//
// First-real-orchestration finding (Patch L, v4): when the whole
// SKILL.md was sent as the prompt, deepseek-coder:33b-instruct
// paraphrased the role definition back instead of acting on it
// (reviewCoverage=0.00 because every reviewer returned narrative text
// instead of the requested JSON). Sending only the actual template
// block fixes that — the model sees instructions, not documentation.
//
// Falls back to the whole file if the section header / fence pair
// isn't found, so a hand-authored SKILL.md without the standard
// structure still works.
export function loadPromptTemplate(skill: Skill): string {
  const md = readFileSync(skill.promptTemplatePath, "utf8");
  const headerIdx = md.indexOf("## Prompt template");
  if (headerIdx < 0) return md;
  const after = md.slice(headerIdx);
  const openFence = after.indexOf("```");
  if (openFence < 0) return md;
  const closeFence = after.indexOf("```", openFence + 3);
  if (closeFence < 0) return md;
  // Strip the language tag on the open fence (e.g. ```json) and the
  // surrounding newlines.
  const inner = after.slice(openFence + 3, closeFence);
  const firstNewline = inner.indexOf("\n");
  const body = firstNewline >= 0 ? inner.slice(firstNewline + 1) : inner;
  return body.replace(/\n+$/, "");
}

// Tool gate — the function the worker runtime calls to decide whether a
// requested tool verb is permitted by the skill.
//
// Rules:
//   1. forbiddenTools wins over allowedTools.
//   2. Wildcards are NOT supported in v1 (`adapter.salesforce.*` won't
//      match `adapter.salesforce.read`). Add explicit verbs.
//   3. A tool not listed in either is denied (closed-by-default).
export function isToolAllowed(skill: Skill, tool: string): boolean {
  if (skill.forbiddenTools.includes(tool)) return false;
  return skill.allowedTools.includes(tool);
}
