import { copyFile, mkdir } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

/**
 * Four builds. No shared chunks: each entry carries its own copy of what it uses, so nothing may rely on
 * `instanceof` or module state across entries (errors carry a `code`).
 */
const dual: Options = {
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  splitting: false,
  // Off: tsup's rollup pass would strip the React entry's "use client" directive. esbuild still drops dead code.
  treeshake: false,
  target: "es2022",
  outDir: "dist",
};

export default defineConfig([
  // The runtime-neutral server entries: Node, Bun, Deno, edge workers.
  {
    ...dual,
    platform: "neutral",
    entry: {
      index: "src/index.ts",
      "guard/index": "src/guard/index.ts",
      "jev/index": "src/jev/index.ts",
      "links/index": "src/links/index.ts",
      "http/index": "src/http/index.ts",
      "postgres/index": "src/postgres/index.ts",
    },
  },
  // The framework-free browser client.
  {
    ...dual,
    platform: "browser",
    tsconfig: "tsconfig.browser.json",
    entry: { "client/index": "src/client/index.ts" },
  },
  // The React hook and component, a client module, plus its stylesheet.
  {
    ...dual,
    platform: "browser",
    tsconfig: "tsconfig.browser.json",
    entry: { "react/index": "src/react/index.ts" },
    external: ["react", "react-dom", "react/jsx-runtime"],
    banner: { js: '"use client";' },
    async onSuccess() {
      await mkdir("dist/react", { recursive: true });
      await copyFile("src/react/styles.css", "dist/react/styles.css");
    },
  },
  // The command line: ESM only, Node only.
  {
    format: ["esm"],
    platform: "node",
    target: "node22",
    entry: { "cli/index": "src/cli/index.ts" },
    outDir: "dist",
    banner: { js: "#!/usr/bin/env node" },
    dts: false,
    sourcemap: false,
    splitting: false,
  },
]);
