/**
 * The text the rules read: invisible characters dropped, NFKC applied (fullwidth "＠" and "９" become "@" and "9"),
 * every run of whitespace folded to one space, and Cyrillic and Greek lookalikes folded to Latin. Each character of
 * the result maps back to its offset in the original, so a finding can name the span a sender typed.
 */

/** Characters that render as nothing (soft hyphen, zero-width, bidi marks, variation selectors) and the keycap frame ("9️⃣"). */
const INVISIBLE_CLASS =
  "[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u20E3\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0]";
const INVISIBLE = new RegExp(INVISIBLE_CLASS, "g");
const IS_INVISIBLE = new RegExp(`^${INVISIBLE_CLASS}$`);
const IS_SPACE = /\s/;
const SPACE_RUNS = /\s+/g;

/** Cyrillic and Greek letters that look Latin. One code unit each, so offsets hold. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", ɡ: "g", ο: "o", α: "a", ν: "v", ι: "i", κ: "k",
  ρ: "p", τ: "t", υ: "u", χ: "x",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X",
  І: "I", Ј: "J", Ѕ: "S", Ο: "O", Α: "A", Β: "B", Ε: "E", Η: "H", Ι: "I", Κ: "K", Μ: "M",
  Ν: "N", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", Ζ: "Z",
};
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");

export interface Normalized {
  /** What the rules scan. */
  text: string;
  /**
   * For each character of `text`, its offset in the original; `map[text.length]` is the original's length. Null when
   * a character-by-character pass disagrees with NFKC of the whole string (a combining sequence that composes, as in
   * "café"): findings then carry no offsets.
   */
  map: number[] | null;
}

function fold(text: string): string {
  return text.replace(LOOKALIKE, (c) => LOOKALIKES[c] ?? c);
}

export function normalize(text: string): Normalized {
  let out = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
    const norm = IS_INVISIBLE.test(ch) ? "" : ch.normalize("NFKC");
    for (const c of norm) {
      const space = IS_SPACE.test(c);
      if (space && lastSpace) continue;
      const emitted = space ? " " : c;
      out += emitted;
      lastSpace = space;
      for (let k = 0; k < emitted.length; k++) map.push(i);
    }
    i += ch.length;
  }
  map.push(text.length);
  const whole = text.normalize("NFKC").replace(INVISIBLE, "").replace(SPACE_RUNS, " ");
  return whole === out ? { text: fold(out), map } : { text: fold(whole), map: null };
}

/** `[start, end)` in the normalized text, as the same span of the original. */
export function originalSpan(map: readonly number[], start: number, end: number): { start: number; end: number } {
  let j = end;
  // A character NFKC expanded ("ﬁ" → "fi") is cut whole.
  while (j < map.length - 1 && map[j] === map[end - 1]) j++;
  return { start: map[start] as number, end: map[j] as number };
}
