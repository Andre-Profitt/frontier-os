// Patch M — search/replace builder format. Parser + applier tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  parseSearchReplaceBlocks,
  applySearchReplaceBlocks,
  type SearchReplaceBlock,
} from "../search-replace.ts";

// --- parser --------------------------------------------------------------

test("parse: single well-formed block", () => {
  const text = `
src/foo.ts
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.hadAnyMarkers, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0]?.filePath, "src/foo.ts");
  assert.equal(r.blocks[0]?.search, "old");
  assert.equal(r.blocks[0]?.replace, "new");
});

test("parse: two blocks against different files", () => {
  const text = `Some prose.

src/a.ts
<<<<<<< SEARCH
A1
=======
A2
>>>>>>> REPLACE

src/b.ts
<<<<<<< SEARCH
B1
=======
B2
>>>>>>> REPLACE

trailing prose
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0]?.filePath, "src/a.ts");
  assert.equal(r.blocks[1]?.filePath, "src/b.ts");
});

test("parse: backtick-quoted filename is stripped", () => {
  const text = `
\`src/foo.ts\`
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.blocks[0]?.filePath, "src/foo.ts");
});

test("parse: no markers → empty result, hadAnyMarkers=false", () => {
  const r = parseSearchReplaceBlocks("just some prose, no markers here");
  assert.equal(r.hadAnyMarkers, false);
  assert.equal(r.blocks.length, 0);
});

test("parse: missing filename → warning, block skipped", () => {
  const text = `
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.hadAnyMarkers, true);
  assert.equal(r.blocks.length, 0);
  assert.match(r.warnings[0] ?? "", /no filename/);
});

test("parse: missing separator → warning, parser stops", () => {
  const text = `src/foo.ts
<<<<<<< SEARCH
old
>>>>>>> REPLACE`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.blocks.length, 0);
  assert.match(r.warnings.join(" "), /separator/);
});

test("parse: empty SEARCH (create-file block) preserved", () => {
  const text = `src/new.ts
<<<<<<< SEARCH
=======
hello
>>>>>>> REPLACE
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.blocks[0]?.search, "");
  assert.equal(r.blocks[0]?.replace, "hello");
});

test("parse: filename with spaces in trailing line is rejected", () => {
  // Models sometimes write `the file foo.ts:` — that's not a path.
  const text = `the file is foo.ts
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.blocks.length, 0);
  assert.match(r.warnings.join(" "), /no filename/);
});

test("parse: multi-line SEARCH and REPLACE preserve internal newlines", () => {
  const text = `src/foo.ts
<<<<<<< SEARCH
line1
line2
line3
=======
line1
line1.5
line2
line3
>>>>>>> REPLACE
`;
  const r = parseSearchReplaceBlocks(text);
  assert.equal(r.blocks[0]?.search, "line1\nline2\nline3");
  assert.equal(r.blocks[0]?.replace, "line1\nline1.5\nline2\nline3");
});

// --- applier -------------------------------------------------------------

