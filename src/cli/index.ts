/** The `chaperone-chat` command: `calibrate` and `schema`. Node only. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "./run";

const corpusDir = fileURLToPath(new URL("../../corpus", import.meta.url));

// A reader that stops early (`chaperone-chat schema | head`) closes the pipe: stop quietly, not with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  read: (path) => readFile(path, "utf8").catch(() => null),
  write: (path, text) => writeFile(path, text),
  async importPolicy(path) {
    const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown; policy?: unknown };
    return mod.default ?? mod.policy;
  },
  corpusDir,
});
process.exitCode = code;
