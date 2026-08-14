import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  Agent,
  AgentFile,
  AgentStatus,
  Call,
  CallDirection,
  Chunk,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  twilio_call_sid TEXT,
  direction TEXT NOT NULL,
  phone_number TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  transcript TEXT,
  recording_url TEXT,
  duration_seconds INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_agent ON files(agent_id);
CREATE INDEX IF NOT EXISTS idx_chunks_agent ON chunks(agent_id);
CREATE INDEX IF NOT EXISTS idx_calls_agent ON calls(agent_id);
`;

let db: Database.Database | null = null;

function dbPath(): string {
  return process.env.DB_PATH ?? path.join(process.cwd(), "data", "app.db");
}

export function uploadsDir(): string {
  const dir =
    process.env.UPLOADS_DIR ?? path.join(process.cwd(), "data", "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Migrations for databases created under an older schema.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS` or `DROP COLUMN IF EXISTS`, so each
 * step is guarded by a `table_info` lookup. Every step here must be safe to
 * re-run on every boot.
 */
function migrate(conn: Database.Database): void {
  const columns = (table: string): string[] =>
    (conn.pragma(`table_info(${table})`) as { name: string }[]).map(
      (c) => c.name
    );

  if (!columns("calls").includes("twilio_call_sid")) {
    conn.exec(`ALTER TABLE calls ADD COLUMN twilio_call_sid TEXT`);
  }
  // Indexed here rather than in SCHEMA: SCHEMA runs before this migration, so
  // on a pre-existing database the column would not exist yet.
  conn.exec(
    `CREATE INDEX IF NOT EXISTS idx_calls_twilio ON calls(twilio_call_sid)`
  );

  // Vapi is gone; drop the columns that mirrored its ids so nothing can read a
  // stale one. The index is dropped first because SQLite refuses to drop a
  // column that an index still references. `DROP COLUMN` needs SQLite >= 3.35,
  // comfortably below what better-sqlite3 bundles.
  conn.exec(`DROP INDEX IF EXISTS idx_calls_vapi`);
  if (columns("calls").includes("vapi_call_id")) {
    conn.exec(`ALTER TABLE calls DROP COLUMN vapi_call_id`);
  }
  if (columns("agents").includes("vapi_assistant_id")) {
    conn.exec(`ALTER TABLE agents DROP COLUMN vapi_assistant_id`);
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  const file = dbPath();
  mkdirSync(path.dirname(file), { recursive: true });

  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  migrate(conn);

  db = conn;
  return db;
}

/**
 * better-sqlite3 BLOB buffers are views into a pooled allocation and are not
 * guaranteed to be 4-byte aligned, so copy the bytes into a fresh ArrayBuffer
 * before reinterpreting them as float32s.
 */
function toFloat32(buf: Buffer): Float32Array {
  const copy = new ArrayBuffer(buf.byteLength);
  Buffer.from(copy).set(buf);
  return new Float32Array(copy);
}

function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

interface AgentRow {
  id: string;
  name: string;
  prompt: string;
  status: string;
  error: string | null;
  created_at: number;
}

function toAgent(row: AgentRow): Agent {
  return { ...row, status: row.status as AgentStatus };
}

export function createAgent(input: { name: string; prompt: string }): Agent {
  const agent: Agent = {
    id: randomUUID(),
    name: input.name,
    prompt: input.prompt,
    status: "building",
    error: null,
    created_at: Date.now(),
  };

  getDb()
    .prepare(
      `INSERT INTO agents (id, name, prompt, status, error, created_at)
       VALUES (@id, @name, @prompt, @status, @error, @created_at)`
    )
    .run(agent);

  return agent;
}

export function getAgent(id: string): Agent | null {
  const row = getDb()
    .prepare(`SELECT * FROM agents WHERE id = ?`)
    .get(id) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function listAgents(): (Agent & {
  fileCount: number;
  chunkCount: number;
})[] {
  const rows = getDb()
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM files f WHERE f.agent_id = a.id) AS fileCount,
              (SELECT COUNT(*) FROM chunks c WHERE c.agent_id = a.id) AS chunkCount
       FROM agents a
       ORDER BY a.created_at DESC`
    )
    .all() as (AgentRow & { fileCount: number; chunkCount: number })[];

  return rows.map((row) => ({
    ...toAgent(row),
    fileCount: row.fileCount,
    chunkCount: row.chunkCount,
  }));
}

export function setAgentStatus(
  id: string,
  status: AgentStatus,
  error?: string | null
): void {
  getDb()
    .prepare(`UPDATE agents SET status = ?, error = ? WHERE id = ?`)
    .run(status, error ?? null, id);
}

/** Removes DB rows only (files cascade); the caller removes uploads from disk. */
export function deleteAgent(id: string): void {
  getDb().prepare(`DELETE FROM agents WHERE id = ?`).run(id);
}

export function insertFile(input: {
  agentId: string;
  filename: string;
  path: string;
  bytes: number;
}): AgentFile {
  const file: AgentFile = {
    id: randomUUID(),
    agent_id: input.agentId,
    filename: input.filename,
    path: input.path,
    bytes: input.bytes,
  };

  getDb()
    .prepare(
      `INSERT INTO files (id, agent_id, filename, path, bytes)
       VALUES (@id, @agent_id, @filename, @path, @bytes)`
    )
    .run(file);

  return file;
}

export function listFiles(agentId: string): AgentFile[] {
  return getDb()
    .prepare(`SELECT * FROM files WHERE agent_id = ? ORDER BY filename`)
    .all(agentId) as AgentFile[];
}

export function insertChunks(
  rows: {
    agentId: string;
    fileId: string;
    content: string;
    embedding: Float32Array;
  }[]
): void {
  const conn = getDb();
  const stmt = conn.prepare(
    `INSERT INTO chunks (id, agent_id, file_id, content, embedding)
     VALUES (?, ?, ?, ?, ?)`
  );

  const insertAll = conn.transaction((items: typeof rows) => {
    for (const row of items) {
      stmt.run(
        randomUUID(),
        row.agentId,
        row.fileId,
        row.content,
        toBlob(row.embedding)
      );
    }
  });

  insertAll(rows);
}

export function getChunks(agentId: string): Chunk[] {
  const rows = getDb()
    .prepare(
      `SELECT id, agent_id, file_id, content, embedding
       FROM chunks WHERE agent_id = ?`
    )
    .all(agentId) as {
    id: string;
    agent_id: string;
    file_id: string;
    content: string;
    embedding: Buffer;
  }[];

  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agent_id,
    file_id: row.file_id,
    content: row.content,
    embedding: toFloat32(row.embedding),
  }));
}

export function countChunks(agentId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE agent_id = ?`)
    .get(agentId) as { n: number };
  return row.n;
}

