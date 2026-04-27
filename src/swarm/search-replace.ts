// Search/replace blocks — alternative to unified diffs for builder
// output. Patch M (2026-04-27) introduced this after first-real-
// orchestration data showed unified-diff generation by general 70B
// models on local hardware fails on `git apply --check` >50% of the
// time due to line-number drift in @@ hunks. Search/replace sidesteps
// that: the model emits the EXACT existing text it wants to replace,
// then the new text. Apply is `find-the-text → swap`, not
// line-number arithmetic.
//
// Block format (Aider-style — chosen because git-conflict markers are
// visually distinctive, familiar to engineers, and unlikely to appear
// inside real code by accident):
//
//   path/to/file.ts
//   <<<<<<< SEARCH
//   exact existing text including leading whitespace
//   =======
//   replacement text
//   >>>>>>> REPLACE
//
// Multiple blocks may appear in one model response. Each block is
// independent. A new file is created when SEARCH is empty and the
// file doesn't exist; a delete is when REPLACE is empty (rare; most
// builders shouldn't need it).
//
// Apply is conservative: SEARCH text MUST appear exactly once in the
// file. Zero matches → "search-not-found"; multiple matches →
// "search-ambiguous"; both reject the block before any write. This
// catches model hallucination (made-up code) and ambiguity (model
// pointed at a stretch that occurs in many places).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SearchReplaceBlock {
  // Relative path inside the worktree. Validated against touch list
  // by the caller (builder-swarm); this module doesn't gate on it.
  filePath: string;
  // The EXACT text to find. May be empty for a "create new file" block.
  search: string;
  // The text to put in its place.
  replace: string;
}

export interface ParseResult {
  blocks: SearchReplaceBlock[];
  // True when the input contained at least one well-formed marker pair.
  // Distinguishes "model emitted no S/R format" from "model tried but
  // mangled it" — the latter is worth surfacing so a future Patch can
  // tighten the prompt.
  hadAnyMarkers: boolean;
  // Per-block parse errors (malformed regions skipped). Lets the
  // builder log "model emitted 3 blocks; 1 was malformed" without
  // throwing the whole response away.
  warnings: string[];
}

// Markers — case-sensitive, exactly as written. Embedding them here
// instead of regexes so a model that accidentally generates the
// markers in narrative prose won't false-positive on partial matches.
const SEARCH_MARKER = "<<<<<<< SEARCH";
const SEPARATOR = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

export function parseSearchReplaceBlocks(text: string): ParseResult {
  const blocks: SearchReplaceBlock[] = [];
  const warnings: string[] = [];
  let hadAnyMarkers = false;

  let cursor = 0;
  while (cursor < text.length) {
    const searchIdx = text.indexOf(SEARCH_MARKER, cursor);
    if (searchIdx < 0) break;
    hadAnyMarkers = true;
    // Filename is the LAST non-empty line before the SEARCH marker.
    // The model often emits a blank line, then the path, then
    // SEARCH — accept any whitespace.
    const beforeSearch = text.slice(cursor, searchIdx);
    const filePath = extractTrailingPath(beforeSearch);
    if (!filePath) {
      warnings.push(
        `block at offset ${searchIdx}: no filename line above SEARCH marker`,
      );
      cursor = searchIdx + SEARCH_MARKER.length;
      continue;
    }
    const sepIdx = text.indexOf(SEPARATOR, searchIdx + SEARCH_MARKER.length);
    if (sepIdx < 0) {
      warnings.push(
        `block at offset ${searchIdx} (${filePath}): no '${SEPARATOR}' separator`,
      );
      break;
    }
    const replaceIdx = text.indexOf(REPLACE_MARKER, sepIdx + SEPARATOR.length);
    if (replaceIdx < 0) {
      warnings.push(
        `block at offset ${searchIdx} (${filePath}): no '${REPLACE_MARKER}' close`,
      );
      break;
    }
    // Strip exactly one leading newline after each marker (markers
    // are emitted on their own line; the newline belongs to the
    // marker, not the content).
    const search = stripOneLeadingNewline(
      text.slice(searchIdx + SEARCH_MARKER.length, sepIdx),
    ).replace(/\n$/, "");
    const replace = stripOneLeadingNewline(
      text.slice(sepIdx + SEPARATOR.length, replaceIdx),
    ).replace(/\n$/, "");
    blocks.push({ filePath, search, replace });
    cursor = replaceIdx + REPLACE_MARKER.length;
  }

  return { blocks, hadAnyMarkers, warnings };
}

