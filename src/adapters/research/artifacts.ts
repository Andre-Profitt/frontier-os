// On-disk artifact store for research sessions: per-session directory under
// ~/.frontier/research/ holding the decomposition, each worker's output, and
// the synthesized brief. Everything is markdown + JSON so the brief is human-
// readable and replays are structured.

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

const ROOT = resolvePath(homedir(), ".frontier", "research");

export interface SessionPaths {
  root: string;
  decompositionJson: string;
  workerDir: string;
  briefMarkdown: string;
  metadataJson: string;
}

export function researchRoot(): string {
  return ROOT;
}

export function sessionPaths(sessionId: string): SessionPaths {
  const root = resolvePath(ROOT, sessionId);
  return {
    root,
    decompositionJson: resolvePath(root, "decomposition.json"),
    workerDir: resolvePath(root, "workers"),
    briefMarkdown: resolvePath(root, "brief.md"),
    metadataJson: resolvePath(root, "metadata.json"),
  };
}

export function ensureSession(sessionId: string): SessionPaths {
  const paths = sessionPaths(sessionId);
  mkdirSync(paths.workerDir, { recursive: true });
  return paths;
}

export function writeDecomposition(
  paths: SessionPaths,
  query: string,
  subQuestions: string[],
): void {
  writeFileSync(
    paths.decompositionJson,
    JSON.stringify({ query, subQuestions }, null, 2),
  );
}

export function writeWorkerOutput(
  paths: SessionPaths,
  index: number,
  subQuestion: string,
  markdown: string,
  meta: Record<string, unknown>,
): string {
  const padded = String(index).padStart(2, "0");
  const slug = subQuestion
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const path = resolvePath(paths.workerDir, `${padded}-${slug || "worker"}.md`);
  const header = `# Worker ${index}: ${subQuestion}\n\n`;
  const metaBlock = `\n\n---\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n`;
  writeFileSync(path, header + markdown + metaBlock);
  return path;
}

export function writeBrief(
  paths: SessionPaths,
  query: string,
  brief: string,
  metadata: Record<string, unknown>,
): void {
  const header = `# Research Brief\n\n**Query:** ${query}\n\n**Session:** ${metadata.sessionId}\n\n**Generated:** ${metadata.generatedAt}\n\n---\n\n`;
  writeFileSync(paths.briefMarkdown, header + brief);
  writeFileSync(paths.metadataJson, JSON.stringify(metadata, null, 2));
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  query: string;
  briefPath: string | null;
  workerCount: number;
}

export function listSessions(limit = 20): SessionSummary[] {
  if (!existsSync(ROOT)) return [];
  const entries = readdirSync(ROOT)
    .map((name) => {
      const path = resolvePath(ROOT, name);
      try {
        const s = statSync(path);
        if (!s.isDirectory()) return null;
        return { name, path, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is { name: string; path: string; mtimeMs: number } => e !== null,
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  return entries.map((e) => {
    const paths = sessionPaths(e.name);
    let query = "";
    let startedAt = new Date(e.mtimeMs).toISOString();
    let briefPath: string | null = null;
    let workerCount = 0;
    try {
      if (existsSync(paths.metadataJson)) {
        const meta = JSON.parse(readFileSync(paths.metadataJson, "utf8")) as {
          query?: string;
          generatedAt?: string;
        };
        query = meta.query ?? "";
        startedAt = meta.generatedAt ?? startedAt;
      } else if (existsSync(paths.decompositionJson)) {
        const dec = JSON.parse(
          readFileSync(paths.decompositionJson, "utf8"),
        ) as { query?: string };
        query = dec.query ?? "";
      }
      if (existsSync(paths.briefMarkdown)) briefPath = paths.briefMarkdown;
      if (existsSync(paths.workerDir)) {
        workerCount = readdirSync(paths.workerDir).filter((f) =>
          f.endsWith(".md"),
        ).length;
      }
    } catch {
      /* best effort */
    }
    return {
      sessionId: e.name,
      startedAt,
      query,
      briefPath,
      workerCount,
    };
  });
}

export function readBrief(sessionId: string): string | null {
  const paths = sessionPaths(sessionId);
  if (!existsSync(paths.briefMarkdown)) return null;
  return readFileSync(paths.briefMarkdown, "utf8");
}
