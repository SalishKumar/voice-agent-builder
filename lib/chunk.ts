export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP = 100;

/** Normalise line endings and collapse runs of blank lines to a single break. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split a single oversized paragraph into fixed-width windows that overlap by
 * `overlap` characters. `overlap` is always < `maxChars`, so the cursor always
 * advances by at least one character and the loop always terminates.
 */
function hardSplit(text: string, maxChars: number, overlap: number): string[] {
  const step = maxChars - overlap;
  const out: string[] = [];

  for (let start = 0; start < text.length; start += step) {
    const piece = text.slice(start, start + maxChars).trim();
    if (piece) out.push(piece);
    if (start + maxChars >= text.length) break;
  }

  return out;
}

/**
 * Split text into embedding-sized chunks.
 *
 * Paragraphs are the unit of packing: consecutive paragraphs are greedily
 * combined while they fit inside `maxChars`, and any paragraph that is on its
 * own larger than `maxChars` is hard-split into overlapping windows.
 *
 * Pure — no I/O, safe to unit test directly.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  // Clamp so a window always advances; overlap >= maxChars would loop forever.
  const overlap = Math.min(
    Math.max(0, Math.floor(opts.overlap ?? DEFAULT_OVERLAP)),
    maxChars - 1
  );

  const normalised = normalise(text);
  if (!normalised) return [];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of normalised.split(/\n{2,}/)) {
    const para = paragraph.trim();
    if (!para) continue;

    if (para.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSplit(para, maxChars, overlap));
      continue;
    }

    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = para;
    }
  }

  if (current) chunks.push(current);

  return chunks.filter((chunk) => chunk.trim().length > 0);
}
