/**
 * Builds a tiny but structurally valid single-page PDF with one line of text,
 * including a correct xref table. Used so the PDF happy path can be exercised
 * without checking a binary fixture into the repo.
 */
export function makeMinimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET\n`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\n` +
      `stream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}
