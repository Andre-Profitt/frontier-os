// Hermes-bridge policy tests.
//
// These tests pin two contracts:
//   1. Every wrapper script under scripts/hermes/ is enumerated in
//      hermes/policy.json — adding a wrapper without a policy entry is
//      a structural bug.
//   2. The wrappers refuse the documented bad inputs: missing
//      approval token on gated verbs, scope-mismatched token,
//      injection-style argv, unknown factoryId, unknown flags.
//
// The tests spawn the real wrapper scripts. They never set
// HERMES_APPROVAL_TOKEN in a way that would actually authorize a
// mutation — gated tests verify the refusal path, not the success
// path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), "..", "..");
const HERMES_DIR = resolve(REPO_ROOT, "scripts", "hermes");
const POLICY_FILE = resolve(REPO_ROOT, "hermes", "policy.json");

interface PolicyEntry {
  verb: string;
  wrapper?: string;
  underlying: string;
  mutating?: boolean;
  gated?: boolean;
  rationale: string;
  approvalEnvVar?: string;
  tokenScope?: string;
  ttlSeconds?: number;
}

interface Policy {
  version: string;
  description: string;
  allowed: PolicyEntry[];
  gated: PolicyEntry[];
  blocked: { pattern: string; rationale: string }[];
}

function loadPolicy(): Policy {
  return JSON.parse(readFileSync(POLICY_FILE, "utf8")) as Policy;
}

function listWrapperScripts(): string[] {
  return readdirSync(HERMES_DIR)
    .filter(
      (f) =>
        f.endsWith(".sh") &&
        f !== "_lib.sh" &&
        statSync(resolve(HERMES_DIR, f)).isFile(),
    )
    .map((f) => `scripts/hermes/${f}`)
    .sort();
}

// --- structural contracts ----------------------------------------------

test("policy.json exists and has the canonical sections", () => {
  assert.ok(existsSync(POLICY_FILE), "hermes/policy.json must exist");
  const p = loadPolicy();
  assert.equal(typeof p.version, "string");
  assert.ok(p.description.length > 50, "description must explain the bridge");
  assert.ok(Array.isArray(p.allowed) && p.allowed.length >= 1);
  assert.ok(Array.isArray(p.gated) && p.gated.length >= 1);
  assert.ok(Array.isArray(p.blocked) && p.blocked.length >= 4);
});

test("every wrapper script under scripts/hermes/ is declared in policy.allowed[]", () => {
  const policy = loadPolicy();
  const declared = new Set(
    policy.allowed.map((a) => a.wrapper).filter(Boolean),
  );
  const onDisk = listWrapperScripts();
  for (const path of onDisk) {
    assert.ok(
      declared.has(path),
      `wrapper ${path} exists on disk but is missing from hermes/policy.json allowed[]`,
    );
  }
});

test("every gated verb declares an approval env var + scope + TTL", () => {
  const policy = loadPolicy();
  for (const g of policy.gated) {
    assert.equal(
      g.approvalEnvVar,
      "HERMES_APPROVAL_TOKEN",
      `${g.verb}: approvalEnvVar must be HERMES_APPROVAL_TOKEN`,
    );
    assert.ok(g.tokenScope, `${g.verb}: tokenScope is required`);
    assert.ok(
      typeof g.ttlSeconds === "number" && g.ttlSeconds > 0,
      `${g.verb}: ttlSeconds must be a positive number`,
    );
  }
});

test("blocked patterns include the AGENTS.md hard rules", () => {
  const policy = loadPolicy();
  const allPatterns = policy.blocked.map((b) => b.pattern).join("|");
  assert.match(
    allPatterns,
    /launchctl/,
    "blocked must include a launchctl rule",
  );
  assert.match(
    allPatterns,
    /\/Users\/test\/bin/,
    "blocked must include a /Users/test/bin rule",
  );
  assert.match(
    allPatterns,
    /git/,
    "blocked must include a git push/commit rule",
  );
});

// --- runtime refusal contracts -----------------------------------------

