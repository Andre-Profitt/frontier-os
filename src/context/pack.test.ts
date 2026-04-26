// Tests for the lane context-pack generator.
//
// Run:
//   node --import tsx --test src/context/pack.test.ts
//
// All tests use the live repo as the read source for the ai-stack-local-smoke
// lane. They are read-only — the generator does not write ledger entries,
// repair anything, or emit alerts. Two tests construct a synthetic temp repo
// to exercise dirty-tree and missing-lane paths without depending on the
// state of the actual working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  generateContextPack,
  renderMarkdown,
  type ContextPack,
} from "./pack.ts";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const LIVE_LANE = "ai-stack-local-smoke";

// --- generation against the live repo --------------------------------------

test("generateContextPack: ai-stack-local-smoke pack has the required fields", () => {
  const pack = generateContextPack({
    lane: LIVE_LANE,
    includeAlerts: false,
  });
  assert.equal(pack.repo.marker, "frontier-os");
  assert.equal(pack.repo.root, REPO_ROOT);
  assert.equal(pack.lane.factoryId, LIVE_LANE);
  assert.ok(pack.lane.factorySpecPath.endsWith("factory.json"));
  assert.ok(pack.lane.lane.primaryVerifier.length > 0);
  assert.ok(pack.lane.lane.innerCheck.length > 0);
  assert.ok(pack.lane.killSwitch.path.endsWith("state/disabled"));
  assert.equal(typeof pack.lane.killSwitch.active, "boolean");
  assert.ok(pack.lane.boundedRepair.minTimeoutSeconds >= 60);
  assert.ok(Array.isArray(pack.lane.policy.forbiddenActions));
  assert.ok(pack.lane.policy.forbiddenActions.length > 0);
  assert.ok(Array.isArray(pack.recentCommits));
  assert.ok(pack.recentCommits.length > 0);
  assert.ok(Array.isArray(pack.verificationCommands));
  assert.ok(
    pack.verificationCommands.some((c) => c.includes("npm run typecheck")),
  );
  assert.ok(
    pack.verificationCommands.some((c) =>
      c.includes(`factories/${LIVE_LANE}/run.ts`),
    ),
  );
});

test("generateContextPack: forbidden areas mention Siri, companion-platform, /Users/test/bin", () => {
  const pack = generateContextPack({
    lane: LIVE_LANE,
    includeAlerts: false,
  });
  const joined = pack.forbiddenAreas.join("\n").toLowerCase();
  assert.match(joined, /siri/);
  assert.match(joined, /companion-platform/);
  assert.match(joined, /\/users\/test\/bin/);
});

test("generateContextPack: kill switch active flag reflects filesystem state", () => {
  // Sanity baseline: do not run if the user has already armed the kill switch.
  const baseline = generateContextPack({
    lane: LIVE_LANE,
    includeAlerts: false,
  });
  if (baseline.lane.killSwitch.active) {
    throw new Error(
      "kill switch is currently active — refusing to perturb it during tests",
    );
  }
  const path = baseline.lane.killSwitch.path;
  writeFileSync(path, "test\n");
  try {
    const armed = generateContextPack({
      lane: LIVE_LANE,
      includeAlerts: false,
    });
    assert.equal(armed.lane.killSwitch.active, true);
  } finally {
    rmSync(path, { force: true });
  }
  const restored = generateContextPack({
    lane: LIVE_LANE,
    includeAlerts: false,
  });
  assert.equal(restored.lane.killSwitch.active, false);
});

test("generateContextPack: missing/wrong lane raises a clear error", () => {
  assert.throws(
    () =>
      generateContextPack({
        lane: "no-such-lane-12345",
        includeAlerts: false,
      }),
    /unknown lane: no-such-lane-12345/,
  );
});

// --- markdown render -------------------------------------------------------

