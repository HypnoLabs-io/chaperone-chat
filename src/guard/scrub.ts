/**
 * Cutting contact details out of a field shown to others (a profile, a listing): every sentence that holds one is
 * cut. A chat message is never cut, only refused whole.
 */
import type { Scan } from "./scan";

/** A sentence ends at a line break, or at . ! ? before a space or the end ("sam.g@…" doesn't end one). */
function endsSentence(text: string, i: number): boolean {
  const c = text[i];
  return c === "\n" || ((c === "." || c === "!" || c === "?") && (i + 1 >= text.length || /\s/.test(text[i + 1] ?? "")));
}

/** `[start, end)` grown to the sentence around it, its closing mark included. */
function sentenceAround(text: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0 && !endsSentence(text, a - 1)) a--;
  let b = end;
  while (b < text.length && !endsSentence(text, b)) b++;
  return [a, Math.min(text.length, b + 1)];
}

/** Spaces and stray punctuation left where a sentence was cut. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?)])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s.,;:!?-]+|[\s,;:-]+$/g, "")
    .trim();
}

/**
 * `text` with every sentence that holds a contact detail cut out ("Six years in sales. Email me at …" → "Six years in
 * sales."). Clean text comes back untouched. A finding with no span, or a cut that leaves something that still trips,
 * blanks the whole field. Idempotent for a deterministic method, and what it returns never trips the method that made
 * it.
 */
export async function scrubWith(scan: (text: string) => Promise<Scan>, text: string): Promise<string> {
  if (!text) return text;
  const first = await scan(text);
  if (first.findings.length === 0) return text;
  if (first.findings.some((f) => f.start === undefined)) return "";

  const cuts = first.findings
    .map((f) => sentenceAround(text, f.start as number, f.end as number))
    .sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [s, e] of cuts) {
    if (e <= at) continue;
    out += text.slice(at, Math.max(at, s));
    at = Math.max(at, e);
  }
  out += text.slice(at);
  const kept = tidy(out);
  if (!kept) return "";
  return (await scan(kept)).findings.length === 0 ? kept : "";
}
