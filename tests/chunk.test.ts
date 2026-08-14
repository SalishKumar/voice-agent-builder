import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/chunk";

/** Subtask 2 — lib/chunk.ts (pure, no I/O). */
describe("chunkText", () => {
  it("returns no chunks for an empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns no chunks for whitespace-only input", () => {
    expect(chunkText("   \n\n\t  \r\n  ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    expect(chunkText("Refunds take three days.")).toEqual([
      "Refunds take three days.",
    ]);
  });

  it("packs consecutive paragraphs greedily while under maxChars", () => {
    const text = "alpha\n\nbravo\n\ncharlie";
    expect(chunkText(text, { maxChars: 100, overlap: 10 })).toEqual([
      "alpha\n\nbravo\n\ncharlie",
    ]);
  });

  it("starts a new chunk once the next paragraph would overflow maxChars", () => {
    const a = "a".repeat(30);
    const b = "b".repeat(30);
    const c = "c".repeat(30);
    const chunks = chunkText(`${a}\n\n${b}\n\n${c}`, {
      maxChars: 70,
      overlap: 10,
    });

    expect(chunks).toEqual([`${a}\n\n${b}`, c]);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(70);
  });

  it("hard-splits a paragraph longer than maxChars into bounded windows", () => {
    const long = "abcdefghij".repeat(50); // 500 chars, no whitespace
    const chunks = chunkText(long, { maxChars: 50, overlap: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(50);
  });

  it("makes consecutive hard-split windows genuinely overlap", () => {
    const long = "abcdefghij".repeat(50);
    const overlap = 10;
    const chunks = chunkText(long, { maxChars: 50, overlap });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i].slice(-overlap);
      expect(chunks[i + 1].startsWith(tail)).toBe(true);
    }
  });

  it("covers the whole source text across the overlapping windows", () => {
    const long = "abcdefghij".repeat(50);
    const chunks = chunkText(long, { maxChars: 50, overlap: 10 });

    // Stitch the windows back together by dropping each window's overlap.
    let rebuilt = chunks[0];
    for (let i = 1; i < chunks.length; i++) rebuilt += chunks[i].slice(10);
    expect(rebuilt).toBe(long);
  });

  it("normalises CRLF line endings", () => {
    expect(chunkText("alpha\r\n\r\nbravo", { maxChars: 100 })).toEqual([
      "alpha\n\nbravo",
    ]);
  });

  it("collapses three or more blank lines to a single paragraph break", () => {
    expect(chunkText("alpha\n\n\n\n\nbravo", { maxChars: 100 })).toEqual([
      "alpha\n\nbravo",
    ]);
    expect(chunkText("alpha\r\n\r\n\r\n\r\nbravo", { maxChars: 100 })).toEqual([
      "alpha\n\nbravo",
    ]);
  });

  it("never emits an empty or whitespace-only chunk", () => {
    const messy = `   \n\n\n${"x".repeat(120)}\n\n   \n\n\n\nshort tail\n\n\n   `;
    const chunks = chunkText(messy, { maxChars: 40, overlap: 8 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
      expect(chunk).toBe(chunk.trim());
    }
  });

  it(
    "does not hang when overlap is greater than or equal to maxChars",
    { timeout: 2000 },
    () => {
      const long = "abcdefghij".repeat(200); // 2000 chars
      const chunks = chunkText(long, { maxChars: 10, overlap: 50 });

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(10);
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
      // overlap is clamped to maxChars - 1, so the window advances by 1 char.
      expect(chunks[0]).toBe(long.slice(0, 10));
      expect(chunks[1]).toBe(long.slice(1, 11));
    }
  );

  it("does not hang when overlap equals maxChars exactly", { timeout: 2000 }, () => {
    const chunks = chunkText("z".repeat(300), { maxChars: 25, overlap: 25 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(25);
  });

  it("uses 800/100 defaults when no options are given", () => {
    const long = "abcdefghij".repeat(300); // 3000 chars
    const chunks = chunkText(long);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(800);
    expect(chunks[0].length).toBe(800);
    expect(chunks[1].startsWith(chunks[0].slice(-100))).toBe(true);
  });
});
