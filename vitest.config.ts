import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // The demo and the tests import the package by name; inside the repo that is the source.
    alias: [
      { find: /^chaperone-chat$/, replacement: src("index.ts") },
      { find: /^chaperone-chat\/(guard|jev|links|http|postgres|client|react)$/, replacement: src("$1/index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/pg/**", "node_modules/**"],
    environment: "node",
  },
});
