/**
 * English: number words, "oh" for zero, "at" / "dot" spelled out, and the asks. Words that are usually innocent count
 * only in context: "call me" not before a name ("call me Sam"), "search me" not as "I don't know", a phone call only
 * when someone asks to get on one ("hop on a quick call", never "good call"), a name only when it is asked for.
 */
import type { Locale, LocaleContext } from "./types";

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

function asks({ platformNames }: LocaleContext): RegExp[] {
  const platforms = `app|platform|site|website|chat${platformNames ? `|${platformNames}` : ""}`;
  return [
    // "text me", "dm me", "venmo me", "google me".
    /\b(?:text|txt|texting|dm|pm|inbox|e-?mail|ring|phone|whats\s?app|wa|facetime|snap|skype|telegram|signal|venmo|zelle|google|insta|ig)\s{1,3}me\b/gi,
    // "call me" where it asks for a call, never before a name ("call me Sam").
    /\bcall\s{1,3}me\b(?=\s{0,3}(?:at\b|on\b|@|any\s?time|whenever|tonight|today|tomorrow|later|back\b|when\b|if\b|after\b|before\b|asap|so\b|and\b|or\b|$|[.!?,:;)]))/gi,
    // A video call is a way to meet outside the chat.
    /\bvideo[\s-]?(?:chat(?:s|ting)?|call(?:s|ing)?|conference|meeting)\b|\bvid\s{1,3}(?:chat|call)\b/gi,
    // So is a phone call someone asks to get on, give or make short; never the English word ("good call", "roll call").
    /\b(?:hop|jump|get)\s{1,3}on\s{1,3}(?:a\s{1,3})?(?:(?:quick|short|brief|phone|video)\s{1,3})?call\b|\b(?:quick|short|brief|phone|intro|introductory)\s{1,3}(?:phone\s{1,3})?call\b|\bgive\s{1,3}(?:me|you|us)\s{1,3}a\s{1,3}(?:quick\s{1,3})?(?:call|ring|buzz)\b/gi,
    // Asking to be looked up. A bare "search (for) me" counts only before on / up / online, or at a clause end
    // after "for": "Search me, I don't know" is an idiom.
    /\bhit\s{1,3}me\s{1,3}up\b|\blook\s{1,3}me\s{1,3}up\b|\b(?:google|search(?:\s{1,3}for)?|find|look\s{1,3}up|look\s{1,3}for)\s{1,3}my\s{1,3}(?:full\s{1,3})?name\b|\bsearch\s{1,3}(?:for\s{1,3})?me\s{1,3}(?:up|on|online)\b|\bsearch\s{1,3}for\s{1,3}me\b(?=\s{0,3}(?:$|[.!?,;:)]))/gi,
    /\b(?:add|follow|find|dm|message)\s{1,3}me\s{1,3}(?:on|via|through|over|@)(?=\s|@|$)|\b(?:reach|contact)\s{1,3}me\s{1,3}(?:at|on|via|through|by|@|directly)(?=\s|@|$)/gi,
    // "my number", "your email", "your instagram". "My number one priority" passes.
    /\b(?:my|your|ur|yr)\s{1,3}(?:(?:cell|mobile)(?:\s{1,3}(?:phone|number))?|phone(?:\s{1,3}number)?|number(?!\s{1,3}(?:one|1|two|three|of)\b)|digits|e-?mail(?:\s{1,3}address)?|contact(?:\s{1,3}(?:info|information|details))?|handle|user\s?name|website|web\s{1,3}site|socials?|home\s{1,3}address|address|instagram|insta|ig|facebook|fb|tiktok|linked\s?in|twitter|snap(?:chat)?|whats\s?app|telegram|signal|discord|skype|venmo|zelle|pay\s?pal|cash\s?app)\b/gi,
    // A name only when it is asked for: an offered full name passes ("my last name is Lee").
    /\b(?:your|ur|yr)\s{1,3}(?:(?:last|full|real|family|whole)\s{1,3}name|surname)\b/gi,
    // Moving off the platform.
    new RegExp(
      String.raw`\b(?:off|outside(?:\s{1,3}of)?)\s{1,3}(?:the\s{1,3}|this\s{1,3})?(?:${platforms})(?![\w])|\btake\s{1,3}(?:this|it|things)\s{1,3}offline\b|\b(?:talk|chat|connect|speak|text)\s{1,3}(?:directly|privately|offline)\b`,
      "gi",
    ),
  ];
}

export const en: Locale = {
  id: "en",
  digitWords: DIGIT_WORDS,
  zeroWords: ["oh", "o"],
  atWords: ["at"],
  dotWords: ["dot"],
  asks,
};