test("renderMarkdown: includes factoryId, primary verifier, kill switch, forbidden areas, repo marker", () => {
  const pack = generateContextPack({
    lane: LIVE_LANE,
    includeAlerts: false,
  });
  const md = renderMarkdown(pack);
  assert.match(md, new RegExp(`# Lane context pack — ${LIVE_LANE}`));
  assert.match(md, /This is the `frontier-os` repo/);
  assert.match(md, /## Lane wiring/);
  assert.match(md, /\*\*primary verifier\*\*/);
  assert.match(md, /\/Users\/test\/bin\/ai-stack-local-smoke/);
  assert.match(md, /## Kill switch/);
  assert.match(md, /## Forbidden areas/);
  assert.match(md, /siri/i);
  assert.match(md, /companion-platform/);
  assert.match(md, /## Verification commands/);
  assert.match(md, /npm run typecheck/);
});

test("renderMarkdown: does not silently hide a dirty working tree", () => {
  // Synthesize a pack with a dirty tree and confirm the renderer flags it
  // rather than reporting "clean".
  const pack = generateContextPack({
    lane: LIVE_LANE,
    includeAlerts: false,
  });
  const dirty: ContextPack = {
    ...pack,
    gitStatus: {
      clean: false,
      modified: ["src/foo.ts"],
      untracked: ["scripts/bar.sh"],
      rawLines: [" M src/foo.ts", "?? scripts/bar.sh"],
    },
  };
  const md = renderMarkdown(dirty);
  assert.match(md, /Working tree is \*\*dirty\*\*/);
  assert.match(md, /1 modified, 1 untracked/);
  assert.match(md, / M src\/foo\.ts/);
  assert.match(md, /\?\? scripts\/bar\.sh/);
});

// --- isolated temp-repo cases (synthetic) ----------------------------------

test("generateContextPack: synthetic temp repo with dirty tree reports dirty status", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxpack-"));
  try {
    // package.json with the marker name so the repo-identity check passes.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "frontier-os", version: "0.0.0" }),
    );
    // Initialize a git repo and make a baseline commit so HEAD/log work.
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: dir,
    });
    spawnSync("git", ["config", "user.name", "ctx-test"], { cwd: dir });
    spawnSync("git", ["add", "package.json"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    // Drop a factory.json under the expected path with the minimum schema.
    const facDir = join(dir, "factories", "synthetic-lane");
    mkdirSync(facDir, { recursive: true });
    writeFileSync(
      join(facDir, "factory.json"),
      JSON.stringify({
        factoryId: "synthetic-lane",
        version: "v1",
        summary: "synthetic for tests",
        objective: "test",
        lane: {
          launchdLabel: "synth",
          launchdPlist: "/tmp/synth.plist",
          verifierEntry: "/tmp/synth-entry",
          primaryVerifier: ["/tmp/synth"],
          innerCheck: ["/tmp/inner"],
          logs: { out: "/tmp/out", err: "/tmp/err" },
        },
        policy: {
          approvalClass: 1,
          allowedActions: [],
          forbiddenActions: ["nothing"],
          escalation: [],
          killSwitchFile: "factories/synthetic-lane/state/disabled",
        },
        classification: {},
        boundedRepair: {
          kind: "noop",
          target: "/tmp/none",
          minTimeoutSeconds: 60,
          destructive: false,
          rollback: "n/a",
        },
        alert: {
          source: "synth",
          category: "health",
          severityByFinalClassification: {
            passed: null,
            failed: "high",
            ambiguous: "medium",
          },
        },
      }),
    );
    // Untracked file → dirty tree.
    writeFileSync(join(dir, "scratch.txt"), "dirty\n");

    const pack = generateContextPack({
      lane: "synthetic-lane",
      repoRoot: dir,
      includeAlerts: false,
    });
    assert.equal(pack.repo.root, dir);
    assert.equal(pack.gitStatus.clean, false);
    assert.ok(pack.gitStatus.untracked.includes("scratch.txt"));
    const md = renderMarkdown(pack);
    assert.match(md, /Working tree is \*\*dirty\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateContextPack: repo-identity warning when package.json name differs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxpack-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "wrong-name", version: "0.0.0" }),
    );
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@e.invalid"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    // Copy the live factory.json so we have a valid lane to point at.
    const facDir = join(dir, "factories", LIVE_LANE);
    mkdirSync(facDir, { recursive: true });
    cpSync(
      resolve(REPO_ROOT, "factories", LIVE_LANE, "factory.json"),
      join(facDir, "factory.json"),
    );
    const pack = generateContextPack({
      lane: LIVE_LANE,
      repoRoot: dir,
      includeAlerts: false,
    });
    assert.ok(
      pack.warnings.some((w) => w.includes("repo identity mismatch")),
      `expected identity warning, got: ${pack.warnings.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateContextPack: alerts skipped when ledger not readable", () => {
  const pack = generateContextPack({
    lane: LIVE_LANE,
    ledgerDb: "/nonexistent/path/to/ledger.db",
  });
  assert.equal(pack.recentAlerts, null);
  assert.ok(
    pack.warnings.some((w) => w.includes("ledger not readable")),
    `expected ledger warning, got: ${pack.warnings.join(" | ")}`,
  );
});

// --- side-effect freedom ---------------------------------------------------

test("generateContextPack: does not write to repo root or factory state", () => {
  const lsBefore = listingFingerprint(REPO_ROOT, [
    "factories",
    "src/context",
    "scripts",
  ]);
  generateContextPack({ lane: LIVE_LANE, includeAlerts: false });
  const lsAfter = listingFingerprint(REPO_ROOT, [
    "factories",
    "src/context",
    "scripts",
  ]);
  assert.equal(
    lsAfter,
    lsBefore,
    "filesystem fingerprint changed during pack generation",
  );
});

function listingFingerprint(root: string, subdirs: string[]): string {
  const res = spawnSync(
    "find",
    [...subdirs.map((s) => join(root, s)), "-type", "f", "-print"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return "";
  return (res.stdout ?? "").split("\n").filter(Boolean).sort().join("\n");
}

// Confirm the resolved repo-root path is what we expect (sanity).
test("REPO_ROOT resolution sanity", () => {
  assert.ok(existsSync(resolve(REPO_ROOT, "package.json")));
  assert.ok(
    existsSync(resolve(REPO_ROOT, "factories", LIVE_LANE, "factory.json")),
  );
});
