// Patch DD: cosine + rank helper unit tests. Pure-function math, no
// I/O. Pinned cases cover the degenerate inputs the reranker will
// realistically see (zero-magnitude vectors from a malformed embed
// response, length mismatch from a programming error).

import { test } from "node:test";
import assert from "node:assert/strict";

import { cosineSimilarity, rankByCosine } from "../embedding.ts";

test("cosineSimilarity: identical unit vectors → 1", () => {
  const v: number[] = [1, 0, 0];
  assert.equal(cosineSimilarity(v, v), 1);
});

test("cosineSimilarity: orthogonal vectors → 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors → -1", () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosineSimilarity: scale-invariant (magnitude doesn't change angle)", () => {
  const a = cosineSimilarity([1, 1, 1], [2, 2, 2]);
  assert.ok(
    Math.abs(a - 1) < 1e-9,
    `expected ~1 for parallel vectors, got ${a}`,
  );
});

test("cosineSimilarity: zero-magnitude input → 0 (not NaN)", () => {
  // A zero vector can come from a malformed embed response or a
  // model that returned empty content. NaN propagation would corrupt
  // downstream sort comparators silently; 0 is a safe "I have no
  // signal" value the caller can threshold against.
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("cosineSimilarity: empty vectors → 0 (not NaN)", () => {
  assert.equal(cosineSimilarity([], []), 0);
});

test("cosineSimilarity: length mismatch throws (programming error, not degenerate input)", () => {
  assert.throws(() => cosineSimilarity([1, 2, 3], [1, 2]), /length mismatch/);
});

test("rankByCosine: sorts candidates by descending similarity to query", () => {
  const query: number[] = [1, 0];
  const candidates: number[][] = [
    [0, 1], // score 0
    [1, 0], // score 1
    [-1, 0], // score -1
    [0.7, 0.7], // score ≈ 0.707
  ];
  const ranked = rankByCosine(query, candidates);
  assert.deepEqual(
    ranked.map((r) => r.index),
    [1, 3, 0, 2],
  );
  assert.equal(ranked[0]?.score, 1);
  assert.ok(Math.abs((ranked[1]?.score ?? 0) - 0.7071) < 1e-3);
  assert.equal(ranked[2]?.score, 0);
  assert.equal(ranked[3]?.score, -1);
});

test("rankByCosine: empty candidates → empty result (regression)", () => {
  assert.deepEqual(rankByCosine([1, 2, 3], []), []);
});
