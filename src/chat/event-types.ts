/**
 * Every event the engine records, by name. An event carries ids and numbers, never message text, so the log can be
 * kept, exported and read without exposing what anyone wrote.
 */
export const EVENT = {
  conversationOpened: "conversation_opened",
  /** Delivered. */
  messageSent: "message_sent",
  /** Stored, waiting for a check or a moderator. */
  messageHeld: "message_held",
  /** Refused: never stored. Counts toward the sender's daily limit. */
  messageBlocked: "message_blocked",
  /** Observe mode: delivered, though the check would have stopped it. */
  messageObserved: "message_observed",
  /** One call to Jev, claimed under the daily cap before it is made; its meta gets the score, never the text. */
  jevCall: "jev_call",
  /** A held message delivered by a moderator, or by a check that passed it later. */
  messageApproved: "message_approved",
  /** A held message a moderator refused: its text is cleared. */
  messageRefused: "message_refused",
  /** A delivered message a moderator removed: gone from the others' screens. A miss worth calibrating against. */
  messageHidden: "message_hidden",
  /** A participant chose an outcome. */
  voteCast: "vote_cast",
  /** A close claimed, before the host's hook runs. */
  conversationClosing: "conversation_closing",
  conversationClosed: "conversation_closed",
  /** The host's hook refused a close: open again. */
  conversationReopened: "conversation_reopened",
  /** The host's hook threw: still closing, the sweep tries again. */
  closeFailed: "close_failed",
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];
