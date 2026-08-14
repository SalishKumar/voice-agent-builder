import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `.mts` config is loaded as real ESM, where `__dirname` does not exist.
const rootDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/no-network.ts"],
  },
  resolve: {
    alias: { "@": rootDir },
  },
});
