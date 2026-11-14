/** What the core detectors are built from: the locales' spellings, the TLDs and the allowed domains. */
export interface CoreContext {
  /** "at" spelled out between two parts of an email ("jsmith at gmail", "jsmith [at] gmail"). */
  readonly spelledAt: string;
  /** "dot" spelled out ("gmail dot com", "gmail (dot) com"). */
  readonly spelledDot: string;
  /** Matches a spelled-out dot word alone ("dot", "punto"); global and case-insensitive. */
  readonly dotWord: RegExp;
  /** TLDs an email's spelled-out form must end in. */
  readonly tldEmail: string;
  /** TLDs a bare domain must end in ("example.com"). */
  readonly tldLink: string;
  /** TLDs a domain with its dot spelled out must end in ("example dot com"). */
  readonly tldSpelled: string;
  /** The host's own domains: a link to one of them passes. */
  allowHost(host: string): boolean;
}

/** A pattern that never matches, for a spelling no locale supplies. */
export const NEVER = "(?!)";

/** Words as a spelled-out separator: inside brackets, or between spaces. */
export function spelled(words: readonly string[]): string {
  if (words.length === 0) return NEVER;
  const w = words.join("|");
  return String.raw`(?:\s{0,3}[\[({<]\s{0,3}(?:${w})\s{0,3}[\])}>]\s{0,3}|\s{1,3}(?:${w})\s{1,3})`;
}

/** The domain a link match names, lowercased, without scheme, "www.", port or path. */
export function hostOf(match: string, dotWord: RegExp): string {
  const host = match
    .toLowerCase()
    .replace(dotWord, ".")
    .replace(/\s/g, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  return host.split(/[/?#:]/)[0] ?? "";
}
