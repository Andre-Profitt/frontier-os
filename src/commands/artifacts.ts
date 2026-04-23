import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  CommandStore,
  type CommandRecord,
  type CommandPlan,
} from "./store.ts";

export interface CommandArtifactFile {
  path: string;
  kind: "file" | "directory";
  sizeBytes: number | null;
  updatedAt: string | null;
}

export interface CommandArtifacts {
  generatedAt: string;
  command: CommandRecord;
  artifactDir: string | null;
  workGraphPath: string | null;
  files: CommandArtifactFile[];
  dispatchArtifactRefs: string[];
}

export function commandArtifacts(commandId: string): CommandArtifacts {
  const store = new CommandStore();
  try {
    const command = store.get(commandId);
    if (!command) throw new Error(`unknown command: ${commandId}`);
    const artifactDir = command.plan?.artifactDir ?? null;
    return {
      generatedAt: new Date().toISOString(),
      command,
      artifactDir,
      workGraphPath: command.plan?.workGraphPath ?? null,
      files: artifactDir ? listArtifactFiles(command.plan, artifactDir) : [],
      dispatchArtifactRefs: dispatchArtifactRefs(command),
    };
  } finally {
    store.close();
  }
}

function listArtifactFiles(
  plan: CommandPlan | null,
  artifactDir: string,
): CommandArtifactFile[] {
  const files: CommandArtifactFile[] = [];
  if (!existsSync(artifactDir)) return files;
  for (const name of readdirSync(artifactDir).sort()) {
    const path = resolve(artifactDir, name);
    files.push(fileInfo(path));
  }
  const graphPath = plan?.workGraphPath;
  if (graphPath && existsSync(graphPath) && !files.some((file) => file.path === graphPath)) {
    files.push(fileInfo(graphPath));
  }
  return files;
}

function fileInfo(path: string): CommandArtifactFile {
  const stat = statSync(path);
  return {
    path,
    kind: stat.isDirectory() ? "directory" : "file",
    sizeBytes: stat.isFile() ? stat.size : null,
    updatedAt: stat.mtime.toISOString(),
  };
}

function dispatchArtifactRefs(command: CommandRecord): string[] {
  const refs = new Set<string>();
  const output = command.result?.output;
  const nodeResults = isRecord(output) && Array.isArray(output.nodeResults)
    ? output.nodeResults
    : [];
  for (const nodeResult of nodeResults) {
    if (!isRecord(nodeResult)) continue;
    const dispatch = nodeResult.dispatch;
    if (!isRecord(dispatch)) continue;
    const artifactRefs = dispatch.artifactRefs;
    if (!Array.isArray(artifactRefs)) continue;
    for (const ref of artifactRefs) {
      if (typeof ref === "string") refs.add(ref);
    }
  }
  return [...refs].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
