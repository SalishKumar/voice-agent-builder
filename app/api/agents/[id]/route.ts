import { rm } from "node:fs/promises";
import path from "node:path";
import {
  countChunks,
  deleteAgent,
  getAgent,
  listFiles,
  uploadsDir,
} from "@/lib/db";

// better-sqlite3 is native and cannot run on the edge runtime.
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function notFound() {
  return Response.json({ error: "Agent not found" }, { status: 404 });
}

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) return notFound();

  return Response.json({
    ...agent,
    files: listFiles(agent.id),
    chunkCount: countChunks(agent.id),
  });
}

export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) return notFound();

  deleteAgent(agent.id);
  // agent.id comes from the database, so this path is always inside uploadsDir.
  await rm(path.join(uploadsDir(), agent.id), {
    recursive: true,
    force: true,
  });

  return Response.json({ ok: true });
}
