import { describe, expect, it } from "vitest";
import {
  SUPPORTED_EXTENSIONS,
  extractText,
  isSupported,
} from "@/lib/extract";
import { makeMinimalPdf } from "@/tests/helpers/make-pdf";

const UNICODE = "Café — naïve résumé 日本語 ✅";

/** Subtask 2 — lib/extract.ts. */
describe("isSupported", () => {
  it("accepts every advertised extension", () => {
    expect(SUPPORTED_EXTENSIONS).toEqual([".txt", ".md", ".markdown", ".pdf"]);
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(isSupported(`notes${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive about the extension", () => {
    expect(isSupported("README.MD")).toBe(true);
    expect(isSupported("notes.TXT")).toBe(true);
    expect(isSupported("Guide.MarkDown")).toBe(true);
    expect(isSupported("manual.PDF")).toBe(true);
  });

  it("rejects unsupported and extension-less names", () => {
    expect(isSupported("virus.exe")).toBe(false);
    expect(isSupported("archive.tar.gz")).toBe(false);
    expect(isSupported("Makefile")).toBe(false);
    expect(isSupported("photo.png")).toBe(false);
  });
});

describe("extractText", () => {
  it("round-trips UTF-8 content for .txt", async () => {
    const text = await extractText("notes.txt", Buffer.from(UNICODE, "utf8"));
    expect(text).toBe(UNICODE);
  });

  it("round-trips UTF-8 content for .md", async () => {
    const source = `# Heading\n\n${UNICODE}\n`;
    const text = await extractText("readme.md", Buffer.from(source, "utf8"));
    expect(text).toBe(source);
  });

  it("round-trips UTF-8 content for .markdown", async () => {
    const text = await extractText(
      "guide.markdown",
      Buffer.from(UNICODE, "utf8")
    );
    expect(text).toBe(UNICODE);
  });

  it("matches the extension case-insensitively", async () => {
    const text = await extractText("README.MD", Buffer.from(UNICODE, "utf8"));
    expect(text).toBe(UNICODE);
  });

  it("returns an empty string for an empty supported file", async () => {
    expect(await extractText("empty.txt", Buffer.alloc(0))).toBe("");
  });

  it("throws for an unsupported extension, naming the supported list", async () => {
    await expect(
      extractText("virus.exe", Buffer.from("MZ"))
    ).rejects.toThrow(/Unsupported file type/);

    await expect(extractText("virus.exe", Buffer.from("MZ"))).rejects.toThrow(
      new RegExp(SUPPORTED_EXTENSIONS.join(", ").replace(/\./g, "\\."))
    );
  });

  it("throws for a file with no extension at all", async () => {
    await expect(extractText("Makefile", Buffer.from("all:"))).rejects.toThrow(
      /Unsupported file type/
    );
  });

  it("wraps a malformed PDF in an error naming the file", async () => {
    const garbage = Buffer.from("this is definitely not a pdf", "utf8");

    await expect(extractText("broken.pdf", garbage)).rejects.toThrow(
      /Failed to read PDF/
    );
    await expect(extractText("broken.pdf", garbage)).rejects.toThrow(
      /broken\.pdf/
    );
  });

  it(
    "extracts text from a structurally valid PDF",
    { timeout: 30_000 },
    async () => {
      const pdf = makeMinimalPdf("Hello from the knowledge base");
      const text = await extractText("hello.pdf", pdf);
      expect(text).toContain("Hello from the knowledge base");
    }
  );
});