function extractTrailingPath(text: string): string | null {
  // Walk lines in reverse, return the first non-blank.
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length > 0) {
      // Strip surrounding backticks (model often quotes the path).
      const stripped = trimmed.replace(/^`+|`+$/g, "").trim();
      // Reject obvious non-paths (sentences, bare markers).
      if (
        stripped.length === 0 ||
        stripped.includes(" ") ||
        stripped.startsWith("<<<") ||
        stripped.startsWith(">>>") ||
        stripped === "==="
      ) {
        return null;
      }
      return stripped;
    }
  }
  return null;
}

function stripOneLeadingNewline(s: string): string {
  if (s.startsWith("\r\n")) return s.slice(2);
  if (s.startsWith("\n")) return s.slice(1);
  return s;
}

export interface ApplyResult {
  ok: boolean;
  // Files that were written (relative to worktreePath).
  writtenFiles: string[];
  // First failure reason that aborted apply, if !ok. Apply is
  // all-or-nothing per response: if any block fails its match check,
  // we don't write anything (caller can re-prompt cleanly).
  error?: string;
}

export interface ApplyOptions {
  // Test seam — defaults to real fs.
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  fileExists?: (path: string) => boolean;
}

// Apply blocks to the worktree. Two-phase:
//   1. Validate every block (file exists, search appears exactly
//      once, or "create new file" if search empty + file absent).
//   2. Only after all blocks validate, write them all.
// This guarantees we never half-apply a response.
export function applySearchReplaceBlocks(
  worktreePath: string,
  blocks: SearchReplaceBlock[],
  opts: ApplyOptions = {},
): ApplyResult {
  const readFn = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFn =
    opts.writeFile ??
    ((p: string, c: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    });
  const existsFn = opts.fileExists ?? ((p: string) => existsSync(p));

  if (blocks.length === 0) {
    return { ok: false, writtenFiles: [], error: "no blocks to apply" };
  }

  // Group blocks per file (in order) — multiple blocks against the
  // same file are applied sequentially against the running content.
  const byFile = new Map<string, SearchReplaceBlock[]>();
  for (const b of blocks) {
    if (isAbsolute(b.filePath)) {
      return {
        ok: false,
        writtenFiles: [],
        error: `block for absolute path "${b.filePath}" — relative paths only`,
      };
    }
    if (b.filePath.includes("..")) {
      return {
        ok: false,
        writtenFiles: [],
        error: `block for path with traversal "${b.filePath}" — rejected`,
      };
    }
    const arr = byFile.get(b.filePath) ?? [];
    arr.push(b);
    byFile.set(b.filePath, arr);
  }

  // Phase 1: dry-run every block. Build the post-apply content per
  // file without writing. Surface the first failure.
  const finalContents = new Map<string, string>();
  for (const [relPath, fileBlocks] of byFile) {
    const abs = resolve(worktreePath, relPath);
    let current: string;
    if (existsFn(abs)) {
      current = readFn(abs);
    } else {
      current = "";
    }
    for (const block of fileBlocks) {
      if (block.search === "") {
        // Create-or-overwrite mode. Only allowed if file doesn't exist
        // OR the file is empty. Refuse to clobber an existing
        // non-empty file silently — that's almost always a model
        // mistake.
        if (current.length > 0) {
          return {
            ok: false,
            writtenFiles: [],
            error: `block for "${relPath}" has empty SEARCH but file already has content; refusing to clobber`,
          };
        }
        current = block.replace;
        continue;
      }
      const matchCount = countOccurrences(current, block.search);
      if (matchCount === 0) {
        return {
          ok: false,
          writtenFiles: [],
          error: `block for "${relPath}": SEARCH text not found in current file content`,
        };
      }
      if (matchCount > 1) {
        return {
          ok: false,
          writtenFiles: [],
          error: `block for "${relPath}": SEARCH text matches ${matchCount} locations — ambiguous; refine the SEARCH to include more surrounding context`,
        };
      }
      // Replace ONE occurrence (we know there's exactly one).
      current = current.replace(block.search, block.replace);
    }
    finalContents.set(relPath, current);
  }

  // Phase 2: write everything. Only reached when every block validated.
  const writtenFiles: string[] = [];
  for (const [relPath, content] of finalContents) {
    const abs = resolve(worktreePath, relPath);
    writeFn(abs, content);
    writtenFiles.push(relPath);
  }
  return { ok: true, writtenFiles };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}
