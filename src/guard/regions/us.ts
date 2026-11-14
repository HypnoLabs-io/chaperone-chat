/**
 * The United States: ten- and seven-digit phone numbers, numbered street addresses with a suffix ("123 Main St"),
 * apartment and suite numbers, and a state with its ZIP code ("Springfield, IL 62704").
 */
import { notCounting, type Detector } from "../detector";
import type { Region } from "./types";

/** Words that sit between a number and a street suffix without making an address ("5 minutes from Lincoln Ave"). */
const NOT_A_STREET = new Set(
  (
    // Time, distance and counts.
    "minutes minute mins min blocks block hours hour hrs hr years year yrs yr weeks week days day nights night " +
    "months month times time stops stop miles mile mi feet foot ft meters km " +
    // People and things that get counted.
    "people person guests guest kids kid children child students student sessions session lessons lesson " +
    "classes class grade grades subjects tenants roommates pets dogs cats rooms room bedrooms bedroom beds bed " +
    "baths bath bathrooms bathroom units floors floor stories items item pieces piece photos photo pics pic " +
    "dollars bucks jobs job roles role positions candidates applicants interviews dates train trains bus buses " +
    // Small words.
    "from to the of on at near by off in and or a an my your our their his her we us i you they is are am was " +
    "more less about around than only just over under per each every with for walk walking ride"
  ).split(" "),
);

/** The abbreviations a street's name can hold with a full stop: directions, titles and places ("Dr. King Blvd"). */
const NAME_ABBREVIATIONS = new Set(
  "n s e w ne nw se sw st mt ft pt dr jr sr gen adm col lt sgt pres rev hon msgr mass".split(" "),
);

const STREET_SUFFIX =
  "street|st|avenue|ave|av|road|rd|boulevard|blvd|place|pl|lane|ln|drive|dr|court|ct|parkway|pkwy|terrace|ter|" +
  "plaza|square|sq|highway|hwy|turnpike|tpke|crescent";

const STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|" +
  "PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR";

const STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma",
  "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
  "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
  "puerto rico",
]
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/ /g, String.raw`\s{1,3}`))
  .join("|");

const ZIP = String.raw`\s{0,3},?\s{1,3}\d{5}(?:-\d{4})?(?!\d)`;

const detectors: Detector[] = [
  // Ten digits, optionally with a leading 1: "(312) 555-0142", "+1 312 555 0142", "312.555.0142".
  {
    kind: "phone",
    re: /(?<!\d)(?:\+?\s?1[\s.\-_*]{0,3})?(?:\(\s{0,3}\d{3}\s{0,3}\)|\d{3})[\s.\-_*]{0,3}\d{3}[\s.\-_*]{0,3}\d{4}(?!\d)/g,
    keep: notCounting,
  },
  // Seven, apart in the middle: "555-0142". Not after "$" ("$150 1200").
  { kind: "phone", re: /(?<![\d$])\d{3}[\s.\-_*]{1,3}\d{4}(?!\d)/g, keep: notCounting },
  // A numbered street with a suffix: "123 Main St", "450 W 33rd St", "123-45 Queens Blvd".
  {
    kind: "address",
    re: new RegExp(
      String.raw`\b\d{1,5}[a-z]?(?:-\d{1,4})?\s{1,3}((?:[a-z0-9'’]{1,30}\.?\s{1,3}){1,3})(?:${STREET_SUFFIX})\b\.?`,
      "gi",
    ),
    keep: (m) => {
      const words = (m[1] ?? "").trim().split(/\s/);
      // A word with a full stop ends a sentence ("…30 inches. It's 650 square feet"), unless it is an abbreviation
      // a street's name holds ("W. 33rd St", "Mt. Vernon Pl").
      if (words.some((w) => w.endsWith(".") && !NAME_ABBREVIATIONS.has(w.slice(0, -1).toLowerCase()))) return false;
      return words.every((w) => !NOT_A_STREET.has(w.toLowerCase().replace(/[.'’]/g, "")));
    },
  },
  { kind: "address", re: /\b(?:apt|apartment|suite|ste)\.?\s{0,3}#?\s{0,3}\d{1,5}[a-z]?\b/gi },
  // A state and its ZIP code. The two-letter codes only in capitals: "in 10000 steps" is not Indiana.
  { kind: "address", re: new RegExp(String.raw`\b(?:${STATE_CODES})${ZIP}`, "g") },
  { kind: "address", re: new RegExp(String.raw`\b(?:${STATE_NAMES})${ZIP}`, "gi") },
];

export const us: Region = {
  id: "us",
  detectors,
  isFullPhone: (match) => match.trimStart().startsWith("+") || match.replace(/\D/g, "").length >= 10,
};
