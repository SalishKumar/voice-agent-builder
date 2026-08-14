import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent, AgentFile } from "@/lib/types";
import { useTempEnv } from "@/tests/helpers/tmp-env";

// Must run before the first import of lib/db: getDb() memoizes its connection.
const env = useTempEnv("read");

let listRoute!: typeof import("@/app/api/agents/route");
let itemRoute!: typeof import("@/app/api/agents/[id]/route");
let db!: typeof import("@/lib/db");

beforeAll(async () => {
  listRoute = await import("@/app/api/agents/route");
  itemRoute = await import("@/app/api/agents/[id]/route");
  db = await import("@/lib/db");
});

afterAll(() => {
  env.cleanup();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(url = "http://localhost/api/agents/x"): Request {
  return new Request(url);
}

/**
 * Creates agents with strictly increasing created_at values so the newest-first
 * ordering assertion cannot flake on same-millisecond ties.
 */
function createAgentsWithDistinctTimestamps(names: string[]): Agent[] {
  let clock = 1_700_000_000_000;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
  try {
    return names.map((name) => db.createAgent({ name, prompt: `${name} prompt` }));
  } finally {
    spy.mockRestore();
  }
}

/** Subtask 2 — GET /api/agents and GET|DELETE /api/agents/[id]. */
describe("GET /api/agents", () => {
  it("returns agents newest-first with correct fileCount and chunkCount", async () => {
    const [oldest, middle, newest] = createAgentsWithDistinctTimestamps([
      "Oldest",
      "Middle",
      "Newest",
    ]);

    const file = db.insertFile({
      agentId: middle.id,
      filename: "handbook.md",
      path: path.join(env.uploadsDir, middle.id, "handbook.md"),
      bytes: 10,
    });
    db.insertFile({
      agentId: middle.id,
      filename: "faq.txt",
      path: path.join(env.uploadsDir, middle.id, "faq.txt"),
      bytes: 20,
    });
    db.insertChunks(
      Array.from({ length: 3 }, (_, i) => ({
        agentId: middle.id,
        fileId: file.id,
        content: `chunk ${i}`,
        embedding: Float32Array.from([i, 1, 0]),
      }))
    );

    const response = await listRoute.GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as (Agent & {
      fileCount: number;
      chunkCount: number;
    })[];

    expect(body.map((a) => a.id)).toEqual([newest.id, middle.id, oldest.id]);

    const created = body.map((a) => a.created_at);
    for (let i = 0; i < created.length - 1; i++) {
      expect(created[i]).toBeGreaterThan(created[i + 1]);
    }

    const middleRow = body.find((a) => a.id === middle.id);
    expect(middleRow).toMatchObject({ fileCount: 2, chunkCount: 3 });

    const newestRow = body.find((a) => a.id === newest.id);
    expect(newestRow).toMatchObject({ fileCount: 0, chunkCount: 0 });
  });
});

describe("GET /api/agents/[id]", () => {
  it("404s for an unknown id", async () => {
    const response = await itemRoute.GET(
      request(),
      ctx("00000000-0000-0000-0000-000000000000")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found" });
  });

  it("returns the agent with its files and chunk count", async () => {
    const agent = db.createAgent({ name: "Detail", prompt: "Say hi." });
    db.setAgentStatus(agent.id, "ready");

    const file = db.insertFile({
      agentId: agent.id,
      filename: "notes.md",
      path: path.join(env.uploadsDir, agent.id, "notes.md"),
      bytes: 7,
    });
    db.insertChunks([
      {
        agentId: agent.id,
        fileId: file.id,
        content: "only chunk",
        embedding: Float32Array.from([1, 0, 0]),
      },
    ]);

    const response = await itemRoute.GET(request(), ctx(agent.id));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Agent & {
      files: AgentFile[];
      chunkCount: number;
    };

    expect(body).toMatchObject({
      id: agent.id,
      name: "Detail",
      prompt: "Say hi.",
      status: "ready",
      chunkCount: 1,
    });
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ filename: "notes.md", bytes: 7 });
  });
});

describe("DELETE /api/agents/[id]", () => {
  it("removes the DB rows and the upload directory, and 404s on a repeat", async () => {
    const agent = db.createAgent({ name: "Doomed", prompt: "p" });
    const file = db.insertFile({
      agentId: agent.id,
      filename: "notes.md",
      path: path.join(env.uploadsDir, agent.id, "notes.md"),
      bytes: 5,
    });
    db.insertChunks([
      {
        agentId: agent.id,
        fileId: file.id,
        content: "gone soon",
        embedding: Float32Array.from([1, 2, 3]),
      },
    ]);

    const agentDir = path.join(env.uploadsDir, agent.id);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "notes.md"), "hello");
    expect(existsSync(agentDir)).toBe(true);

    const first = await itemRoute.DELETE(request(), ctx(agent.id));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    expect(db.getAgent(agent.id)).toBeNull();
    expect(db.listFiles(agent.id)).toHaveLength(0);
    expect(db.countChunks(agent.id)).toBe(0);
    expect(existsSync(agentDir)).toBe(false);
    expect(existsSync(env.uploadsDir)).toBe(true);

    const second = await itemRoute.DELETE(request(), ctx(agent.id));
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "Agent not found" });
  });

  it("404s for an unknown id without touching the uploads directory", async () => {
    const response = await itemRoute.DELETE(
      request(),
      ctx("11111111-1111-1111-1111-111111111111")
    );

    expect(response.status).toBe(404);
    expect(existsSync(env.uploadsDir)).toBe(true);
  });
});
