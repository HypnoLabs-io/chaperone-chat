/**
 * `npx chaperone-chat calibrate` and `schema`, with files in memory and Jev's network mocked at `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run, type CliIo } from "../../src/cli/run";
import { contactLeak, definePolicy, policyFingerprint } from "../../src/guard";
import { DEFAULT_JEV_MODEL } from "../../src/jev";

const SET = {
  samples: [
    { id: "s1", text: "Tuesdays work.", positive: false },
    { id: "s2", text: "Find me where the birds tweet.", positive: true },
    { id: "s3", text: "text me", positive: true },
    { id: "s4", text: "See you Saturday.", positive: false },
  ],
  threads: [{ id: "t1", turns: [{ from: "a", text: "How do I reach you?" }, { from: "b", text: "same name, the photo app" }], positive: true }],
};
const SCORES: Record<string, number> = {
  "Tuesdays work.": 0.05,
  "Find me where the birds tweet.": 0.71,
  "text me": 0.97,
  "See you Saturday.": 0.12,
  "same name, the photo app": 0.66,
};

const POLICY = definePolicy({
  id: "contact_custom",
  question: "Does it share a way to get in touch?",
  counts: [{ id: "yes", text: "A way to get in touch." }],
  doesntCount: [{ id: "no", text: "Anything else." }],
  reason: "No contact details, please.",
});

let files: Map<string, string>;
let out: string[];
let err: string[];
let fetchMock: ReturnType<typeof vi.fn>;

function io(extra: Partial<CliIo> = {}): CliIo {
  return {
    env: { TYPESAFE_API_KEY: "test-key" },
    fetch: fetchMock as unknown as typeof fetch,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => {
      files.set(path, text);
    },
    importPolicy: async () => POLICY,
    corpusDir: "/corpus",
    ...extra,
  };
}

beforeEach(() => {
  files = new Map([["/work/set.json", JSON.stringify(SET)]]);
  out = [];
  err = [];
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const latest = (body.state.latest?.text ?? body.state.conversation.at(-1).text) as string;
    const name = Object.keys(body.questions)[0]!;
    return new Response(
      JSON.stringify({ model: DEFAULT_JEV_MODEL, answers: { [name]: { type: "noul", noul: SCORES[latest] } }, usage: { input_tokens: 500, output_tokens: 1 } }),
    );
  });
});

const ARGS = ["calibrate", "--policy", "./policy.mjs", "--samples", "/work/set.json", "--scores", "/work/scores.json"];

describe("calibrate", () => {
  it("scores every sample, keeps the scores by fingerprint, and prints the tables and a suggestion", async () => {
    expect(await run(ARGS, io())).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const kept = JSON.parse(files.get("/work/scores.json")!);
    const fingerprint = policyFingerprint(POLICY, DEFAULT_JEV_MODEL);
    expect(Object.keys(kept)).toEqual([fingerprint]);
    expect(kept[fingerprint]).toMatchObject({ policy: "contact_custom", label: "contact_custom", model: DEFAULT_JEV_MODEL, shape: 1 });
    expect(kept[fingerprint].scores).toEqual({ s1: 0.05, s2: 0.71, s3: 0.97, s4: 0.12, t1: 0.66 });
    const text = out.join("\n");
    expect(text).toContain("5 items, 0 already scored, 5 to score on jev-1.13.0.");
    expect(text).toContain("Scored 5 (0 failed), 2500 input tokens");
    expect(text).toContain("Every item (5):");
    // "text me" is caught by the rules, so the suggestion reads the other four.
    expect(text).toContain("Only what reaches Jev in the chat (4):");
    expect(text).toContain("Suggested: block 0.13, review 0.13");
  });

  it("never pays twice: a second run scores nothing", async () => {
    await run(ARGS, io());
    fetchMock.mockClear();
    out = [];
    expect(await run(ARGS, io())).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out[0]).toBe("5 items, 5 already scored, 0 to score on jev-1.13.0.");
  });

  it("--report reprints the tables with no calls and no key", async () => {
    await run(ARGS, io());
    const first = out.slice(out.findIndex((l) => l.startsWith("contact_custom (")));
    fetchMock.mockClear();
    out = [];
    expect(await run([...ARGS, "--report"], io({ env: {} }))).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual(first);
  });

  it("refuses to score without a key", async () => {
    expect(await run(ARGS, io({ env: {} }))).toBe(1);
    expect(err).toEqual(["TYPESAFE_API_KEY is not set. Nothing scored."]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops at a failure every call would share, keeping what it scored", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 401 }));
    expect(await run(ARGS, io())).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toEqual(["Stopped: Jev refused the request (401)."]);
  });

  it("calibrates the built-in contact policy from the package's corpus by default, per scope", async () => {
    files.set("/corpus/contact.json", JSON.stringify({ samples: [{ id: "x1", text: "Tuesdays work.", cites: "logistics" }], threads: [] }));
    expect(await run(["calibrate", "--scope", "details-only"], io())).toBe(0);
    const kept = JSON.parse(files.get("/corpus/contact-scores.json")!);
    const fingerprint = policyFingerprint(contactLeak({ scope: "details-only" }), DEFAULT_JEV_MODEL);
    expect(kept[fingerprint]).toMatchObject({ policy: "contact", label: "details-only", scores: { x1: 0.05 } });
  });

  it("sends the shape asked for, under its own fingerprint", async () => {
    expect(await run([...ARGS, "--shape", "2"], io())).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(Object.keys(body.state)).toEqual(["earlier", "latest"]);
    const kept = JSON.parse(files.get("/work/scores.json")!);
    expect(Object.keys(kept)).toEqual([policyFingerprint(POLICY, DEFAULT_JEV_MODEL, 2)]);
  });

  it.each([
    [["calibrate", "--scope", "everywhere"], "--scope must be one of off-platform, details-only"],
    [["calibrate", "--policy", "./mine.mjs"], "a policy of your own needs --samples and --scores"],
    [["calibrate", "--shape", "7", "--samples", "/work/set.json", "--scores", "/s.json"], "--shape must be one of 1, 2"],
  ])("refuses %j", async (argv, message) => {
    expect(await run(argv, io())).toBe(2);
    expect(err).toEqual([message]);
  });
});

describe("schema", () => {
  it("prints the tables as SQL with the prefix given", async () => {
    expect(await run(["schema", "--prefix", "app_"], io())).toBe(0);
    expect(out.join("\n")).toContain("CREATE TABLE IF NOT EXISTS app_conversations");
  });
});

describe("help", () => {
  it("lists the commands, and fails on an unknown one", async () => {
    expect(await run([], io())).toBe(0);
    expect(out[0]).toMatch(/^chaperone-chat calibrate/);
    expect(await run(["frobnicate"], io())).toBe(2);
  });
});
