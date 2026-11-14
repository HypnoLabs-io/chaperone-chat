/** Every word the component shows, so a host can change any of them (or translate them) through `labels`. */
import { errorText } from "../client";

export interface ChatLabels {
  loading: string;
  talkingWith: (aliases: readonly string[]) => string;
  /** Time left, from the deadline; null hides it. */
  timeLeft: (msLeft: number | null) => string | null;
  closing: string;
  closed: (outcome: string | null) => string;
  /** The line that says contact details stay out; empty hides it. */
  privacy: string;
  empty: string;
  emptyClosed: string;
  olderHidden: string;
  messagesLabel: string;
  you: string;
  time: (iso: string) => string;
  messageLabel: string;
  placeholder: string;
  /** Near the limit: "812 / 1000". Empty hides it. */
  counter: (length: number, max: number) => string;
  send: string;
  sending: string;
  appeal: string;
  /** After a message is held for a check. */
  held: string;
  outcome: (outcome: string) => string;
  confirmOutcome: (outcome: string) => string;
  confirmYes: (outcome: string) => string;
  confirmNo: string;
  waiting: (aliases: readonly string[]) => string;
  /** An error code (`blocked`, `too_long`, `rate_limited`…) and the server's own sentence when it sent one. */
  error: (code: string, message?: string) => string;
}

const names = (aliases: readonly string[]) =>
  aliases.length <= 1 ? (aliases[0] ?? "the others") : `${aliases.slice(0, -1).join(", ")} and ${aliases[aliases.length - 1]}`;

export const DEFAULT_LABELS: ChatLabels = {
  loading: "Loading the conversation…",
  talkingWith: (aliases) => `Talking with ${names(aliases)}`,
  timeLeft: (ms) => {
    if (ms === null) return null;
    const hours = ms / 3_600_000;
    if (hours < 1) return "Less than an hour left.";
    if (hours < 48) return `${Math.floor(hours)} hours left.`;
    return `${Math.ceil(hours / 24)} days left.`;
  },
  closing: "This conversation is closing.",
  closed: () => "This conversation has closed.",
  privacy: "No emails, phone numbers, links or handles here: messages that hold them aren't sent.",
  empty: "No messages yet. Say hello.",
  emptyClosed: "No messages.",
  olderHidden: "Older messages aren't shown.",
  messagesLabel: "Messages",
  you: "You",
  time: (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }),
  messageLabel: "Your message",
  placeholder: "Write a message…",
  counter: (n, max) => (n >= max * 0.8 ? `${n} / ${max}` : ""),
  send: "Send",
  sending: "Sending…",
  appeal: "It isn't a way to get in touch: send it for a quick check",
  held: "Sent for a quick check. It goes through once it passes.",
  outcome: (o) => (o === "end" ? "End the conversation" : o.replace(/[_-]/g, " ")),
  confirmOutcome: (o) => (o === "end" ? "End this conversation for everyone?" : `Choose "${o.replace(/[_-]/g, " ")}"?`),
  confirmYes: (o) => (o === "end" ? "Yes, end it" : "Yes"),
  confirmNo: "Not yet",
  waiting: (aliases) => `Waiting for ${names(aliases)} to choose it too.`,
  error: (code, message) => (message && (code === "blocked" || code === "refused") ? message : errorText(code)),
};