function runWrapper(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(resolve(REPO_ROOT, script), args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("frontier-status.sh refuses unknown factoryId", () => {
  const r = runWrapper("scripts/hermes/frontier-status.sh", [
    "unknown-factory",
  ]);
  assert.equal(r.code, 31);
  assert.match(r.stderr, /unknown factoryId/);
});

test("frontier-status.sh refuses argv injection", () => {
  const r = runWrapper("scripts/hermes/frontier-status.sh", [
    "ai-stack-local-smoke; rm -rf /tmp/x",
  ]);
  assert.equal(r.code, 10);
  assert.match(r.stderr, /forbidden pattern/);
});

test("frontier-reconcile.sh active mode without token → refusal (code 20)", () => {
  const r = runWrapper(
    "scripts/hermes/frontier-reconcile.sh",
    ["ai-stack-local-smoke", "--mode", "active"],
    { HERMES_APPROVAL_TOKEN: "" },
  );
  assert.equal(r.code, 20);
  assert.match(r.stderr, /HERMES_APPROVAL_TOKEN/);
});

test("frontier-reconcile.sh active mode with wrong-scope token → refusal (code 21)", () => {
  const r = runWrapper(
    "scripts/hermes/frontier-reconcile.sh",
    ["ai-stack-local-smoke", "--mode", "active"],
    { HERMES_APPROVAL_TOKEN: "factory.activation.apply:abc123" },
  );
  assert.equal(r.code, 21);
  assert.match(r.stderr, /scope mismatch/);
});

test("frontier-reconcile.sh shadow mode without token → succeeds", () => {
  // Shadow runs ARE allowed without a token; this is the safe-by-default
  // pathway Hermes uses for routine status checks.
  const r = runWrapper("scripts/hermes/frontier-reconcile.sh", [
    "ai-stack-local-smoke",
    "--mode",
    "shadow",
  ]);
  // Exit code: 0=fresh, 1=stale|missing, 2=failed, 3=ambiguous, 5=locked.
  // Anything 0-5 is a successful pass through the gate; we don't care
  // which here, only that the gate didn't refuse with 20 or 21.
  assert.notEqual(r.code, 20);
  assert.notEqual(r.code, 21);
  // Output should be a JSON envelope.
  assert.match(r.stdout, /"bridge":\s*"frontier-os"/);
  assert.match(r.stdout, /"verb":\s*"factory\.reconcile\.shadow"/);
});

test("frontier-reconcile.sh refuses unknown mode", () => {
  const r = runWrapper("scripts/hermes/frontier-reconcile.sh", [
    "ai-stack-local-smoke",
    "--mode",
    "destruct",
  ]);
  assert.equal(r.code, 33);
  assert.match(r.stderr, /unknown mode/);
});

test("frontier-context-pack.sh refuses non-numeric --alert-lookback-days", () => {
  const r = runWrapper("scripts/hermes/frontier-context-pack.sh", [
    "ai-stack-local-smoke",
    "--alert-lookback-days",
    "not-a-number",
  ]);
  assert.equal(r.code, 32);
  assert.match(r.stderr, /non-negative integer/);
});

test("frontier-activation-dry-run.sh refuses extra args", () => {
  const r = runWrapper("scripts/hermes/frontier-activation-dry-run.sh", [
    "ai-stack-local-smoke",
    "--apply",
  ]);
  assert.equal(r.code, 30);
  assert.match(r.stderr, /usage:/);
});

test("frontier-activation-dry-run.sh succeeds with valid factory", () => {
  const r = runWrapper("scripts/hermes/frontier-activation-dry-run.sh", [
    "ai-stack-local-smoke",
  ]);
  assert.equal(r.code, 0);
  const env = JSON.parse(r.stdout);
  assert.equal(env.bridge, "frontier-os");
  assert.equal(env.verb, "factory.activation.dry-run");
  assert.equal(env.factoryId, "ai-stack-local-smoke");
  assert.match(env.output, /DRY RUN/);
  // Dry run must NEVER include "launchctl" as an executed verb;
  // it only PRINTS the operator-run command as instruction text.
  assert.match(env.output, /This is a DRY RUN/);
});

test("review-packet emits a structured envelope", () => {
  const r = runWrapper("scripts/hermes/frontier-review-packet.sh", []);
  assert.equal(r.code, 0, `review-packet exited ${r.code}: ${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.bridge, "frontier-os");
  assert.equal(env.verb, "factory.review-packet");
  assert.equal(typeof env.branch, "string");
  assert.equal(typeof env.head, "string");
  assert.ok(env.tests);
  assert.ok(typeof env.tests.passTotal === "number");
  assert.ok(typeof env.tests.failTotal === "number");
  assert.ok(env.typecheck);
  assert.ok(env.auditBlocks);
  assert.ok(env.forbiddenActions);
});

// --- defense-in-depth: the wrappers must never invoke launchctl -------

test("no wrapper script invokes launchctl directly", () => {
  for (const script of listWrapperScripts()) {
    const text = readFileSync(resolve(REPO_ROOT, script), "utf8");
    // The substring "launchctl" appears legitimately in the BLOCKLIST
    // pattern matching of _lib.sh; we only fail on actual command
    // invocations like `launchctl load|unload|bootstrap|bootout`.
    const lines = text.split("\n");
    const violations = lines.filter((line) => {
      const trimmed = line.trim();
      // skip comments
      if (trimmed.startsWith("#")) return false;
      // skip case-pattern lines like *'launchctl '*)
      if (/case\s+/.test(line)) return false;
      if (/\*'.*launchctl/.test(line)) return false;
      // detect a real command invocation
      return /(?:^|[\s|;&])launchctl\s+(load|unload|bootstrap|bootout)\b/.test(
        line,
      );
    });
    assert.deepEqual(
      violations,
      [],
      `${script} contains a real launchctl invocation: ${violations.join(", ")}`,
    );
  }
});
