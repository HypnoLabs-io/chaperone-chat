import type { Detector } from "../detector";

/**
 * A region is the part of the rules that follows local formats: phone numbers without a "+" country code, street
 * addresses, postal codes. `us` ships; pass your own object for another country, or `region: null` for none (a "+…"
 * international number and a long run of digits are still found everywhere).
 */
export interface Region {
  /** Short and stable ("us"). */
  readonly id: string;
  /** Phone and address detectors in this region's formats. */
  readonly detectors: readonly Detector[];
  /**
   * Whether a phone match carries its area code, for the split-message pass: a number read across several short
   * messages counts only when it is complete. Default: a "+…" number, or ten digits or more.
   */
  isFullPhone?(match: string): boolean;
}
