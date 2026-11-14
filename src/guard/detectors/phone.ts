/**
 * Phones in any region: an international "+…" number and a long run of digits. A region adds its own formats
 * (`../regions/`).
 */
import { notCounting, type Detector } from "../detector";

export function phoneDetectors(): Detector[] {
  return [
    { kind: "phone", re: /\+\d{1,3}(?:[\s.\-]{0,2}\d{2,4}){2,5}(?!\d)/g },
    // Seven digits or more in a row. A run longer than 64 is no phone number.
    { kind: "phone", re: /(?<!\d)\d{7,64}(?!\d)/g, keep: notCounting },
  ];
}
