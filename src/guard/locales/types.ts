/**
 * A locale is the language-bound part of the rules: number words, "at" and "dot" spelled out, and the asks (to move
 * elsewhere, for contact details, to be looked up). `en` and `es` ship; pass your own object for another language.
 */

export interface LocaleContext {
  /**
   * The host's own names as one escaped alternation ("acme|acme\s{1,3}market"), or "" when there are none. An ask
   * like "off the app" names them too ("off Acme").
   */
  readonly platformNames: string;
}

export interface Locale {
  /** Short and stable ("en"). */
  readonly id: string;
  /** Number words to digits, lowercase keys ("nine" → "9"), read by the second pass ("nine one seven…"). */
  readonly digitWords?: Readonly<Record<string, string>>;
  /** Words said for zero, read as 0 only between two digits ("five three oh nine"). */
  readonly zeroWords?: readonly string[];
  /** "at" spelled out in an email ("jsmith at gmail"), as patterns. */
  readonly atWords?: readonly string[];
  /** "dot" spelled out in an email or a web address ("gmail dot com"), as patterns. */
  readonly dotWords?: readonly string[];
  /** The `ask` patterns, global and case-insensitive, every quantifier bounded. */
  asks?(context: LocaleContext): readonly RegExp[];
}
