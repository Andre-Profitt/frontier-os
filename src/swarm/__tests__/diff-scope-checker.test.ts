// Diff scope checker — pure-function unit tests. No fs, no subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseDiffFiles,
  diffHasBinaryMarkers,
  checkDiffScope,
} from "../diff-scope-checker.ts";

const SINGLE_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,2 @@
 a
+b
`;

const MULTI_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,2 @@
 a
+b
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1 +1,2 @@
 c
+d
`;

const NEW_FILE_DIFF = `diff --git a/added.ts b/added.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+export const v = 42;
`;

const RENAME_DIFF = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
`;

// --- parseDiffFiles -------------------------------------------------------

test("parseDiffFiles: empty input → []", () => {
  assert.deepEqual(parseDiffFiles(""), []);
});

test("parseDiffFiles: single-file diff via git header", () => {
  assert.deepEqual(parseDiffFiles(SINGLE_FILE_DIFF), ["src/foo.ts"]);
});

test("parseDiffFiles: multi-file diff dedups + sorts", () => {
  assert.deepEqual(parseDiffFiles(MULTI_FILE_DIFF), [
    "src/bar.ts",
    "src/foo.ts",
  ]);
});

test("parseDiffFiles: new file (a/ side is /dev/null) still parsed via git header", () => {
  assert.deepEqual(parseDiffFiles(NEW_FILE_DIFF), ["added.ts"]);
});

test("parseDiffFiles: rename records BOTH old and new paths", () => {
  // Conservative: a rename touches both names. Scope check should
  // require both to be allowed if touchList is set.
  const files = parseDiffFiles(RENAME_DIFF);
  assert.ok(files.includes("src/old.ts"));
  assert.ok(files.includes("src/new.ts"));
});

test("parseDiffFiles: --- a/ / +++ b/ fallback when no git header", () => {
  const noGit = `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n a\n+b\n`;
  assert.deepEqual(parseDiffFiles(noGit), ["x.ts"]);
});

// --- diffHasBinaryMarkers -------------------------------------------------

test("diffHasBinaryMarkers: 'Binary files differ' line → true", () => {
  const d = `diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n`;
  assert.equal(diffHasBinaryMarkers(d), true);
});

test("diffHasBinaryMarkers: 'GIT binary patch' line → true", () => {
  const d = `diff --git a/x.bin b/x.bin\nGIT binary patch\nliteral 0\n`;
  assert.equal(diffHasBinaryMarkers(d), true);
});

test("diffHasBinaryMarkers: text diff → false", () => {
  assert.equal(diffHasBinaryMarkers(SINGLE_FILE_DIFF), false);
});

// --- checkDiffScope -------------------------------------------------------

test("checkDiffScope: empty diff → allowed=true (gate doesn't fire)", () => {
  const r = checkDiffScope("", { touchList: ["src/foo.ts"] });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.touchedFiles, []);
});

test("checkDiffScope: empty touchList → gate skipped, allowed=true", () => {
  // The swarm passes an empty touchList when the caller didn't pin scope.
  // Skipping the gate is intentional — the call site is the one that
  // decides whether to require scope.
  const r = checkDiffScope(SINGLE_FILE_DIFF, { touchList: [] });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.touchedFiles, ["src/foo.ts"]);
});

test("checkDiffScope: every file in touchList → allowed=true", () => {
  const r = checkDiffScope(MULTI_FILE_DIFF, {
    touchList: ["src/foo.ts", "src/bar.ts"],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.violations.length, 0);
});

test("checkDiffScope: file outside touchList → allowed=false, reason cites the path", () => {
  const r = checkDiffScope(MULTI_FILE_DIFF, {
    touchList: ["src/foo.ts"], // bar.ts not allowed
  });
  assert.equal(r.allowed, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0]?.path, "src/bar.ts");
  assert.equal(r.violations[0]?.reason, "outside_touch_list");
  assert.match(r.reason, /outside_touch_list/);
});

test("checkDiffScope: rename rejected when only new path in touchList", () => {
  // Rename touches BOTH old and new — both must be allowed.
  const r = checkDiffScope(RENAME_DIFF, {
    touchList: ["src/new.ts"],
  });
  assert.equal(r.allowed, false);
  // src/old.ts is outside the touchList.
  assert.ok(r.violations.some((v) => v.path === "src/old.ts"));
});

test("checkDiffScope: binary patch rejected regardless of touchList", () => {
  const d = `diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n`;
  const r = checkDiffScope(d, { touchList: ["x.png"] });
  assert.equal(r.allowed, false);
  assert.ok(r.violations.some((v) => v.reason === "binary_file"));
});

test("checkDiffScope: absolute path rejected", () => {
  const d = `diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n@@ -0,0 +1 @@\n+pwn\n`;
  const r = checkDiffScope(d, { touchList: [] });
  assert.equal(r.allowed, false);
  assert.ok(r.violations.some((v) => v.reason === "absolute_path"));
});

test("checkDiffScope: parent traversal rejected", () => {
  const d = `diff --git a/../etc/passwd b/../etc/passwd\n--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -0,0 +1 @@\n+pwn\n`;
  const r = checkDiffScope(d, { touchList: [] });
  assert.equal(r.allowed, false);
  assert.ok(r.violations.some((v) => v.reason === "parent_traversal"));
});

test("checkDiffScope: prefix lookalike — touchList:src/foo, diff:src/foo-other → rejected", () => {
  // Defense in depth: scope check uses set-membership, not prefix match,
  // so foo and foo-other can't be confused.
  const d = `diff --git a/src/foo-other.ts b/src/foo-other.ts\n--- a/src/foo-other.ts\n+++ b/src/foo-other.ts\n@@ -1 +1,2 @@\n a\n+b\n`;
  const r = checkDiffScope(d, { touchList: ["src/foo.ts"] });
  assert.equal(r.allowed, false);
  assert.equal(r.violations[0]?.path, "src/foo-other.ts");
});
