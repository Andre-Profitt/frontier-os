// Diff extractor — pure function, no fs or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractDiffs, looksLikeDiff } from "../diff-extractor.ts";

const SAMPLE_DIFF = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 export const x = 1;
+export const y = 2;
 export const z = 3;`;

const INLINE_HUNK_DIFF = `--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;`;

// --- looksLikeDiff -------------------------------------------------------

test("looksLikeDiff: recognizes a git-style diff", () => {
  assert.equal(looksLikeDiff(SAMPLE_DIFF), true);
});

test("looksLikeDiff: recognizes a unified --- / +++ pair without git header", () => {
  assert.equal(looksLikeDiff(INLINE_HUNK_DIFF), true);
});

test("looksLikeDiff: rejects markdown text containing @@ comments", () => {
  assert.equal(
    looksLikeDiff("Note: see line @@ in foo.md for context."),
    false,
  );
});

test("looksLikeDiff: rejects empty / whitespace input", () => {
  assert.equal(looksLikeDiff(""), false);
  assert.equal(looksLikeDiff("   \n\t  "), false);
});

// --- extractDiffs --------------------------------------------------------

test("extractDiffs: empty input → []", () => {
  assert.deepEqual(extractDiffs(""), []);
});

test("extractDiffs: non-string input is tolerated", () => {
  // @ts-expect-error — exercising runtime guard
  assert.deepEqual(extractDiffs(undefined), []);
});

test("extractDiffs: pulls diff out of a ```diff fenced block", () => {
  const text = `Here's the patch:\n\n\`\`\`diff\n${SAMPLE_DIFF}\n\`\`\`\n\nLet me know.`;
  const diffs = extractDiffs(text);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.source, "fenced");
  assert.ok(diffs[0]?.diff.includes("export const y"));
});

test("extractDiffs: pulls diff out of a ```patch fenced block", () => {
  const text = `\`\`\`patch\n${SAMPLE_DIFF}\n\`\`\``;
  const diffs = extractDiffs(text);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.source, "fenced");
});

test("extractDiffs: ignores fenced blocks that are not real diffs", () => {
  const text = "```diff\nrandom prose with no @@ marker\n```";
  assert.deepEqual(extractDiffs(text), []);
});

test("extractDiffs: returns multiple fenced diffs sorted longest-first", () => {
  const small = `\`\`\`diff\n--- a/short.ts\n+++ b/short.ts\n@@ -1 +1,2 @@\n a\n+b\n\`\`\``;
  const big = `\`\`\`diff\n${SAMPLE_DIFF}\n\`\`\``;
  const diffs = extractDiffs(`${small}\n\n${big}`);
  assert.equal(diffs.length, 2);
  assert.ok((diffs[0]?.diff.length ?? 0) >= (diffs[1]?.diff.length ?? 0));
});

test("extractDiffs: falls back to inline diff when no fences present", () => {
  const text = `Here's the patch in unified form:\n\n${INLINE_HUNK_DIFF}\n\nThat's it.`;
  const diffs = extractDiffs(text);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.source, "inline");
  assert.ok(diffs[0]?.diff.includes("@@ -1,2 +1,3 @@"));
});

test("extractDiffs: prefers fenced over inline when both present", () => {
  const fenced = `\`\`\`diff\n${SAMPLE_DIFF}\n\`\`\``;
  const text = `${INLINE_HUNK_DIFF}\n\n${fenced}`;
  const diffs = extractDiffs(text);
  // Inline branch only triggers when fenced.length === 0.
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.source, "fenced");
});

test("extractDiffs: records line numbers", () => {
  const text = `line 1\nline 2\n\n\`\`\`diff\n${SAMPLE_DIFF}\n\`\`\``;
  const diffs = extractDiffs(text);
  assert.equal(diffs[0]?.startLine, 4);
});
