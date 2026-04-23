// On-disk artifacts for a swarm run.
//
// ~/.frontier/swarm/<runId>/
//   task-ledger.json
//   readers/
//     NN-stepId-title-slug.md
//   writer/
//     draft.md
//   verdict/
//     progress-ledger.json
//     verdict.md        (derived readable summary)
//   metadata.json

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

import type {
  ProgressLedger,
  TaskLedger,
  TaskLedgerPlanStep,
} from "./ledgers.ts";

const ROOT = resolvePath(homedir(), ".frontier", "swarm");

export interface SwarmPaths {
  root: string;
  taskLedger: string;
  readersDir: string;
  writerDraft: string;
  progressLedger: string;
  verdictMd: string;
  metadata: string;
}

export function swarmRoot(): string {
  return ROOT;
}

export function pathsFor(runId: string): SwarmPaths {
  const root = resolvePath(ROOT, runId);
  return {
    root,
    taskLedger: resolvePath(root, "task-ledger.json"),
    readersDir: resolvePath(root, "readers"),
    writerDraft: resolvePath(root, "writer", "draft.md"),
    progressLedger: resolvePath(root, "verdict", "progress-ledger.json"),
    verdictMd: resolvePath(root, "verdict", "verdict.md"),
    metadata: resolvePath(root, "metadata.json"),
  };
}

export function ensure(runId: string): SwarmPaths {
  const p = pathsFor(runId);
  mkdirSync(p.readersDir, { recursive: true });
  mkdirSync(resolvePath(p.root, "writer"), { recursive: true });
  mkdirSync(resolvePath(p.root, "verdict"), { recursive: true });
  return p;
}

export function writeTaskLedger(paths: SwarmPaths, ledger: TaskLedger): void {
  writeFileSync(paths.taskLedger, JSON.stringify(ledger, null, 2));
}

export function writeReaderFinding(
  paths: SwarmPaths,
  index: number,
  step: TaskLedgerPlanStep,
  markdown: string,
  meta: Record<string, unknown>,
): string {
  const padded = String(index).padStart(2, "0");
  const slug = step.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const path = resolvePath(
    paths.readersDir,
    `${padded}-${step.stepId}-${slug || "reader"}.md`,
  );
  const header = `# Reader ${step.stepId}: ${step.title}\n\n`;
  const metaBlock = `\n\n---\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n`;
  writeFileSync(path, header + markdown + metaBlock);
  return path;
}

export function writeWriterDraft(
  paths: SwarmPaths,
  task: string,
  draft: string,
): void {
  const header = `# Writer Draft\n\n**Task:** ${task}\n\n---\n\n`;
  writeFileSync(paths.writerDraft, header + draft);
}

export function writeVerdict(
  paths: SwarmPaths,
  ledger: ProgressLedger,
  writerOutput: string,
): void {
  writeFileSync(paths.progressLedger, JSON.stringify(ledger, null, 2));
  const verdict = [
    `# Verdict`,
    ``,
    `**Satisfied:** ${ledger.is_request_satisfied.answer} — ${ledger.is_request_satisfied.reason}`,
    `**In loop:** ${ledger.is_in_loop.answer} — ${ledger.is_in_loop.reason}`,
    `**Making progress:** ${ledger.is_progress_being_made.answer} — ${ledger.is_progress_being_made.reason}`,
    `**Next speaker:** ${ledger.next_speaker.answer} — ${ledger.next_speaker.reason}`,
    `**Instruction:** ${ledger.instruction_or_question.answer}`,
    `_Reason:_ ${ledger.instruction_or_question.reason}`,
    ``,
    `---`,
    ``,
    `## Deliverable reviewed`,
    ``,
    writerOutput,
  ].join("\n");
  writeFileSync(paths.verdictMd, verdict);
}

export function writeMetadata(
  paths: SwarmPaths,
  metadata: Record<string, unknown>,
): void {
  writeFileSync(paths.metadata, JSON.stringify(metadata, null, 2));
}

export interface SwarmSummary {
  runId: string;
  startedAt: string;
  task: string;
  satisfied: boolean | null;
  root: string;
  verdictPath: string | null;
}

export function listRuns(limit = 20): SwarmSummary[] {
  if (!existsSync(ROOT)) return [];
  const entries = readdirSync(ROOT)
    .map((name) => {
      const full = resolvePath(ROOT, name);
      try {
        const s = statSync(full);
        if (!s.isDirectory()) return null;
        return { name, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { name: string; mtimeMs: number } => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
  return entries.map((e) => {
    const p = pathsFor(e.name);
    let task = "";
    let satisfied: boolean | null = null;
    let startedAt = new Date(e.mtimeMs).toISOString();
    try {
      if (existsSync(p.metadata)) {
        const m = JSON.parse(readFileSync(p.metadata, "utf8")) as {
          task?: string;
          startedAt?: string;
        };
        task = m.task ?? "";
        startedAt = m.startedAt ?? startedAt;
      }
      if (existsSync(p.progressLedger)) {
        const pl = JSON.parse(readFileSync(p.progressLedger, "utf8")) as {
          is_request_satisfied?: { answer?: boolean };
        };
        if (typeof pl.is_request_satisfied?.answer === "boolean") {
          satisfied = pl.is_request_satisfied.answer;
        }
      }
    } catch {
      /* best effort */
    }
    return {
      runId: e.name,
      startedAt,
      task,
      satisfied,
      root: p.root,
      verdictPath: existsSync(p.verdictMd) ? p.verdictMd : null,
    };
  });
}
