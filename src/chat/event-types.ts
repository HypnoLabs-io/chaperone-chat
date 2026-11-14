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
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];
