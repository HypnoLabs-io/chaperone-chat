/**
 * A notice in plain words, ready for an email, a text or a push: a subject, a text body and an HTML body. Neutral on
 * purpose: it never quotes a message (what was said stays in the conversation), and names people only by the aliases
 * they chose. Use it as is, or as a starting point for your own words.
 */
import type { Notice } from "../chat/config";

export interface RenderOptions {
  /** Where the notice leads: the participant's chat page with their token (`${page}#t=${notice.link.token}`), or, for
   * a `trouble` notice, your moderation page. */
  url?: string;
  /** Your product's name, for "on Acme". Left out when not given. */
  appName?: string;
}

export interface RenderedNotice {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** "Sam", "Sam and Alex", "Sam, Alex and Jo". */
export function listNames(names: readonly string[]): string {
  if (names.length === 0) return "the others";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "2 days", "5 hours", "less than an hour". */
export function timeLeft(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return "less than an hour";
  if (hours < 48) {
    const h = Math.floor(hours);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return `${Math.floor(hours / 24)} days`;
}

export function renderNotice(notice: Notice, options: RenderOptions = {}): RenderedNotice {
  const on = options.appName ? ` on ${options.appName}` : "";
  let subject: string;
  let lines: string[];
  let action: string;

  if (notice.kind === "trouble") {
    subject = "Message screening needs attention";
    lines =
      notice.why === "cap"
        ? [
            `Jev's daily cap is spent: ${notice.calls} calls in the last 24 hours, against a cap of ${notice.cap}.`,
            "Until it frees up, messages that need Jev's check take your fallback: held for a later check, sent on the rules alone, or refused.",
          ]
        : [
            `Jev's last ${notice.failedInARow} calls all failed.`,
            "Until it answers again, messages that need its check take your fallback. Check your TypeSafe key and their service status.",
          ];
    action = "Open moderation";
  } else {
    const others = listNames(notice.others.map((o) => o.alias));
    if (notice.kind === "message") {
      subject = `New message from ${others}`;
      lines = [`${others} sent you a message${on}.`, "Messages stay in the conversation: read it and reply there."];
      action = "Read and reply";
    } else if (notice.kind === "reminder") {
      const left = timeLeft(notice.msLeft ?? 0);
      subject = `${left[0]!.toUpperCase()}${left.slice(1)} left in your conversation`;
      lines = [`Your conversation with ${others}${on} closes in ${left}.`];
      action = "Open the conversation";
    } else {
      subject = "Your conversation has ended";
      lines = [`Your conversation with ${others}${on} has ended.`];
      action = "See the conversation";
    }
  }

  const text = [...lines, ...(options.url ? ["", `${action}: ${options.url}`] : [])].join("\n");
  const html = [
    ...lines.map((l) => `<p>${escape(l)}</p>`),
    ...(options.url ? [`<p><a href="${escape(options.url)}">${escape(action)}</a></p>`] : []),
  ].join("\n");
  return { subject, text, html };
}
