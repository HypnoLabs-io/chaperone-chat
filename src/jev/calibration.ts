/**
 * Reading Jev's scores on labelled items, whatever the policy: how the probabilities spread over the scale, what a
 * pair of cutoffs gets wrong, and the cutoffs the items suggest. Pure.
 */

export interface ScoredItem {
  id: string;
  /** The label: the policy counts it (a contact detail, for the contact policy). */
  positive: boolean;
  /** The rules (and the split-message pass) let it through, so Jev decides it in the chat. */
  reachesJudge: boolean;
  /** Jev's probability of yes. */
  p: number;
}

export interface ReliabilityRow {
  /** The tenth of the scale, `[from, to)`; the last row includes 1. */
  from: number;
  to: number;
  count: number;
  /** How many of them are labelled yes. */
  positive: number;
}

/** For each tenth of the scale: how many items landed there, and how many of them are labelled yes. */
export function reliabilityTable(items: readonly Pick<ScoredItem, "positive" | "p">[]): ReliabilityRow[] {
  const rows: ReliabilityRow[] = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, count: 0, positive: 0 }));
  for (const item of items) {
    const row = rows[Math.min(9, Math.max(0, Math.floor(item.p * 10)))] as ReliabilityRow;
    row.count++;
    if (item.positive) row.positive++;
  }
  return rows;
}

export interface BandMisses {
  /** Clean items Jev would refuse outright. */
  cleanBlocked: ScoredItem[];
  /** Clean items refused with an appeal. */
  cleanAppeal: ScoredItem[];
  /** Positive items the rules miss that Jev would send. */
  positiveSent: ScoredItem[];
}

/** What a pair of cutoffs gets wrong, among the items that reach Jev. */
export function bandMisses(items: readonly ScoredItem[], t: { block: number; review: number }): BandMisses {
  const judged = items.filter((i) => i.reachesJudge);
  return {
    cleanBlocked: judged.filter((i) => !i.positive && i.p >= t.block),
    cleanAppeal: judged.filter((i) => !i.positive && i.p >= t.review && i.p < t.block),
    positiveSent: judged.filter((i) => i.positive && i.p < t.review),
  };
}

export interface CutoffSuggestion {
  /** The lowest hundredth no clean item reaches. */
  block: number;
  /** The highest hundredth every positive miss still reaches, raised if needed to keep the appeal band small. */
  review: number;
  /** Share of the clean items that reach Jev landing in `[review, block)`. */
  appealShare: number;
  /** Positive items the rules miss that score under `review`: what would get through. */
  knownMisses: string[];
  /** Clean items scoring at or above the lowest-scored positive miss: how much the two overlap. */
  overlap: number;
}

const cents = (p: number) => Math.floor(p * 100 + 1e-9);

/**
 * The cutoffs the items suggest, among those that reach Jev: `block` just above every clean score; `review` at the
 * lowest positive miss's score, raised until no more than `maxAppealShare` of the clean items land between the two.
 * A starting point for a person to decide, not a decision.
 */
export function suggestCutoffs(items: readonly ScoredItem[], maxAppealShare = 0.1): CutoffSuggestion {
  const judged = items.filter((i) => i.reachesJudge);
  const clean = judged.filter((i) => !i.positive);
  const positive = judged.filter((i) => i.positive);

  const maxClean = clean.reduce((m, i) => Math.max(m, i.p), 0);
  const blockCents = Math.min(100, (clean.length ? cents(maxClean) : 99) + 1);
  const minPositive = positive.reduce((m, i) => Math.min(m, i.p), 1);
  let reviewCents = Math.min(blockCents, positive.length ? cents(minPositive) : blockCents);

  const share = (rc: number) =>
    clean.length ? clean.filter((i) => i.p >= rc / 100 && i.p < blockCents / 100).length / clean.length : 0;
  while (reviewCents < blockCents && share(reviewCents) > maxAppealShare) reviewCents++;

  const review = reviewCents / 100;
  return {
    block: blockCents / 100,
    review,
    appealShare: share(reviewCents),
    knownMisses: positive.filter((i) => i.p < review).map((i) => i.id),
    overlap: positive.length ? clean.filter((i) => i.p >= minPositive).length : 0,
  };
}
