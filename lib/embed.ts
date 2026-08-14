import { EMBED_MODEL, getOpenAI } from "./openai";

/** Max inputs per embeddings request. Keeps payloads well inside API limits. */
const BATCH_SIZE = 96;

/**
 * Embed a batch of texts. Returns one vector per input, in the same order.
 * Throws MissingApiKeyError if OPENAI_API_KEY is unset.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const client = getOpenAI();
  const out: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await client.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
    });

    // The API may return items out of order; `index` is authoritative.
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    if (ordered.length !== batch.length) {
      throw new Error(
        `Embedding count mismatch: sent ${batch.length}, got ${ordered.length}`
      );
    }
    for (const item of ordered) {
      out.push(Float32Array.from(item.embedding));
    }
  }

  return out;
}

/** Embed a single text. Convenience wrapper around embedTexts. */
export async function embedOne(text: string): Promise<Float32Array> {
  const [vec] = await embedTexts([text]);
  return vec;
}
