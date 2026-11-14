/**
 * The apps and sites people move a conversation, a meeting or a payment to, in groups that can each be turned off
 * (`apps.groups`), plus the host's own extra names (`apps.extra`). A name in `apps.allow` passes wherever it appears.
 *
 * Usually innocent words count only in context: Signal and Messenger after "on / via" and only at a clause end
 * ("signal words", "messenger RNA" pass); Zoom only where it names the app ("on Zoom", "a Zoom link", "Zoom works"),
 * never "zoom in"; WeChat is "wechat", never "can we chat".
 */
import { alternation, type Detector } from "../detector";

export const APP_GROUPS = ["messaging", "payments", "scheduling", "marketplaces", "meetings"] as const;
export type AppGroup = (typeof APP_GROUPS)[number];

const GROUP_PATTERNS: Readonly<Record<AppGroup, readonly RegExp[]>> = {
  messaging: [
    /\b(?:whats\s?app|wa\.me|t\.me|snap\s?chat|kik|viber|wechat|we\s{1,3}chat\s{1,3}(?:app|id)|group\s?me|google\s{1,3}voice|i\s?message|face\s?time)\b/gi,
    // Signal and Messenger are English too ("signal words", "messenger RNA"): after "on" they count only at the end
    // of a clause or before a short word ("I'm on Signal too").
    /\b(?:on|via|over|through|use|using|thru)\s{1,3}(?:telegram|discord|skype|(?:signal|messenger)(?=\s{0,3}(?:$|[.,!?;:)]|too\b|instead\b|or\b|and\b|if\b|please\b|as\b)))\b|\b(?:telegram|signal|discord|skype)\s{1,3}(?:me|app|number|chat|id)\b|\b(?:fb|facebook)\s{1,3}messenger\b/gi,
  ],
  payments: [/\b(?:venmo|zelle|cash\s?app|pay\s?pal)\b/gi],
  scheduling: [/\b(?:calendly|linktr(?:ee|\.ee))\b/gi],
  marketplaces: [/\b(?:craigslist|thumbtack|upwork|fiverr|task\s?rabbit)\b/gi],
  // A video call is a way to meet outside the chat ("Zoom or Google Meet works").
  meetings: [
    /\b(?:google\s{1,3}meet|g\s?meet|microsoft\s{1,3}teams|ms\s{1,3}teams|webex|whereby|jitsi)\b|\b(?:on|over|via|thru|through|using|use|by)\s{1,3}zoom\b(?!\s{1,3}(?:in|out|lens)\b)|\bzoom\s{1,3}(?:calls?|meetings?|links?|sessions?|rooms?|id|account|works|is\s{1,3}(?:fine|easier|best|ok)|or\s{1,3}(?:google|teams|face\s?time|skype|in\s{1,3}person))\b/gi,
  ],
};

export interface AppOptions {
  /** Each group on (the default) or off. */
  groups?: Partial<Record<AppGroup, boolean>>;
  /** More names to refuse, as plain text ("Acme Pay"). */
  extra?: readonly string[];
  /** Names that pass wherever they appear, in an app or an ask ("Venmo me"), as plain text. */
  allow?: readonly string[];
}

export function appDetectors(options: AppOptions = {}): Detector[] {
  const detectors: Detector[] = [];
  for (const group of APP_GROUPS) {
    if (options.groups?.[group] === false) continue;
    for (const re of GROUP_PATTERNS[group]) detectors.push({ kind: "app", re });
  }
  const extra = alternation(options.extra ?? []);
  if (extra) detectors.push({ kind: "app", re: new RegExp(String.raw`(?<![\w])(?:${extra})(?![\w])`, "gi") });
  return detectors;
}
