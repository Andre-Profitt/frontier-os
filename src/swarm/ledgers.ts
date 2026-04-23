// Typed records for the two ledgers in a Magentic-One-style swarm.
//
// Schemas are lifted directly from AutoGen-ext's Magentic-One implementation
// (MIT, https://microsoft.github.io/autogen/dev/reference/python/autogen_ext.teams.magentic_one.html)
// and arxiv 2411.04468 §4. We keep the exact JSON shape so a future port to
// raw AutoGen is mechanical and so operators can read prior-art papers
// verbatim. Prompts live in roles.ts; the state machine lives in runner.ts.

export interface TaskLedgerPlanStep {
  stepId: string;
  title: string;
  assignedTo: AgentRole;
  rationale?: string;
}

/** Outer ledger, stable across one task. Generated once by the planner. */
export interface TaskLedger {
  facts_verified: string[];
  facts_to_look_up: string[];
  facts_derived: string[];
  educated_guesses: string[];
  plan: TaskLedgerPlanStep[];
}

/** Inner ledger, regenerated each inner-loop iteration by the orchestrator. */
export interface ProgressLedger {
  is_request_satisfied: { answer: boolean; reason: string };
  is_in_loop: { answer: boolean; reason: string };
  is_progress_being_made: { answer: boolean; reason: string };
  next_speaker: { answer: AgentRole; reason: string };
  instruction_or_question: { answer: string; reason: string };
}

export type AgentRole = "planner" | "reader" | "writer" | "verifier";

export const AGENT_ROLES: readonly AgentRole[] = [
  "planner",
  "reader",
  "writer",
  "verifier",
];

/** Reference runtime limits from Magentic-One paper (operator-tunable). */
export const DEFAULT_SWARM_LIMITS = {
  maxRoundCount: 10,
  maxStallCount: 3,
  maxResetCount: 2,
};

/**
 * Parse a TaskLedger JSON object (from Claude), tolerating missing fields.
 * The planner is instructed to output this shape but may omit sections on
 * short tasks — we default missing arrays to empty rather than failing.
 */
export function parseTaskLedger(raw: unknown): TaskLedger | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const plan = obj.plan;
  if (!Array.isArray(plan)) return null;
  const steps: TaskLedgerPlanStep[] = [];
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i];
    if (typeof s !== "object" || s === null) continue;
    const so = s as Record<string, unknown>;
    const title = typeof so.title === "string" ? so.title : null;
    const assignedTo =
      typeof so.assignedTo === "string" ? so.assignedTo : "reader";
    if (!title) continue;
    if (
      assignedTo !== "planner" &&
      assignedTo !== "reader" &&
      assignedTo !== "writer" &&
      assignedTo !== "verifier"
    ) {
      continue;
    }
    const step: TaskLedgerPlanStep = {
      stepId: typeof so.stepId === "string" ? so.stepId : `s${i + 1}`,
      title,
      assignedTo: assignedTo as AgentRole,
    };
    if (typeof so.rationale === "string") step.rationale = so.rationale;
    steps.push(step);
  }
  return {
    facts_verified: toStringArray(obj.facts_verified),
    facts_to_look_up: toStringArray(obj.facts_to_look_up),
    facts_derived: toStringArray(obj.facts_derived),
    educated_guesses: toStringArray(obj.educated_guesses),
    plan: steps,
  };
}

/** Parse a ProgressLedger, tolerating the planner returning strings in place of {answer,reason}. */
export function parseProgressLedger(raw: unknown): ProgressLedger | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const keys = [
    "is_request_satisfied",
    "is_in_loop",
    "is_progress_being_made",
    "next_speaker",
    "instruction_or_question",
  ] as const;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "object" && v !== null) {
      result[key] = v;
    } else if (typeof v === "string" || typeof v === "boolean") {
      result[key] = { answer: v, reason: "" };
    } else {
      return null;
    }
  }
  return result as unknown as ProgressLedger;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Extract the first top-level JSON object from text. Claude tends to wrap
 * JSON in markdown fences or prose; this pulls out the object robustly.
 */
export function extractJsonObject(
  text: string,
): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const direct = tryParseObject(trimmed);
  if (direct) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inside = tryParseObject(fence[1].trim());
    if (inside) return inside;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const greedy = tryParseObject(trimmed.slice(start, end + 1));
    if (greedy) return greedy;
  }
  return null;
}

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}
