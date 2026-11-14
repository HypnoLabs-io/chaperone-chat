/**
 * The command line's work, with everything outside passed in (the environment, files, fetch, output), so it runs the
 * same in a test as from `npx chaperone-chat`.
 *
 *   chaperone-chat calibrate [--policy contact|<module>] [--scope off-platform|details-only] [--samples <file>]
 *                            [--scores <file>] [--report] [--model <id>] [--base-url <url>] [--shape 1|2] [--max-calls <n>]
 *   chaperone-chat schema [--prefix chat_]
 */
import { contactLeak } from "../guard/policies/contact-leak";
import { CONTACT_SCOPES, type ContactScope } from "../guard/policies/contact-lines";
import { STATE_SHAPES, STATE_VERSION, type Policy, type StateShape } from "../guard/policy";
import { calibrationItems, calibrationReport, entryFor, scoreMissing, type LabelledSet, type ScoresFile } from "../jev/calibrate";
import { createJevClient, DEFAULT_JEV_MODEL } from "../jev/client";
import { schemaSql } from "../postgres/schema";

export interface CliIo {
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  out(line: string): void;
  err(line: string): void;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** The policy a module exports (its default export, or `policy`). */
  importPolicy(path: string): Promise<unknown>;
  /** Where the package's own corpus lives. */
  corpusDir: string;
}

const HELP = [
  "chaperone-chat calibrate   score labelled samples with Jev and suggest a policy's cutoffs",
  "  --policy contact|<module>   the built-in contact policy (default) or a module exporting yours",
  "  --scope off-platform|details-only   the contact policy's scope (default off-platform)",
  "  --samples <file>            labelled samples (default: the package's corpus for the contact policy)",
  "  --scores <file>             where scores are kept (default: next to the package's corpus)",
  "  --report                    print the tables from the scores already kept; no calls",
  "  --model <id>                the Jev model (default jev-1.13.0)",
  "  --base-url <url>            Jev's address",
  "  --shape 1|2                 the state shape to send (default the one the chat uses)",
  "  --max-calls <n>             stop after this many calls (default 2000)",
  "  The key is read from TYPESAFE_API_KEY.",
  "",
  "chaperone-chat schema      print the Postgres tables as SQL",
  "  --prefix <prefix>           the table prefix (default chat_)",
];

/** Approximate input price TypeSafe quotes, per million tokens, for the run's cost line. */
const PRICE_PER_MILLION_INPUT = 0.042;

function parse(argv: readonly string[]): { command: string | undefined; flags: Map<string, string | true> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) continue;
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { command, flags };
}

function isPolicy(value: unknown): value is Policy {
  const v = value as Policy;
  return !!v && typeof v.id === "string" && typeof v.question === "string" && Array.isArray(v.counts) && Array.isArray(v.doesntCount);
}

async function calibrate(flags: Map<string, string | true>, io: CliIo): Promise<number> {
  const str = (name: string) => {
    const v = flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const policyArg = str("policy") ?? "contact";
  const builtIn = policyArg === "contact";
  const scope = (str("scope") ?? "off-platform") as ContactScope;
  if (builtIn && !CONTACT_SCOPES.includes(scope)) {
    io.err(`--scope must be one of ${CONTACT_SCOPES.join(", ")}`);
    return 2;
  }
  let policy: Policy;
  if (builtIn) {
    policy = contactLeak({ scope });
  } else {
    const loaded = await io.importPolicy(policyArg);
    if (!isPolicy(loaded)) {
      io.err(`${policyArg} doesn't export a policy (export default definePolicy({ ... }))`);
      return 2;
    }
    policy = loaded;
  }
  const samplesPath = str("samples") ?? (builtIn ? `${io.corpusDir}/contact.json` : undefined);
  const scoresPath = str("scores") ?? (builtIn ? `${io.corpusDir}/contact-scores.json` : undefined);
  if (!samplesPath || !scoresPath) {
    io.err("a policy of your own needs --samples and --scores");
    return 2;
  }
  const shape = Number(str("shape") ?? STATE_VERSION) as StateShape;
  if (!STATE_SHAPES.includes(shape)) {
    io.err(`--shape must be one of ${STATE_SHAPES.join(", ")}`);
    return 2;
  }
  const model = str("model") ?? DEFAULT_JEV_MODEL;
  const maxCalls = Number(str("max-calls") ?? 2_000);

  const samplesText = await io.read(samplesPath);
  if (samplesText === null) {
    io.err(`no samples at ${samplesPath}`);
    return 2;
  }
  const items = calibrationItems(JSON.parse(samplesText) as LabelledSet, policy);
  const scoresText = await io.read(scoresPath);
  const file: ScoresFile = scoresText ? (JSON.parse(scoresText) as ScoresFile) : {};
  const entry = entryFor(file, policy, model, builtIn ? scope : policy.id, shape);
  const save = () => {
    const sorted: ScoresFile = {};
    for (const key of Object.keys(file).sort()) {
      const e = file[key]!;
      sorted[key] = { ...e, scores: Object.fromEntries(Object.entries(e.scores).sort(([a], [b]) => a.localeCompare(b))) };
    }
    return io.write(scoresPath, `${JSON.stringify(sorted, null, 2)}\n`);
  };

  let stopped: string | undefined;
  if (!flags.has("report")) {
    const todo = items.filter((i) => entry.scores[i.id] === undefined).length;
    io.out(`${items.length} items, ${items.length - todo} already scored, ${todo} to score on ${model}.`);
    if (todo > 0) {
      const apiKey = io.env.TYPESAFE_API_KEY?.trim();
      if (!apiKey) {
        io.err("TYPESAFE_API_KEY is not set. Nothing scored.");
        return 1;
      }
      const client = createJevClient({ apiKey, model, baseUrl: str("base-url"), fetch: io.fetch });
      const run = await scoreMissing({ items, policy, client, entry, maxCalls, save, log: io.out });
      const dollars = (run.inputTokens / 1e6) * PRICE_PER_MILLION_INPUT;
      io.out(`Scored ${run.calls} (${run.failed} failed), ${run.inputTokens} input tokens, about $${dollars.toFixed(4)} at the quoted price.`);
      stopped = run.stopped;
      if (stopped) io.err(`Stopped: ${stopped}.`);
    }
  }
  for (const line of calibrationReport(items, entry, policy)) io.out(line);
  if (stopped) return 1;
  return items.some((i) => entry.scores[i.id] === undefined) ? 1 : 0;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const { command, flags } = parse(argv);
  try {
    if (command === "calibrate") return await calibrate(flags, io);
    if (command === "schema") {
      const prefix = flags.get("prefix");
      io.out(schemaSql(typeof prefix === "string" ? prefix : undefined));
      return 0;
    }
    for (const line of HELP) io.out(line);
    return command === undefined || command === "help" || flags.has("help") ? 0 : 2;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
