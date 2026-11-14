/**
 * Part of `npm run smoke:pack`. Writes every README code block whose first line is a path comment (`// lib/chat.ts`)
 * into <out>/<that path>, and the quickstart's printed output (the text block after `$ node try.mjs`) into
 * <out>/try.expected.
 *
 *   node readme-files.mjs node_modules/chaperone-chat/README.md readme
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [readme, out] = process.argv.slice(2);
if (!readme || !out) {
  console.error("usage: node readme-files.mjs <README.md> <out dir>");
  process.exit(2);
}

const written = [];
let open = null;
for (const line of readFileSync(readme, "utf8").split("\n")) {
  if (!open) {
    const fence = line.match(/^```(\S*)/);
    if (fence) open = { lang: fence[1], body: [] };
    continue;
  }
  if (line.trim() !== "```") {
    open.body.push(line);
    continue;
  }
  const named = (open.body[0] ?? "").match(/^\/\/ ([\w./-]+\.(?:ts|tsx|mjs|js))\s*$/);
  if (named) {
    const path = join(out, named[1]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${open.body.join("\n")}\n`);
    written.push(named[1]);
  } else if (open.lang === "text" && open.body[0]?.startsWith("$ node try.mjs")) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "try.expected"), `${open.body.slice(1).join("\n")}\n`);
    written.push("try.expected");
  }
  open = null;
}
if (!written.includes("try.mjs") || !written.includes("try.expected")) {
  console.error("readme-files: the README's quickstart (try.mjs and its output) wasn't found");
  process.exit(1);
}
console.log(`readme-files: ${written.length} files from the README`);
