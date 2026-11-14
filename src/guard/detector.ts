/**
 * A detector is one pattern of one kind, with an optional check on each match. The rules are a list of them, built
 * from the options (`./rules.ts`): the core patterns, the locales' and the region's.
 */
import type { ContactKind } from "./types";

export interface Detector {
  readonly kind: ContactKind;
  /** Global. Runs over the normalized text. Every quantifier bounded. */
  readonly re: RegExp;
  /** A further check on a match; false skips it, and the scan moves on one character. */
  readonly keep?: (match: RegExpMatchArray) => boolean;
}

/** A detector's matches, minus the ones its `keep` refuses (the scan then restarts one character on). */
export function* keptMatches(d: Detector, text: string): Generator<RegExpMatchArray> {
  let from = 0;
  while (from <= text.length) {
    // `matchAll` starts from the pattern's `lastIndex`.
    d.re.lastIndex = from;
    let refusedAt = -1;
    for (const m of text.matchAll(d.re)) {
      if (d.keep && !d.keep(m)) {
        refusedAt = m.index ?? 0;
        break;
      }
      yield m;
    }
    if (refusedAt < 0) return;
    from = refusedAt + 1;
  }
}

/** A literal as a pattern: special characters escaped, any run of spaces matching one to three whitespace characters. */
export function literal(text: string): string {
  return text
    .trim()
    .replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")
    .replace(/\s+/g, String.raw`\s{1,3}`);
}

/** Several literals as one alternation, longest first so a longer name wins over its prefix. */
export function alternation(texts: readonly string[]): string {
  return [...new Set(texts.map((t) => t.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(literal)
    .join("|");
}

/** "1234567" or "9876543": someone counting, not a phone number. */
export function isCountingRun(digits: string): boolean {
  if (digits.length < 2) return false;
  const step = Number(digits[1]) - Number(digits[0]);
  if (step !== 1 && step !== -1) return false;
  for (let i = 2; i < digits.length; i++) {
    if (Number(digits[i]) - Number(digits[i - 1]) !== step) return false;
  }
  return true;
}

export const notCounting = (m: RegExpMatchArray): boolean => !isCountingRun(m[0].replace(/\D/g, ""));

/** Lowercased, with every whitespace run removed: how allow-lists compare. */
export const squash = (text: string): string => text.toLowerCase().replace(/\s/g, "");
