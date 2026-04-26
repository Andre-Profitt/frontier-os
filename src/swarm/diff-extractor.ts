// Pull unified-diff blocks out of LLM-generated text.
//
// Models wrap diffs in markdown (```diff ... ``` or ```patch ... ```),
// or paste them inline with surrounding prose, or sometimes emit a
// pseudo-diff with curly-quote dashes. We extract every plausible
// candidate so the caller can pick (usually: try the longest first).
//
// Pure function — no fs, no subprocess. Used by the builder swarm to
// turn a broker response into something `git apply` can consume.

const FENCE_PATTERN = /```(?:diff|patch|unified)\s*\n([\s\S]*?)\n```/g;

const DIFF_HEADER_PATTERN =
  /^(diff --git a\/.+? b\/.+?|---\s+(?:a\/.+|\/dev\/null)|Index:\s+\S+|\*\*\* .+|@@\s+-?\d+)/m;

export interface DiffCandidate {
  diff: string;
  source: "fenced" | "inline";
  startLine: number;
}

export function extractDiffs(text: string): DiffCandidate[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const candidates: DiffCandidate[] = [];

  // 1) Fenced ```diff / ```patch / ```unified blocks. Most reliable —
  // models emit these when prompted for a diff.
  for (const m of text.matchAll(FENCE_PATTERN)) {
    const diff = (m[1] ?? "").trim();
    if (!diff) continue;
    if (!looksLikeDiff(diff)) continue;
    candidates.push({
      diff,
      source: "fenced",
      startLine: lineAt(text, m.index ?? 0),
    });
  }

  // 2) Inline diffs without a fence. Less reliable; only honor when the
  // text contains an unambiguous diff header (`diff --git`, `--- a/...`,
  // or a hunk marker). Take from the first matching header to the end of
  // text minus any trailing prose paragraph.
  if (candidates.length === 0) {
    const headerMatch = DIFF_HEADER_PATTERN.exec(text);
    if (headerMatch && headerMatch.index !== undefined) {
      const slice = text.slice(headerMatch.index).trimEnd();
      if (looksLikeDiff(slice)) {
        candidates.push({
          diff: slice,
          source: "inline",
          startLine: lineAt(text, headerMatch.index),
        });
      }
    }
  }

  // Longest first — bigger diffs usually have more signal.
  return candidates.sort((a, b) => b.diff.length - a.diff.length);
}

// Sanity check: a real unified diff has at least one hunk header (`@@`)
// and either a `diff --git` line or `---`/`+++` pair. Filters out
// markdown blocks that happen to start with `@@` from comments.
export function looksLikeDiff(text: string): boolean {
  if (!text.includes("@@")) return false;
  const hasGitDiff = text.includes("diff --git ");
  const hasUnifiedHeaders =
    /^---\s+\S+/m.test(text) && /^\+\+\+\s+\S+/m.test(text);
  return hasGitDiff || hasUnifiedHeaders;
}

function lineAt(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}
