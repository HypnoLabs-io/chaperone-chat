/**
 * The docs' code compiles: every TypeScript and JavaScript block in the README, CONTRIBUTING and docs/ is type-checked
 * against the package's source (in memory, through the TypeScript API), so what a reader pastes works.
 *
 * - A block whose first line is a path comment (`// lib/chat.ts`) is that file, so a page's blocks can import each
 *   other the way a project's files do. Any other block is a file of its own.
 * - JavaScript blocks are checked too (`checkJs`).
 * - A fence whose info string says `nocheck` (```ts nocheck) is a shape, not code, and is skipped.
 *
 * Also: every relative link in those files points at a file that exists.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VIRTUAL = join(ROOT, ".doc-blocks");
const LANGS: Record<string, string> = { ts: "ts", typescript: "ts", tsx: "tsx", js: "mjs", javascript: "mjs", mjs: "mjs" };
const PATH_COMMENT = /^\/\/ ([\w./-]+\.(?:ts|tsx|mjs|js))\s*$/;

interface Block {
  doc: string;
  /** The fence's line in the doc, 1-based. */
  line: number;
  lang: string;
  code: string;
  /** The virtual file it is checked as. */
  path: string;
}

function docs(): string[] {
  const top = ["README.md", "CONTRIBUTING.md"].filter((f) => existsSync(join(ROOT, f)));
  const dir = join(ROOT, "docs");
  const pages = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`) : [];
  return [...top, ...pages.sort()];
}

function blocksOf(doc: string): { blocks: Block[]; skipped: number } {
  const lines = readFileSync(join(ROOT, doc), "utf8").split("\n");
  const blocks: Block[] = [];
  let skipped = 0;
  let open: { lang: string; info: string; line: number; body: string[] } | null = null;
  lines.forEach((text, i) => {
    if (!open) {
      const fence = text.match(/^```(\S*)(.*)$/);
      if (fence) open = { lang: (fence[1] ?? "").toLowerCase(), info: fence[2] ?? "", line: i + 1, body: [] };
      return;
    }
    if (text.trim() !== "```") {
      open.body.push(text);
      return;
    }
    const ext = LANGS[open.lang];
    if (ext && /\bnocheck\b/.test(open.info)) skipped += 1;
    else if (ext) {
      const named = (open.body[0] ?? "").match(PATH_COMMENT);
      const base = doc.replace(/[^\w]+/g, "_");
      const path = named ? join(VIRTUAL, base, named[1] as string) : join(VIRTUAL, base, `block-${open.line}.${ext}`);
      blocks.push({ doc, line: open.line, lang: open.lang, code: open.body.join("\n"), path });
    }
    open = null;
  });
  return { blocks, skipped };
}

function compile(blocks: readonly Block[]): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.browser.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error("tsconfig.browser.json can't be read");
  const options: ts.CompilerOptions = { ...parsed.options, allowJs: true, checkJs: true, noEmit: true };

  const files = new Map<string, string>();
  const where = new Map<string, Block>();
  for (const b of blocks) {
    if (files.has(b.path)) throw new Error(`${b.doc}:${b.line} names a file another block already is: ${b.path}`);
    // Every block is a module of its own, whatever it imports.
    files.set(b.path, `${b.code}\nexport {};\n`);
    where.set(b.path, b);
  }

  // The virtual files' folders, which module resolution asks about before it looks for a file in one.
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    for (let d = dirname(path); d.startsWith(VIRTUAL); d = dirname(d)) dirs.add(d);
  }

  const host = ts.createCompilerHost(options, true);
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => files.has(f) || fileExists(f);
  host.directoryExists = (d) => dirs.has(d) || (directoryExists ? directoryExists(d) : true);
  host.readFile = (f) => files.get(f) ?? readFile(f);
  host.getSourceFile = (f, language, onError, create) => {
    const text = files.get(f);
    return text !== undefined ? ts.createSourceFile(f, text, language, true) : getSourceFile(f, language, onError, create);
  };

  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return message;
    const block = where.get(d.file.fileName);
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return block ? `${block.doc}:${block.line + 1 + line}: ${message}` : `${d.file.fileName}:${line + 1}: ${message}`;
  });
}

describe("the docs' code", () => {
  const all = docs().map(blocksOf);
  const blocks = all.flatMap((d) => d.blocks);

  it("finds the README's blocks", () => {
    expect(docs()).toContain("README.md");
    expect(blocks.filter((b) => b.doc === "README.md").length).toBeGreaterThanOrEqual(4);
  });

  it("compiles against the source", { timeout: 60_000 }, () => {
    expect(compile(blocks)).toEqual([]);
  });
});

/** A heading's anchor as GitHub makes it: lowercase, punctuation dropped, each space a hyphen. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** The anchors of a markdown file's headings, outside code blocks. */
function anchors(file: string): Set<string> {
  const out = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const h = !fenced && line.match(/^#{1,6} (.+)$/);
    if (h) out.add(slug(h[1] as string));
  }
  return out;
}

describe("the docs' links", () => {
  it("point at files and headings that exist", () => {
    const broken: string[] = [];
    for (const doc of docs()) {
      const from = join(ROOT, doc);
      for (const m of readFileSync(from, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = m[1] as string;
        if (/^[a-z]+:/i.test(link)) continue;
        const [path, anchor] = link.split("#") as [string, string | undefined];
        const target = path ? resolve(dirname(from), path) : from;
        if (!existsSync(target)) broken.push(`${doc}: ${link}`);
        else if (anchor && target.endsWith(".md") && !anchors(target).has(anchor)) broken.push(`${doc}: ${link} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
