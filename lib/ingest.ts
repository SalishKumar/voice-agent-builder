import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkText } from "./chunk";
import { insertChunks, insertFile, uploadsDir } from "./db";
import { embedTexts } from "./embed";
import { extractText, isSupported } from "./extract";

export interface UploadedFile {
  name: string;
  buffer: Buffer;
}

export interface IngestResult {
  chunkCount: number;
  /** Names of uploads that were not ingested (unsupported type or unusable name). */
  skipped: string[];
}

/**
 * Reduce a client-supplied filename to a bare, disk-safe basename.
 * Returns null when nothing usable survives, in which case the upload is skipped.
 */
export function sanitiseFilename(name: string): string | null {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || base === "." || base === "..") return null;
  return base;
}

/** First free path for `name` inside `dir`, adding a numeric suffix on collision. */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);

  // turbopackIgnore keeps this runtime-only lookup from tracing the whole project.
  let candidate = path.join(dir, name);
  for (let n = 1; existsSync(/*turbopackIgnore: true*/ candidate); n++) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
  }
  return candidate;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Persist the uploads for an agent, extract and chunk their text, embed every
 * chunk in one pass and store the result.
 *
 * Unsupported files are skipped rather than failing the build; a file that
 * fails extraction fails the whole build.
 */
export async function ingestFiles(
  agentId: string,
  uploads: UploadedFile[]
): Promise<IngestResult> {
  const dir = path.join(uploadsDir(), agentId);
  await mkdir(dir, { recursive: true });

  const skipped: string[] = [];
  const pending: { fileId: string; content: string }[] = [];

  for (const upload of uploads) {
    const safeName = sanitiseFilename(upload.name);
    if (!safeName || !isSupported(safeName)) {
      skipped.push(upload.name);
      continue;
    }

    // Belt and braces: sanitiseFilename already stripped every path separator,
    // so the join can only ever land directly inside the agent's own directory.
    const target = uniquePath(dir, safeName);
    if (path.dirname(target) !== dir) {
      skipped.push(upload.name);
      continue;
    }

    await writeFile(target, upload.buffer);
    const record = insertFile({
      agentId,
      filename: safeName,
      path: target,
      bytes: upload.buffer.byteLength,
    });

    let text: string;
    try {
      text = await extractText(safeName, upload.buffer);
    } catch (err) {
      throw new Error(
        `Failed to process "${upload.name}": ${messageOf(err)}`
      );
    }

    for (const content of chunkText(text)) {
      pending.push({ fileId: record.id, content });
    }
  }

  if (pending.length === 0) return { chunkCount: 0, skipped };

  const embeddings = await embedTexts(pending.map((item) => item.content));
  insertChunks(
    pending.map((item, i) => ({
      agentId,
      fileId: item.fileId,
      content: item.content,
      embedding: embeddings[i],
    }))
  );

  return { chunkCount: pending.length, skipped };
}
