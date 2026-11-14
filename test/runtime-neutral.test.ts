import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The library runs on Node, Bun, Deno and edge workers, so nothing outside the command line and the Node
 * adapter may touch Node's own API or read the environment: an adopter passes every key and secret in.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const NODE_ONLY = new Set(["cli/index.ts", "http/node.ts"]);
const FORBIDDEN: [string, RegExp][] = [
  ["process", /\bprocess\s*\./],
  ["a node: import", /from\s+["']node:|import\(\s*["']node:/],
  ["require()", /\brequire\s*\(/],
  ["Buffer", /\bBuffer\s*\./],
  ["__dirname", /\b__dirname\b|\b__filename\b/],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("runtime-neutral source", () => {
  const files = sourceFiles(SRC)
    .map((path) => relative(SRC, path).split("\\").join("/"))
    .filter((path) => !NODE_ONLY.has(path));

  it("covers every entry point", () => {
    for (const entry of ["index.ts", "guard/index.ts", "jev/index.ts", "links/index.ts", "http/index.ts", "postgres/index.ts", "client/index.ts", "react/index.ts"]) {
      expect(files).toContain(entry);
    }
  });

  // Comments may say "process." in prose; only code counts.
  const code = (file: string) =>
    readFileSync(join(SRC, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

  it.each(FORBIDDEN)("no source file outside the command line uses %s", (_name, pattern) => {
    const offenders = files.filter((file) => pattern.test(code(file)));
    expect(offenders).toEqual([]);
  });
});
