import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-leaks.sh", import.meta.url));
// A made-up word, so this file never trips a real list.
const WORD = "quokkaflute";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "leak-check-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function run(root: string, ...args: string[]) {
  const env = { ...process.env, LEAK_PATTERNS_FILE: "", LEAK_REVIEW_FILE: "" };
  const result = spawnSync("bash", [script, ...args, root], { encoding: "utf8", env });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("scripts/check-leaks.sh", () => {
  it("fails on a planted word, any case, and names the file and line", () => {
    const root = fixture({ ".leak-patterns": `${WORD}\n`, "notes/a.md": `first line\nsee the ${WORD.toUpperCase()} here\n` });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toBe(`notes/a.md:2:see the ${WORD.toUpperCase()} here\n`);
  });

  it("prints nothing and passes on a clean tree, and never reports the list itself", () => {
    const root = fixture({ ".leak-patterns": `# guarded words\n\n${WORD}\n`, "src/a.ts": "export const a = 1;\n" });
    expect(run(root)).toEqual({ code: 0, out: "", err: "" });
  });

  it("checks dist/ and commit messages in a git repository", () => {
    const root = fixture({ ".leak-patterns": `${WORD}\n`, ".gitignore": "dist/\n.leak-patterns\n", "a.txt": "clean\n" });
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "clean subject", "-m", `a body naming ${WORD}`);
    writeFileSync(join(root, "a.txt"), "still clean\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), `// ${WORD}\n`);
    const r = run(root);
    expect(r.code).toBe(1);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`dist/index.js:1:// ${WORD}`);
    expect(lines[1]).toMatch(new RegExp(`^commit [0-9a-f]{7,}:a body naming ${WORD}$`));
  });

  it("checks nothing, and says so, without a list", () => {
    const root = fixture({ "a.txt": `${WORD}\n` });
    const r = run(root);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/nothing checked/);
  });

  it("--review prints the review list's hits and never fails", () => {
    const root = fixture({ ".leak-review": "household\n", "a.txt": "a household word\n" });
    const r = run(root, "--review");
    expect(r.code).toBe(0);
    expect(r.out).toBe("a.txt:1:a household word\n");
  });
});
