/** Emails: written out, with "at" / "dot" spelled, and the mail services named ("my gmail is …"). */
import type { Detector } from "../detector";
import type { CoreContext } from "./context";

const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;

export function emailDetectors(ctx: CoreContext): Detector[] {
  const hasDotWord = new RegExp(String.raw`\.|${ctx.dotWord.source}`, "i");
  return [
    {
      kind: "email",
      re: new RegExp(
        String.raw`[a-z0-9._%+-]{1,64}\s{0,3}@\s{0,3}${LABEL}(?:(?:\s{0,3}\.\s{0,3}|${ctx.spelledDot})${LABEL}){0,6}`,
        "gi",
      ),
      // A domain needs a letter: "meet @ 5" is not an email. And "I'm @sam" is a handle: a space before the "@",
      // none after and no dot in what follows ("sam g @ gmail . com" and "jsmith@ gmail" stay emails).
      keep: (m) => {
        const [local = "", domain = ""] = m[0].split("@");
        if (!/[a-z]/i.test(domain)) return false;
        return !(/\s$/.test(local) && !/^\s/.test(domain) && !hasDotWord.test(domain));
      },
    },
    {
      kind: "email",
      re: new RegExp(
        String.raw`[a-z0-9._%+-]{1,64}${ctx.spelledAt}${LABEL}(?:(?:\.|${ctx.spelledDot})${LABEL}){0,4}?(?:\.|${ctx.spelledDot})(?:${ctx.tldEmail})(?![\w-])`,
        "gi",
      ),
    },
    {
      kind: "email",
      re: /\b(?:g\s?mail|hotmail|ymail|yahoo\s?mail|icloud|proton\s?mail|aol\s?mail|aol\.com|outlook\.com|live\.com|msn\.com)\b|\b(?:at|my|your|ur)\s{1,3}(?:yahoo|outlook|aol)\b/gi,
    },
  ];
}
