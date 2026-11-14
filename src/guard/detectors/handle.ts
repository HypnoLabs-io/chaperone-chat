/** Handles: "@name", "$cashtag", and a labelled one ("ig: name", "snap: name"). */
import type { Detector } from "../detector";

export function handleDetectors(): Detector[] {
  return [
    { kind: "handle", re: /(?<![\w.@])@[a-z_][a-z0-9_.]{1,29}/gi },
    { kind: "handle", re: /(?<![\w$])\$[a-z][a-z0-9_-]{2,19}(?![\w])/gi },
    {
      kind: "handle",
      re: /\b(?:ig|insta(?:gram)?|sc|snap(?:chat)?|tiktok|twitter|tg|telegram|handle|user\s?name)\s{0,3}[:=]\s{0,3}@?[a-z0-9_.]{2,30}/gi,
    },
  ];
}
