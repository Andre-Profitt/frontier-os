// Behavioral guard for the subprocess-timeout follow-up.
//
// PR #6 added `timeout: 5_000` to read-only subprocess calls in
// src/context/pack.ts and evals/factory-quality/run.ts. This test proves
// the underlying contract those callers rely on: Node's spawnSync `timeout`
// option actually kills a hung child process and returns control within
// the configured window.
//
// If a future Node upgrade or build flag broke this contract, the
// timeouts those production callers added would silently become no-ops.
// This test catches that regression by spawning `sleep 30` with a 200ms
// timeout and asserting the call returns in well under a second.
//
// Run:
//   node --import tsx --test tests/lib/subprocess-timeout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("spawnSync timeout kills a hung subprocess and returns control quickly", () => {
  // sleep is in /bin on macOS and /usr/bin on most Linuxes — let PATH find it.
  const t0 = Date.now();
  const res = spawnSync("sleep", ["30"], {
    encoding: "utf8",
    timeout: 200,
  });
  const elapsed = Date.now() - t0;
  // Should have come back well before sleep's 30s would have elapsed, and
  // well before any reasonable test-runner-level interrupt.
  assert.ok(
    elapsed < 2_000,
    `expected timeout to fire within 2s, but spawnSync returned after ${elapsed}ms`,
  );
  // When timeout fires, status is null and signal is SIGTERM (Node's
  // documented behavior). A non-null status would mean sleep exited
  // normally — which can't happen at 30s with a 200ms budget.
  assert.equal(
    res.status,
    null,
    `expected status=null on timeout, got ${res.status}`,
  );
  // signal should be SIGTERM by default.
  assert.equal(
    res.signal,
    "SIGTERM",
    `expected signal=SIGTERM, got ${res.signal}`,
  );
});

test("spawnSync timeout does not affect a quick subprocess", () => {
  // Sanity check that a timeout option that does not fire leaves the
  // happy path untouched.
  const res = spawnSync("true", [], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.signal, null);
});

test("spawnSync timeout=5000 is generous for read-only local ops", () => {
  // Document the constant-of-art: a trivial sqlite3 query against an empty
  // file completes well under the 5s budget the production code uses.
  // This doubles as a smoke test that sqlite3 is on PATH (the production
  // code assumes the same).
  const res = spawnSync("sqlite3", [":memory:", "SELECT 1;"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(
    res.status,
    0,
    `sqlite3 not available or unexpected exit: ${res.stderr}`,
  );
  assert.match(res.stdout ?? "", /^1\b/);
});
