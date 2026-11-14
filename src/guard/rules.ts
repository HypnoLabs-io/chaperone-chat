/**
 * The rules: regular expressions over a normalized copy of the text, built once from the options. Synchronous and
 * pure, so they are also what the guard falls back to when another method fails.
 *
 * Two passes. The first runs on the normalized text (`./normalize.ts`) and its findings carry offsets into the
 * original. The second joins number words and spaced-out letters ("nine one seven…", "w h a t s a p p") and adds any
 * kind the first missed, without offsets.
 *
 * They catch the common ways, not every possible one: Jev reads what they pass.
 */
import { ChaperoneError } from "../errors";
import { assertBounded } from "./bounded";
import { alternation, keptMatches, literal, squash, type Detector } from "./detector";
import { appDetectors, type AppOptions } from "./detectors/apps";
import { NEVER, spelled, type CoreContext } from "./detectors/context";
import { emailDetectors } from "./detectors/email";
import { handleDetectors } from "./detectors/handle";
import { linkDetectors } from "./detectors/link";
import { phoneDetectors } from "./detectors/phone";
import { en } from "./locales/en";
import { es } from "./locales/es";
import type { Locale } from "./locales/types";
import { normalize, originalSpan } from "./normalize";
import { us } from "./regions/us";
import type { Region } from "./regions/types";
import { CONTACT_KINDS, isContactKind, type ContactKind, type Finding, type Scrubber } from "./types";

export const LOCALES = { en, es } as const;
export type LocaleName = keyof typeof LOCALES;
export const REGIONS = { us } as const;
export type RegionName = keyof typeof REGIONS;

const TLD_EMAIL = ["com", "net", "org", "edu", "gov", "io", "co", "me", "us", "info", "biz"];
const TLD_LINK = [
  "com", "net", "org", "edu", "gov", "io", "co", "me", "ly", "info", "biz", "app", "page", "site", "online", "ai",
  "gg", "tv", "xyz", "ee", "link", "bio", "ca", "uk", "us",
];
const TLD_SPELLED = ["com", "net", "org", "edu", "io", "co", "me", "info", "biz", "app", "site", "ly"];

/** A detector of your own, run with the built-in ones. */
export interface CustomDetector {
  kind: ContactKind;
  /** Runs over the normalized text (see the docs). Gets the "g" flag if it lacks it. Every quantifier must be bounded. */
  pattern: RegExp;
  /** A further check on each match; false skips it. */
  keep?: (match: RegExpMatchArray) => boolean;
}

export interface RulesOptions {
  /** Each kind on (the default) or off. */
  kinds?: Partial<Record<ContactKind, boolean>>;
  /** The languages whose number words, spellings and asks are read. Default `["en", "es"]`. */
  locales?: readonly (LocaleName | Locale)[];
  /** Local phone and address formats. Default `"us"`; `null` for none. */
  region?: RegionName | Region | null;
  apps?: AppOptions;
  domains?: {
    /** The host's own domains: a link to one of them, or a subdomain of it, passes ("example.com"). */
    allow?: readonly string[];
    /** More top-level domains a bare domain may end in ("dev", "shop"). */
    extraTlds?: readonly string[];
  };
  streets?: {
    /** Street names written without a suffix, read after a house number ("1600 Broadway"). */
    named?: readonly string[];
  };
  /** The host's own names: "off Acme" asks to move off it, like "off the app". */
  platformNames?: readonly string[];
  custom?: readonly CustomDetector[];
}

export interface FindOptions {
  /** A phone counts only with its area code (the split-message pass). */
  fullPhonesOnly?: boolean;
}

/** The rules as a method: `find` is synchronous. */
export interface Rules extends Scrubber {
  readonly id: "rules";
  find(text: string, options?: FindOptions): Finding[];
  /** Every pattern in use, for inspection. */
  readonly detectors: readonly Detector[];
}

function resolveLocales(list: readonly (LocaleName | Locale)[]): Locale[] {
  return list.map((l) => {
    if (typeof l !== "string") return l;
    const locale = (LOCALES as Record<string, Locale>)[l];
    if (!locale) throw new ChaperoneError("invalid_option", `unknown locale "${l}" (built in: en, es)`);
    return locale;
  });
}

function resolveRegion(region: RegionName | Region | null): Region | null {
  if (region === null || typeof region !== "string") return region;
  const found = (REGIONS as Record<string, Region>)[region];
  if (!found) throw new ChaperoneError("invalid_option", `unknown region "${region}" (built in: us)`);
  return found;
}

const tlds = (base: readonly string[], extra: readonly string[]) =>
  [...new Set([...base, ...extra.map((t) => t.trim().toLowerCase().replace(/^\./, "")).filter(Boolean)])]
    .map((t) => literal(t))
    .join("|");

const defaultFullPhone = (match: string) => match.trimStart().startsWith("+") || match.replace(/\D/g, "").length >= 10;

/**
 * Three or more single letters or digits in a row, each apart by one to three spaces, dots, dashes or underscores
 * ("9 1 7", "w.h.a.t.s"). Not commas, slashes or plus signs: lists, dates and sums use those.
 */
const SPACED_SINGLES = /(?<![\p{L}\p{N}])[\p{L}\p{N}](?:[\s._\-*·•|~]{1,3}[\p{L}\p{N}](?![\p{L}\p{N}])){2,400}/gu;

