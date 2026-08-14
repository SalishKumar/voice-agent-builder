/**
 * Deterministic stand-in for a real embedding model.
 *
 * A simple folded letter-histogram: texts that share letters score highly under
 * cosine similarity, identical texts score exactly 1, and the result is stable
 * across runs and processes. The final dimension is always bumped so no vector
 * has zero magnitude (cosine similarity is undefined there and returns 0).
 */
export const EMBED_DIM = 16;

export function fakeVector(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const lower = text.toLowerCase();

  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if (code >= 97 && code <= 122) {
      vec[(code - 97) % EMBED_DIM] += 1;
    }
  }

  vec[EMBED_DIM - 1] += 1;
  return vec;
}
