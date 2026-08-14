import type { Chunk } from "./types";

/**
 * Cosine similarity between two embedding vectors.
 *
 * Returns 0 for zero-magnitude vectors and for length mismatches. A mismatch
 * means the agent was indexed with a different embedding model, and scoring it
 * as "not similar" is friendlier than throwing a 500 at request time.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface Retrieved {
  chunk: Chunk;
  score: number;
}

/** The k chunks most similar to `query`, highest score first. */
export function topK(
  query: Float32Array,
  chunks: Chunk[],
  k = 4
): Retrieved[] {
  if (chunks.length === 0 || k <= 0) return [];

  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(query, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
