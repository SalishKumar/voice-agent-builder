import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempEnv } from "@/tests/helpers/tmp-env";

// Must run before the first import of lib/db: getDb() memoizes its connection.
const env = useTempEnv("db");

let db!: typeof import("@/lib/db");

beforeAll(async () => {
  db = await import("@/lib/db");
});

afterAll(() => {
  env.cleanup();
});

function seedAgent(name = "Support bot") {
  const agent = db.createAgent({ name, prompt: "Be helpful." });
  const file = db.insertFile({
    agentId: agent.id,
    filename: "handbook.md",
    path: `/tmp/${agent.id}/handbook.md`,
    bytes: 42,
  });
  return { agent, file };
}

/** Subtask 1 — lib/db.ts. */
describe("agents", () => {
  it("creates an agent in the building state and reads it back", () => {
    const agent = db.createAgent({ name: "Docs bot", prompt: "Answer docs." });

    expect(agent.status).toBe("building");
    expect(agent.error).toBeNull();
    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);

    const loaded = db.getAgent(agent.id);
    expect(loaded).toEqual(agent);
  });

  it("returns null for an unknown id", () => {
    expect(db.getAgent("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("updates status and error via setAgentStatus", () => {
    const agent = db.createAgent({ name: "Flaky", prompt: "p" });

    db.setAgentStatus(agent.id, "failed", "boom");
    expect(db.getAgent(agent.id)).toMatchObject({
      status: "failed",
      error: "boom",
    });

    db.setAgentStatus(agent.id, "ready");
    expect(db.getAgent(agent.id)).toMatchObject({
      status: "ready",
      error: null,
    });
  });
});

describe("chunk embeddings", () => {
  it("round-trips a Float32Array with identical values", () => {
    const { agent, file } = seedAgent();
    const embedding = Float32Array.from([
      0.5, -0.25, 0.125, 1, -1, 0, 3.5, 2.25,
    ]);

    db.insertChunks([
      { agentId: agent.id, fileId: file.id, content: "plain", embedding },
    ]);

    const [stored] = db.getChunks(agent.id);
    expect(stored.embedding).toBeInstanceOf(Float32Array);
    expect(stored.embedding.length).toBe(embedding.length);
    expect(Array.from(stored.embedding)).toEqual(Array.from(embedding));
    expect(stored.content).toBe("plain");
    expect(stored.file_id).toBe(file.id);
  });

  it("round-trips a sliced view with a non-zero byteOffset", () => {
    const { agent, file } = seedAgent();
    const backing = Float32Array.from([9, 9, 9, 0.5, -0.25, 0.125, 9, 9]);
    const sliced = backing.subarray(3, 6);

    expect(sliced.byteOffset).toBeGreaterThan(0);
    expect(sliced.length).toBe(3);

    db.insertChunks([
      {
        agentId: agent.id,
        fileId: file.id,
        content: "sliced",
        embedding: sliced,
      },
    ]);

    const [stored] = db.getChunks(agent.id);
    expect(stored.embedding.length).toBe(3);
    expect(Array.from(stored.embedding)).toEqual([0.5, -0.25, 0.125]);
  });

  it("inserts many chunks and counts them", () => {
    const { agent, file } = seedAgent();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      agentId: agent.id,
      fileId: file.id,
      content: `chunk ${i}`,
      embedding: Float32Array.from([i, i + 1, i + 2]),
    }));

    db.insertChunks(rows);

    expect(db.countChunks(agent.id)).toBe(25);
    const contents = db.getChunks(agent.id).map((c) => c.content).sort();
    expect(contents).toContain("chunk 0");
    expect(contents).toContain("chunk 24");
  });

  it("accepts an empty insert without error", () => {
    const { agent } = seedAgent();
    expect(() => db.insertChunks([])).not.toThrow();
    expect(db.countChunks(agent.id)).toBe(0);
  });
});

describe("deleteAgent", () => {
  it("cascades to files and chunks", () => {
    const { agent, file } = seedAgent("Doomed");
    db.insertChunks([
      {
        agentId: agent.id,
        fileId: file.id,
        content: "will be removed",
        embedding: Float32Array.from([1, 2, 3]),
      },
    ]);

    expect(db.listFiles(agent.id)).toHaveLength(1);
    expect(db.countChunks(agent.id)).toBe(1);

    db.deleteAgent(agent.id);

    expect(db.getAgent(agent.id)).toBeNull();
    expect(db.listFiles(agent.id)).toHaveLength(0);
    expect(db.countChunks(agent.id)).toBe(0);
    expect(db.getChunks(agent.id)).toHaveLength(0);
  });

  it("leaves other agents untouched", () => {
    const doomed = seedAgent("Doomed 2");
    const survivor = seedAgent("Survivor");
    db.insertChunks([
      {
        agentId: survivor.agent.id,
        fileId: survivor.file.id,
        content: "kept",
        embedding: Float32Array.from([1, 0, 0]),
      },
    ]);

    db.deleteAgent(doomed.agent.id);

    expect(db.getAgent(survivor.agent.id)).not.toBeNull();
    expect(db.countChunks(survivor.agent.id)).toBe(1);
  });
});

describe("listFiles", () => {
  it("returns the files for an agent, ordered by filename", () => {
    const agent = db.createAgent({ name: "Multi", prompt: "p" });
    for (const filename of ["zeta.txt", "alpha.md", "mid.md"]) {
      db.insertFile({
        agentId: agent.id,
        filename,
        path: `/tmp/${agent.id}/${filename}`,
        bytes: 1,
      });
    }

    expect(db.listFiles(agent.id).map((f) => f.filename)).toEqual([
      "alpha.md",
      "mid.md",
      "zeta.txt",
    ]);
  });
});

describe("uploadsDir", () => {
  it("honours UPLOADS_DIR and creates the directory", async () => {
    const { existsSync } = await import("node:fs");

    expect(db.uploadsDir()).toBe(env.uploadsDir);
    expect(existsSync(env.uploadsDir)).toBe(true);
  });
});