export function createRules(options: RulesOptions = {}): Rules {
  const on = (kind: ContactKind) => options.kinds?.[kind] !== false;
  const locales = resolveLocales(options.locales ?? ["en", "es"]);
  const region = resolveRegion(options.region === undefined ? "us" : options.region);

  const dotWords = locales.flatMap((l) => l.dotWords ?? []);
  const allow = (options.domains?.allow ?? []).map((d) => d.trim().toLowerCase().replace(/^\.|\.$/g, "")).filter(Boolean);
  const extraTlds = options.domains?.extraTlds ?? [];
  const ctx: CoreContext = {
    spelledAt: spelled(locales.flatMap((l) => l.atWords ?? [])),
    spelledDot: spelled(dotWords),
    dotWord: dotWords.length ? new RegExp(String.raw`\b(?:${dotWords.join("|")})\b`, "gi") : new RegExp(NEVER, "g"),
    tldEmail: tlds(TLD_EMAIL, extraTlds),
    tldLink: tlds(TLD_LINK, extraTlds),
    tldSpelled: tlds(TLD_SPELLED, extraTlds),
    allowHost: (host) => allow.some((d) => host === d || host.endsWith(`.${d}`)),
  };

  // Names that pass wherever they appear: an app, or an ask naming one ("Venmo me").
  const allowedApps = (options.apps?.allow ?? []).map(squash).filter(Boolean);
  const notAllowedApp = (m: RegExpMatchArray) => {
    const text = squash(m[0]);
    return !allowedApps.some((name) => text.includes(name));
  };
  const withAppAllow = (d: Detector): Detector =>
    allowedApps.length === 0 ? d : { ...d, keep: (m) => (d.keep ? d.keep(m) : true) && notAllowedApp(m) };

  const platformNames = alternation(options.platformNames ?? []);
  const named = alternation(options.streets?.named ?? []);

  const all: Detector[] = [
    ...emailDetectors(ctx),
    ...phoneDetectors(),
    ...(region?.detectors ?? []),
    ...linkDetectors(ctx),
    ...handleDetectors(),
    ...(named
      ? [{ kind: "address" as const, re: new RegExp(String.raw`\b\d{1,5}(?:-\d{1,4})?\s{1,3}(?:${named})\b`, "gi") }]
      : []),
    ...appDetectors(options.apps).map(withAppAllow),
    ...locales.flatMap((l) => (l.asks?.({ platformNames }) ?? []).map((re) => withAppAllow({ kind: "ask", re }))),
    ...(options.custom ?? []).map((c, i): Detector => {
      if (!isContactKind(c.kind)) throw new ChaperoneError("invalid_option", `custom detector ${i}: unknown kind "${String(c.kind)}"`);
      if (!(c.pattern instanceof RegExp)) throw new ChaperoneError("invalid_option", `custom detector ${i}: pattern must be a RegExp`);
      const flags = c.pattern.flags.replace(/[gy]/g, "");
      return { kind: c.kind, re: new RegExp(c.pattern.source, `${flags}g`), keep: c.keep };
    }),
  ];
  const detectors = all.filter((d) => on(d.kind));
  detectors.forEach((d, i) => assertBounded(d.re, `detector ${i} (${d.kind})`));

  const isFullPhone = region?.isFullPhone ?? defaultFullPhone;

  // The second pass's rewrites.
  const digitWords: Record<string, string> = Object.assign({}, ...locales.map((l) => l.digitWords ?? {}));
  const digitWord = Object.keys(digitWords).length
    ? new RegExp(String.raw`\b(?:${Object.keys(digitWords).join("|")})\b`, "gi")
    : null;
  const zeroWords = locales.flatMap((l) => l.zeroWords ?? []);
  const zero = zeroWords.length
    ? new RegExp(String.raw`(?<=\d[\s.\-]{1,3})(?:${zeroWords.join("|")})(?=[\s.\-]{1,3}\d)`, "gi")
    : null;
  const joinedCopy = (text: string) => {
    let out = text;
    if (digitWord) out = out.replace(digitWord, (w) => digitWords[w.toLowerCase()] ?? w);
    if (zero) out = out.replace(zero, "0");
    return out.replace(SPACED_SINGLES, (run) => run.replace(/[^\p{L}\p{N}]/gu, ""));
  };

  function scan(text: string, fullPhonesOnly: boolean): { kind: ContactKind; start: number; end: number }[] {
    const hits: { kind: ContactKind; start: number; end: number }[] = [];
    for (const d of detectors) {
      for (const m of keptMatches(d, text)) {
        if (fullPhonesOnly && d.kind === "phone" && !isFullPhone(m[0])) continue;
        const start = m.index ?? 0;
        hits.push({ kind: d.kind, start, end: start + m[0].length });
      }
    }
    return hits;
  }

  function find(text: string, findOptions: FindOptions = {}): Finding[] {
    if (!text) return [];
    const fullPhonesOnly = findOptions.fullPhonesOnly ?? false;
    const { text: scanText, map } = normalize(text);
    const hits = scan(scanText, fullPhonesOnly);
    const findings: Finding[] = hits.map((h) =>
      map ? { kind: h.kind, ...originalSpan(map, h.start, h.end) } : { kind: h.kind },
    );
    const found = new Set(hits.map((h) => h.kind));
    const joined = joinedCopy(scanText);
    if (joined !== scanText) {
      for (const h of scan(joined, fullPhonesOnly)) {
        if (found.has(h.kind)) continue;
        found.add(h.kind);
        findings.push({ kind: h.kind });
      }
    }
    return findings;
  }

  return { id: "rules", detectors, find };
}

/** The kinds in some findings, most specific first. */
export function kindsOf(findings: readonly Finding[]): ContactKind[] {
  const found = new Set(findings.map((f) => f.kind));
  return CONTACT_KINDS.filter((k) => found.has(k));
}
