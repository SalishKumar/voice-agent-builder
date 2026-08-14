import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempEnv {
  root: string;
  dbPath: string;
  uploadsDir: string;
  cleanup: () => void;
}

/**
 * Point `lib/db` at a throwaway sqlite file and uploads directory.
 *
 * MUST be called at the top level of a test file, before the first dynamic
 * `import("@/lib/db")` — `getDb()` memoizes its connection on first use, and
 * vitest runs each test file in its own process, so per-file is the right unit.
 */
export function useTempEnv(label: string): TempEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), `voice-${label}-`));
  const dbPath = path.join(root, "app.db");
  const uploadsDir = path.join(root, "uploads");

  process.env.DB_PATH = dbPath;
  process.env.UPLOADS_DIR = uploadsDir;

  return {
    root,
    dbPath,
    uploadsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
