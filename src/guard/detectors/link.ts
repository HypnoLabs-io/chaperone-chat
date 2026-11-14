/** Links: a URL, a bare domain, a domain with its dot spelled out. The host's own domains pass (`domains.allow`). */
import type { Detector } from "../detector";
import { hostOf, type CoreContext } from "./context";

const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;

export function linkDetectors(ctx: CoreContext): Detector[] {
  const keep = (m: RegExpMatchArray) => !ctx.allowHost(hostOf(m[0], ctx.dotWord));
  return [
    { kind: "link", re: /\b(?:https?:\/\/|www\.)[^\s<>"']{1,300}/gi, keep },
    {
      kind: "link",
      re: new RegExp(
        String.raw`(?<![\w@.-])${LABEL}(?:\.${LABEL}){0,5}\.(?:${ctx.tldLink})(?![\w-])(?:\/[^\s<>"']{0,200})?`,
        "gi",
      ),
      keep,
    },
    {
      kind: "link",
      re: new RegExp(String.raw`(?<![\w@.-])[a-z0-9-]{2,63}${ctx.spelledDot}(?:${ctx.tldSpelled})(?![\w-])`, "gi"),
      keep,
    },
  ];
}
