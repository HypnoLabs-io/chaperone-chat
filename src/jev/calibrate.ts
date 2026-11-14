/**
 * Calibrating a policy: score labelled samples with Jev, keep the scores, and read them back as the tables a person
 * picks cutoffs from. No file system and no environment here: the command line (`npx chaperone-chat calibrate`)
 * reads and writes the files.
 *
 * Every item is scored, the ones the rules catch too, so Jev's own separation shows; the report reads the ones that
 * reach Jev in the chat. Only missing ids are scored; the scores are kept by the question's fingerprint, so a
 * changed question or model starts afresh and nothing already paid for is scored twice.
 */
import { DEFAULT_CONTEXT_TURNS } from "../guard/check";
import { createGuard, type Guard } from "../guard/guard";
import {
  jevQuestionOf,
  jevState,
  platformSwapper,
  policyFingerprint,
  STATE_VERSION,
  type JudgeTurn,
  type Policy,
  type StateShape,
} from "../guard/policy";
import { DEFAULT_WINDOW } from "../guard/window";
import { bandMisses, reliabilityTable, suggestCutoffs, type ScoredItem } from "./calibration";
import { isJevError, type JevClient } from "./client";
import { ChaperoneError } from "../errors";

export interface LabelledSample {
  id: string;
  text: string;
  /** The label, or `cites`: a line of the policy (counted when it is one of `counts`). */
  positive?: boolean;
  cites?: string;
}

export interface LabelledThread {
  id: string;
  /** Oldest first; the last is judged. `from` names who wrote it (any string). */
  turns: readonly { from: string; text: string }[];
  positive?: boolean;
  cites?: string;
}

export interface LabelledSet {
  samples?: readonly LabelledSample[];
  threads?: readonly LabelledThread[];
}

export interface CalibrationItem extends ScoredItemBase {
  turns: JudgeTurn[];
  /** The judged text, for a report's list of misses. */
  text: string;
}

interface ScoredItemBase {
  id: string;
  positive: boolean;
  reachesJudge: boolean;
}

/** One question's scores. */
export interface ScoresEntry {
  policy: string;
  /** What these scores are of ("off-platform", "details-only", or the policy's id). */
  label: string;
  model: string;
  shape: number;
  fingerprint: string;
  scores: Record<string, number>;
}

/** Every question's scores, by fingerprint. */
export type ScoresFile = Record<string, ScoresEntry>;

function labelOf(item: { id: string; positive?: boolean; cites?: string }, policy: Policy): boolean {
  if (typeof item.positive === "boolean") return item.positive;
  const counts = new Set(policy.counts.map((l) => l.id));
  const doesnt = new Set(policy.doesntCount.map((l) => l.id));
  if (item.cites && counts.has(item.cites)) return true;
  if (item.cites && doesnt.has(item.cites)) return false;
  throw new ChaperoneError("invalid_input", `sample ${item.id}: give it "positive" or cite one of the policy's lines`);
}

/**
 * The items a set holds for a policy, read as the chat reads them: a single message as the whole thread, a thread's
 * last message after its earlier ones (the last `contextTurns`), from the last sender's side. `reachesJudge` runs
 * the rules (with the policy's rule kinds) and the split-message pass.
 */
export function calibrationItems(
  set: LabelledSet,
  policy: Policy,
  options: { guard?: Guard; contextTurns?: number; maxEarlier?: number } = {},
): CalibrationItem[] {
  const guard = options.guard ?? createGuard({ kinds: { ...policy.ruleKinds } });
  const contextTurns = options.contextTurns ?? DEFAULT_CONTEXT_TURNS;
  const maxEarlier = options.maxEarlier ?? DEFAULT_WINDOW.maxEarlier;
  const singles = (set.samples ?? []).map((s) => ({
    id: s.id,
    positive: labelOf(s, policy),
    reachesJudge: guard.rules.find(s.text).length === 0,
    turns: [{ sender: true, text: s.text }],
    text: s.text,
  }));
  const threads = (set.threads ?? []).map((t) => {
    const last = t.turns[t.turns.length - 1];
    if (!last) throw new ChaperoneError("invalid_input", `thread ${t.id} has no turns`);
    const before = t.turns.slice(0, -1);
    const earlier = before.filter((x) => x.from === last.from).map((x) => x.text);
    return {
      id: t.id,
      positive: labelOf(t, policy),
      reachesJudge: guard.rules.find(last.text).length === 0 && guard.windowKinds(earlier, last.text, maxEarlier).length === 0,
      turns: [...(contextTurns > 0 ? before.slice(-contextTurns) : []), last].map((x) => ({ sender: x.from === last.from, text: x.text })),
      text: t.turns.map((x) => `${x.from}: ${x.text}`).join(" / "),
    };
  });
  const all = [...singles, ...threads];
  const ids = all.map((i) => i.id);
  if (new Set(ids).size !== ids.length) throw new ChaperoneError("invalid_input", "two samples share an id");
  return all;
}

/** The entry for this policy, model and shape, made empty when there is none yet. */
export function entryFor(file: ScoresFile, policy: Policy, model: string, label: string, shape: StateShape = STATE_VERSION): ScoresEntry {
  const fingerprint = policyFingerprint(policy, model, shape);
  file[fingerprint] ??= { policy: policy.id, label, model, shape, fingerprint, scores: {} };
  return file[fingerprint] as ScoresEntry;
}

