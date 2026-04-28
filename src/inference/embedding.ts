// Patch DD: tiny embedding helpers. Foundation for the review-swarm
// anti-example reranker (handoff item #1) — when the corpus grows
// beyond ~10 entries, Patch W's "inline every entry" approach blows
// the prompt budget. With these helpers and OpenAICompatibleProvider's
// new embed() method, the reranker can score each entry against the
// candidate diff and inline only the top-k.
//
// Kept here (not in providers/) so consumers don't need to import a
// provider class to do similarity math. Pure functions, no I/O, no
// state.

// Patch DD: cosine similarity in [-1, 1]. Returns 0 (not NaN) when
// either vector is zero-length or zero-magnitude — those are
// degenerate inputs the caller can't act on, and propagating NaN
// silently corrupts downstream sort / threshold logic. Throws on
// length mismatch because that's a programming error, not a
// degenerate input.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: length mismatch (a.length=${a.length}, b.length=${b.length})`,
    );
  }
  if (a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Patch DD: rank candidates against a query by descending cosine
// similarity. Convenience wrapper for the common reranker pattern —
// embed query + N corpus entries in one batch, compute similarity to
// query[0], sort. Returns indices into `candidates` so callers keep
// their own metadata (paths, content) keyed by position.
export function rankByCosine(
  query: number[],
  candidates: number[][],
): Array<{ index: number; score: number }> {
  return candidates
    .map((c, index) => ({ index, score: cosineSimilarity(query, c) }))
    .sort((a, b) => b.score - a.score);
}
