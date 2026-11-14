/**
 * Every pattern the rules run has bounded quantifiers: `*`, `+` and `{n,}` are refused, so a long, hostile input
 * can't make a pattern backtrack for long. The built-in patterns are held to it by a test, and a custom detector is
 * checked when the rules are built.
 */
import { ChaperoneError } from "../errors";

const OPEN_RANGE = /^\{\d+,\}/;

/** True when the pattern holds `*`, `+` or `{n,}` outside a character class (escapes and lazy forms included). */
export function hasUnboundedQuantifier(pattern: RegExp | string): boolean {
  const source = typeof pattern === "string" ? pattern : pattern.source;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++; // the escaped character is a literal (or a class like \d), never a quantifier
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "*" || c === "+") return true;
    if (c === "{" && OPEN_RANGE.test(source.slice(i))) return true;
  }
  return false;
}

/** Throws `unbounded_pattern` for a pattern `hasUnboundedQuantifier` refuses. */
export function assertBounded(pattern: RegExp, label: string): void {
  if (hasUnboundedQuantifier(pattern)) {
    throw new ChaperoneError(
      "unbounded_pattern",
      `${label} has an unbounded quantifier (*, + or {n,}); give every repeat a ceiling, e.g. \\s{1,3} or {2,40}`,
    );
  }
}