export function createCall(input: {
  agentId: string;
  /** Twilio's `CallSid`. Optional: an inbound row can exist before one is known. */
  twilioCallSid?: string | null;
  direction: CallDirection;
  phoneNumber: string | null;
  status: string;
}): Call {
  const call: Call = {
    id: randomUUID(),
    agent_id: input.agentId,
    twilio_call_sid: input.twilioCallSid ?? null,
    direction: input.direction,
    phone_number: input.phoneNumber,
    status: input.status,
    summary: null,
    transcript: null,
    recording_url: null,
    duration_seconds: null,
    created_at: Date.now(),
  };

  getDb()
    .prepare(
      `INSERT INTO calls (id, agent_id, twilio_call_sid, direction,
                          phone_number, status, summary, transcript,
                          recording_url, duration_seconds, created_at)
       VALUES (@id, @agent_id, @twilio_call_sid, @direction,
               @phone_number, @status, @summary, @transcript,
               @recording_url, @duration_seconds, @created_at)`
    )
    .run(call);

  return call;
}

/** Maps the camelCase patch keys callers use onto their snake_case columns. */
const CALL_PATCH_COLUMNS = {
  status: "status",
  summary: "summary",
  transcript: "transcript",
  recordingUrl: "recording_url",
  durationSeconds: "duration_seconds",
} as const;

export interface CallPatch {
  status: string;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  durationSeconds: number | null;
}

/**
 * Update a call by its Twilio `CallSid`, the only identifier Twilio's webhooks
 * and media streams carry. A no-op when nothing matches — events can arrive for
 * calls this app did not originate, and those are not an error.
 */
export function updateCallByTwilioSid(
  callSid: string,
  patch: Partial<CallPatch>
): void {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, patchColumn] of Object.entries(CALL_PATCH_COLUMNS)) {
    const value = patch[key as keyof CallPatch];
    if (value === undefined) continue;
    assignments.push(`${patchColumn} = ?`);
    values.push(value);
  }

  if (assignments.length === 0) return;

  values.push(callSid);
  getDb()
    .prepare(
      `UPDATE calls SET ${assignments.join(", ")} WHERE twilio_call_sid = ?`
    )
    .run(...values);
}

/** Calls for an agent, newest first. */
export function listCalls(agentId: string, limit = 20): Call[] {
  return getDb()
    .prepare(
      `SELECT * FROM calls WHERE agent_id = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, limit) as Call[];
}

export function getCallByTwilioSid(callSid: string): Call | null {
  const row = getDb()
    .prepare(`SELECT * FROM calls WHERE twilio_call_sid = ?`)
    .get(callSid) as Call | undefined;
  return row ?? null;
}
