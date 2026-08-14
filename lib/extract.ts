import path from "node:path";
import type { PDFParse } from "pdf-parse";

export const SUPPORTED_EXTENSIONS: readonly string[] = [
  ".txt",
  ".md",
  ".markdown",
  ".pdf",
];

function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

export function isSupported(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(filename));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function extractPdf(filename: string, buffer: Buffer): Promise<string> {
  // Imported lazily: pdf-parse pulls in pdfjs-dist, which is expensive to load
  // and only needed when a PDF is actually uploaded.
  let parser: PDFParse | null = null;
  try {
    const { PDFParse } = await import("pdf-parse");
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return result.text;
  } catch (err) {
    throw new Error(`Failed to read PDF "${filename}": ${messageOf(err)}`);
  } finally {
    // Never let cleanup mask the real failure.
    await parser?.destroy().catch(() => undefined);
  }
}

/**
 * Extract plain text from an uploaded file. Throws if the extension is not one
 * of SUPPORTED_EXTENSIONS. Extension matching is case-insensitive.
 */
export async function extractText(
  filename: string,
  buffer: Buffer
): Promise<string> {
  const ext = extensionOf(filename);

  switch (ext) {
    case ".txt":
    case ".md":
    case ".markdown":
      return buffer.toString("utf8");
    case ".pdf":
      return extractPdf(filename, buffer);
    default:
      throw new Error(
        `Unsupported file type "${ext || filename}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`
      );
  }
}