export interface ScoreRun {
  calls: number;
  failed: number;
  inputTokens: number;
  /** Set when a failure every later call would share stopped the run. */
  stopped?: string;
}

/** A failure every later call would share: stop rather than fail hundreds of times. */
function fatal(error: unknown): string | null {
  if (!isJevError(error)) return null;
  if (error.failure === "no_key") return "no API key";
  if (error.failure === "model_mismatch") return `another model answered (${error.answeredModel ?? "unknown"})`;
  if (error.failure === "http" && [400, 401, 403, 404, 422].includes(error.status ?? 0)) return `Jev refused the request (${error.status})`;
  return null;
}

/** Scores the items `entry` has no score for, up to `maxCalls`, saving as it goes. */
export async function scoreMissing(input: {
  items: readonly CalibrationItem[];
  policy: Policy;
  client: JevClient;
  entry: ScoresEntry;
  platformNames?: readonly string[];
  maxCalls?: number;
  saveEvery?: number;
  save: () => Promise<void> | void;
  log?: (line: string) => void;
}): Promise<ScoreRun> {
  const { entry, client, policy } = input;
  const swap = platformSwapper(input.platformNames);
  const question = { [policy.id]: jevQuestionOf(policy) };
  const todo = input.items.filter((i) => entry.scores[i.id] === undefined).slice(0, input.maxCalls ?? Infinity);
  const run: ScoreRun = { calls: 0, failed: 0, inputTokens: 0 };
  for (const item of todo) {
    try {
      const answer = await client.ask({ state: jevState(item.turns, swap, entry.shape as StateShape), questions: question });
      entry.scores[item.id] = answer.p[policy.id] as number;
      run.inputTokens += answer.usage?.inputTokens ?? 0;
      run.calls++;
      if (run.calls % (input.saveEvery ?? 20) === 0) {
        await input.save();
        input.log?.(`  ${run.calls}/${todo.length}`);
      }
    } catch (error) {
      run.failed++;
      const stop = fatal(error);
      input.log?.(`  ${item.id}: ${isJevError(error) ? error.message : "error"}`);
      if (stop) {
        run.stopped = stop;
        break;
      }
    }
  }
  await input.save();
  return run;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function table(title: string, items: readonly ScoredItem[]): string[] {
  const lines = [title, "  band        items  positive  share positive"];
  for (const row of reliabilityTable(items)) {
    const band = `${row.from.toFixed(1)}-${row.to.toFixed(1)}`;
    const share = row.count ? pct(row.positive / row.count) : "-";
    lines.push(`  ${band.padEnd(10)} ${String(row.count).padStart(6)} ${String(row.positive).padStart(9)}  ${share.padStart(14)}`);
  }
  return lines;
}

function misses(label: string, list: readonly ScoredItem[], text: ReadonlyMap<string, string>): string[] {
  return [
    `  ${label}: ${list.length}`,
    ...[...list].sort((a, b) => b.p - a.p).map((i) => `    ${i.p.toFixed(3)}  ${i.id}  ${JSON.stringify(text.get(i.id))}`),
  ];
}

/** The report a person picks cutoffs from. */
export function calibrationReport(items: readonly CalibrationItem[], entry: ScoresEntry, policy: Policy): string[] {
  const text = new Map(items.map((i) => [i.id, i.text]));
  const scored: ScoredItem[] = items
    .filter((i) => entry.scores[i.id] !== undefined)
    .map((i) => ({ id: i.id, positive: i.positive, reachesJudge: i.reachesJudge, p: entry.scores[i.id] as number }));
  const judged = scored.filter((i) => i.reachesJudge);
  const lines = [
    `${policy.id} (${entry.label}) on ${entry.model}, state shape ${entry.shape}, fingerprint ${entry.fingerprint}`,
    "",
    ...table(`Every item (${scored.length}):`, scored),
    "",
    ...table(`Only what reaches Jev in the chat (${judged.length}):`, judged),
  ];
  const c = policy.cutoffs;
  if (c && c.fingerprint === entry.fingerprint && c.model === entry.model) {
    const now = bandMisses(scored, c);
    lines.push(
      "",
      `At the policy's cutoffs (block ${c.block}, review ${c.review}):`,
      ...misses("clean, refused outright", now.cleanBlocked, text),
      ...misses("clean, refused with an appeal", now.cleanAppeal, text),
      ...misses("positive the rules miss, sent", now.positiveSent, text),
    );
  }
  const s = suggestCutoffs(scored);
  lines.push(
    "",
    `Suggested: block ${s.block}, review ${s.review}`,
    `  clean items in the appeal band: ${pct(s.appealShare)}`,
    `  clean items at or above the lowest positive miss: ${s.overlap}`,
    ...misses("positive the rules miss, under the suggested review", judged.filter((i) => s.knownMisses.includes(i.id)), text),
  );
  const missing = items.length - scored.length;
  if (missing) lines.push("", `${missing} items have no score yet: run without --report.`);
  return lines;
}
