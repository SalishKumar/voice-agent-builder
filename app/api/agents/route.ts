import { createAgent, listAgents, setAgentStatus } from "@/lib/db";
import { ingestFiles, type UploadedFile } from "@/lib/ingest";

// better-sqlite3 and pdf-parse are native/Node-only.
export const runtime = "nodejs";

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  return Response.json(listAgents());
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data" },
      { status: 400 }
    );
  }

  const name = field(form, "name");
  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });

  const prompt = field(form, "prompt");
  if (!prompt) {
    return Response.json({ error: "Prompt is required" }, { status: 400 });
  }

  const uploads: UploadedFile[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string" || !entry.name) continue;
    uploads.push({
      name: entry.name,
      buffer: Buffer.from(await entry.arrayBuffer()),
    });
  }

  const agent = createAgent({ name, prompt });

  try {
    const { chunkCount, skipped } = await ingestFiles(agent.id, uploads);
    setAgentStatus(agent.id, "ready");
    return Response.json(
      { id: agent.id, status: "ready", chunkCount, skipped },
      { status: 201 }
    );
  } catch (err) {
    // Includes MissingApiKeyError, whose message already tells the user what
    // to do, so it is surfaced verbatim.
    const message = err instanceof Error ? err.message : String(err);
    setAgentStatus(agent.id, "failed", message);
    return Response.json(
      { id: agent.id, status: "failed", error: message },
      { status: 500 }
    );
  }
}
