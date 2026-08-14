import { describe, expect, it } from "vitest";
import { cosineSimilarity, topK } from "@/lib/retrieve";
import type { Chunk } from "@/lib/types";

function chunk(id: string, embedding: number[]): Chunk {
  return {
    id,
    agent_id: "agent-1",
    file_id: "file-1",
    content: `content ${id}`,
    embedding: Float32Array.from(embedding),
  };
}

/** Subtask 3 — lib/retrieve.ts (pure, no I/O). */
describe("cosineSimilarity", () => {
  it("scores identical vectors as 1", () => {
    const a = Float32Array.from([1, 2, 3, 4]);
    expect(cosineSimilarity(a, Float32Array.from([1, 2, 3, 4]))).toBeCloseTo(1, 6);
  });

  it("scores a scaled copy as 1 (direction, not magnitude)", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([10, 20, 30]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("scores orthogonal vectors as 0", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("scores opposite vectors as -1", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("returns 0 when either vector has zero magnitude", () => {
    const zero = Float32Array.from([0, 0, 0]);
    const nonZero = Float32Array.from([1, 2, 3]);

    expect(cosineSimilarity(zero, nonZero)).toBe(0);
    expect(cosineSimilarity(nonZero, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("returns 0 for mismatched lengths instead of throwing", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([1, 2]);

    expect(() => cosineSimilarity(a, b)).not.toThrow();
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(b, a)).toBe(0);
  });

  it("handles empty vectors without throwing", () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });
});

describe("topK", () => {
  const query = Float32Array.from([1, 0]);
  const chunks = [
    chunk("orthogonal", [0, 1]),
    chunk("exact", [1, 0]),
    chunk("opposite", [-1, 0]),
    chunk("close", [1, 0.1]),
    chunk("mid", [1, 1]),
    chunk("far", [-1, 1]),
  ];

  it("returns an empty array for no chunks", () => {
    expect(topK(query, [])).toEqual([]);
  });

  it("defaults to k = 4", () => {
    expect(topK(query, chunks)).toHaveLength(4);
  });

  it("respects an explicit k", () => {
    expect(topK(query, chunks, 2)).toHaveLength(2);
    expect(topK(query, chunks, 6)).toHaveLength(6);
  });

  it("returns everything when k exceeds the chunk count", () => {
    expect(topK(query, chunks, 100)).toHaveLength(chunks.length);
  });

  it("returns an empty array for k = 0 and negative k", () => {
    expect(topK(query, chunks, 0)).toEqual([]);
    expect(topK(query, chunks, -3)).toEqual([]);
  });

  it("orders results by descending score", () => {
    const results = topK(query, chunks, chunks.length);
    const scores = results.map((r) => r.score);

    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
    expect(results[0].chunk.id).toBe("exact");
    expect(results[0].score).toBeCloseTo(1, 6);
    expect(results[results.length - 1].chunk.id).toBe("opposite");
    expect(results[results.length - 1].score).toBeCloseTo(-1, 6);
  });

  it("returns the chunk alongside its score", () => {
    const [top] = topK(query, chunks, 1);
    expect(top.chunk.content).toBe("content exact");
    expect(typeof top.score).toBe("number");
  });
});
