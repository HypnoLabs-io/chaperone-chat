/**
 * Running a method over a text, failing closed: a method that throws, rejects, returns a non-array or a kind outside
 * `CONTACT_KINDS` is replaced for that call by the rules (pure, can't fail), and the scan says so (`fellBack`).
 */
import { kindsOf, type Rules } from "./rules";
import { isContactKind, type ContactKind, type Finding, type Scrubber } from "./types";

/** What a method found, checked: known kinds only, spans kept only when they fit the text. */
export interface Scan {
  /** The kinds found, most specific first. */
  kinds: ContactKind[];
  findings: Finding[];
  /** The method that answered: the one asked, or `rules` when it failed. */
  scrubberId: string;
  fellBack: boolean;
}

function validSpan(f: Finding, length: number): boolean {
  return (
    Number.isInteger(f.start) &&
    Number.isInteger(f.end) &&
    (f.start as number) >= 0 &&
    (f.start as number) < (f.end as number) &&
    (f.end as number) <= length
  );
}

/** A method's answer, or null when it can't be trusted. */
function checkedFindings(raw: unknown, length: number): Finding[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Finding[] = [];
  for (const f of raw as Finding[]) {
    if (!f || !isContactKind(f.kind)) return null;
    // A span that doesn't fit is dropped, not trusted: the finding stays, and a cut blanks the field.
    out.push(validSpan(f, length) ? { kind: f.kind, start: f.start, end: f.end } : { kind: f.kind });
  }
  return out;
}

/** Run `scrubber` over `text`, falling back to `rules` when it fails. */
export async function scanWith(scrubber: Scrubber, rules: Rules, text: string): Promise<Scan> {
  if (!text) return { kinds: [], findings: [], scrubberId: scrubber.id, fellBack: false };
  let findings: Finding[] | null = null;
  try {
    findings = checkedFindings(await scrubber.find(text), text.length);
  } catch {
    findings = null;
  }
  if (findings) return { kinds: kindsOf(findings), findings, scrubberId: scrubber.id, fellBack: false };
  const fallback = rules.find(text);
  return { kinds: kindsOf(fallback), findings: fallback, scrubberId: rules.id, fellBack: true };
}

/**
 * Several methods as one: every finding from each. A member that throws fails the whole (so the guard falls back to
 * the rules), never quietly drops out.
 */
export function combine(id: string, scrubbers: readonly Scrubber[]): Scrubber {
  return {
    id,
    async find(text) {
      const all = await Promise.all(scrubbers.map((s) => s.find(text)));
      return all.flat();
    },
  };
}
