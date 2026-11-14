import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

/**
 * `npm run test:pg`: the store against a real Postgres server at PG_URL (the conformance suite and the races).
 * Standalone, not merged with vitest.config.ts: merging would join the two include and exclude lists.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^chaperone-chat$/, replacement: src("index.ts") },
      { find: /^chaperone-chat\/(guard|jev|links|http|postgres|client|react)$/, replacement: src("$1/index.ts") },
    ],
  },
  test: {
    include: ["test/pg/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