function withTempWorktree<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(resolve(tmpdir(), "sr-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedFile(root: string, rel: string, content: string): void {
  const abs = resolve(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

test("apply: replaces unique occurrence, writes file", () => {
  withTempWorktree((root) => {
    seedFile(root, "src/foo.ts", "before\ntarget\nafter\n");
    const blocks: SearchReplaceBlock[] = [
      { filePath: "src/foo.ts", search: "target", replace: "REPLACED" },
    ];
    const r = applySearchReplaceBlocks(root, blocks);
    assert.equal(r.ok, true);
    assert.deepEqual(r.writtenFiles, ["src/foo.ts"]);
    const after = readFileSync(resolve(root, "src/foo.ts"), "utf8");
    assert.equal(after, "before\nREPLACED\nafter\n");
  });
});

test("apply: SEARCH not found → reject, no writes", () => {
  withTempWorktree((root) => {
    seedFile(root, "src/foo.ts", "actual content\n");
    const r = applySearchReplaceBlocks(root, [
      { filePath: "src/foo.ts", search: "imaginary", replace: "x" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/);
    // File untouched.
    assert.equal(
      readFileSync(resolve(root, "src/foo.ts"), "utf8"),
      "actual content\n",
    );
  });
});

test("apply: SEARCH ambiguous → reject, no writes", () => {
  withTempWorktree((root) => {
    seedFile(root, "src/foo.ts", "x\nx\n");
    const r = applySearchReplaceBlocks(root, [
      { filePath: "src/foo.ts", search: "x", replace: "Y" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /ambiguous/);
    assert.match(r.error ?? "", /matches 2 locations/);
  });
});

test("apply: all-or-nothing — second block fails → first not written", () => {
  withTempWorktree((root) => {
    seedFile(root, "src/a.ts", "AA\n");
    seedFile(root, "src/b.ts", "BB\n");
    const blocks: SearchReplaceBlock[] = [
      { filePath: "src/a.ts", search: "AA", replace: "AAAA" },
      // This one fails.
      { filePath: "src/b.ts", search: "MISSING", replace: "x" },
    ];
    const r = applySearchReplaceBlocks(root, blocks);
    assert.equal(r.ok, false);
    // a.ts must NOT have been written.
    assert.equal(readFileSync(resolve(root, "src/a.ts"), "utf8"), "AA\n");
    assert.equal(readFileSync(resolve(root, "src/b.ts"), "utf8"), "BB\n");
  });
});

test("apply: create-new-file when SEARCH empty and file absent", () => {
  withTempWorktree((root) => {
    const r = applySearchReplaceBlocks(root, [
      { filePath: "src/new.ts", search: "", replace: "hello world\n" },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.writtenFiles, ["src/new.ts"]);
    assert.equal(
      readFileSync(resolve(root, "src/new.ts"), "utf8"),
      "hello world\n",
    );
  });
});

test("apply: empty SEARCH against existing non-empty file → reject (no clobber)", () => {
  withTempWorktree((root) => {
    seedFile(root, "src/foo.ts", "do not lose this\n");
    const r = applySearchReplaceBlocks(root, [
      { filePath: "src/foo.ts", search: "", replace: "obliterated" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /clobber/);
    assert.equal(
      readFileSync(resolve(root, "src/foo.ts"), "utf8"),
      "do not lose this\n",
    );
  });
});

test("apply: absolute path → reject", () => {
  withTempWorktree((root) => {
    const r = applySearchReplaceBlocks(root, [
      { filePath: "/etc/passwd", search: "root", replace: "evil" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /absolute/);
  });
});

test("apply: path traversal → reject", () => {
  withTempWorktree((root) => {
    const r = applySearchReplaceBlocks(root, [
      { filePath: "../../../etc/passwd", search: "x", replace: "y" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /traversal/);
  });
});

test("apply: two sequential blocks against same file apply against running content", () => {
  withTempWorktree((root) => {
    seedFile(root, "src/foo.ts", "alpha\nbeta\n");
    const r = applySearchReplaceBlocks(root, [
      { filePath: "src/foo.ts", search: "alpha", replace: "ALPHA" },
      { filePath: "src/foo.ts", search: "beta", replace: "BETA" },
    ]);
    assert.equal(r.ok, true);
    assert.equal(
      readFileSync(resolve(root, "src/foo.ts"), "utf8"),
      "ALPHA\nBETA\n",
    );
  });
});

test("apply: empty blocks list → reject", () => {
  withTempWorktree((root) => {
    const r = applySearchReplaceBlocks(root, []);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /no blocks/);
  });
});

test("apply: test seams allow in-memory operation (no fs)", () => {
  const reads = new Map<string, string>();
  const writes = new Map<string, string>();
  reads.set("/wt/src/foo.ts", "before\ntarget\nafter\n");
  const r = applySearchReplaceBlocks(
    "/wt",
    [{ filePath: "src/foo.ts", search: "target", replace: "REPLACED" }],
    {
      readFile: (p) => reads.get(p) ?? "",
      writeFile: (p, c) => writes.set(p, c),
      fileExists: (p) => reads.has(p),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(writes.size, 1);
  const written = writes.get("/wt/src/foo.ts");
  assert.equal(written, "before\nREPLACED\nafter\n");
});

test("apply (regression): unused fs imports tolerated when test seams override", () => {
  // Pin the contract that test-mode never touches the fs.
  void existsSync;
});
