/**
 * The sample corpus (`corpus/contact.json`) as the tests read it. Every sample cites a line of the contact policy's
 * definition, which says whether it is a contact detail under each scope; `rules` pins every kind the default rules
 * find in it, so a sample is blocked, a rules miss (Jev's to catch), clean, or an overreach. Threads pin what the
 * split-message pass answers on their last message.
 */
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { contactLines, type ContactScope } from "../../src/guard/policies/contact-lines";
import type { ContactKind } from "../../src/guard/types";
import type { WindowKind } from "../../src/guard/window";

export interface CorpusSample {
  readonly id: string;
  readonly domain: string;
  readonly cites: string;
  readonly text: string;
  /** Every kind the default rules find, most specific first; empty when they pass it. */
  readonly rules: readonly ContactKind[];
}

export interface CorpusThread {
  readonly id: string;
  readonly domain: string;
  readonly cites: string;
  /** Oldest first; the last is the message judged. */
  readonly turns: readonly { readonly from: string; readonly text: string }[];
  /** What the split-message pass refuses the last message for; null when it goes on to Jev. */
  readonly window: WindowKind | null;
}

export interface Corpus {
  readonly policy: string;
  readonly samples: readonly CorpusSample[];
  readonly threads: readonly CorpusThread[];
}

export const CORPUS: Corpus = JSON.parse(readFileSync(new URL("../../corpus/contact.json", import.meta.url), "utf8"));

/** Whether an item is a contact detail under a scope. */
export function isContact(item: { cites: string }, scope: ContactScope = "off-platform"): boolean {
  return contactLines(scope).counts.some((line) => line.id === item.cites);
}

/** Contact details the rules refuse, with the most specific kind: what every method must refuse. */
export const BLOCKED: readonly (readonly [string, ContactKind])[] = CORPUS.samples
  .filter((s) => isContact(s) && s.rules.length > 0)
  .map((s) => [s.text, s.rules[0] as ContactKind] as const);

/** Not contact details, and the rules pass them: what every method must pass. */
export const CLEAN: readonly string[] = CORPUS.samples.filter((s) => !isContact(s) && s.rules.length === 0).map((s) => s.text);

/** A message of one to six clean sentences. */
export const cleanMessage = fc
  .array(fc.constantFrom(...CLEAN), { minLength: 1, maxLength: 6 })
  .map((parts) => parts.join(" "));

/** A message mixing clean sentences with contact details. */
export const mixedMessage = fc
  .array(fc.oneof(fc.constantFrom(...CLEAN), fc.constantFrom(...BLOCKED.map(([text]) => text))), {
    minLength: 1,
    maxLength: 6,
  })
  .map((parts) => parts.join(" "));
