/**
 * What the spam engine is asked, and what it answers.
 *
 * Everything here is data — no behaviour — so the rule modules, the scorer and
 * the state layer can share one vocabulary without importing each other.
 *
 * ## The shape of the answer
 *
 * A verdict is a *score plus its reasons*, not a boolean. That is deliberate and
 * it is the rspamd model: every rule contributes a named, weighted symbol, the
 * weights sum, and the sum crosses a threshold. It means a misclassification can
 * be read off the symbol list instead of guessed at, and it means no single rule
 * can classify a message on its own — which is the whole defence against the
 * obvious failure mode here, "the word *verify* appears, therefore phishing".
 */

/**
 * The three-way answer.
 *
 * `phishing-suspicious` is not "spam, but worse". Spam is unwanted bulk mail;
 * phishing is a message impersonating someone to take something from the reader.
 * They earn different copy in the UI and they are reached by different symbols —
 * a failed DMARC on a bank's domain is phishing evidence and contributes nothing
 * to a bulk-mail score, while a `List-Unsubscribe` header and three exclamation
 * marks are the reverse.
 */
export type SpamClassification = 'legitimate' | 'spam' | 'phishing-suspicious';

/**
 * One rule that fired.
 *
 * `weight` may be negative: a message that authenticated cleanly and carries
 * unsubscribe hygiene is evidence *for* legitimacy, and saying so is how a
 * newsletter with a loud subject line stays out of the spam bucket.
 */
export type SpamSymbol = {
  /** Stable identifier, uppercase snake case — the string tests assert on. */
  name: string;
  weight: number;
  /**
   * How this rule tips the verdict. `phishing` symbols also count towards the
   * phishing threshold, which is what keeps the two classifications distinct
   * rather than cosmetic.
   */
  kind: 'spam' | 'phishing' | 'ham';
  /**
   * For a `ham` symbol: this evidence counts against the **phishing** score too,
   * not only the total.
   *
   * Almost no ham symbol qualifies. `HAS_LIST_UNSUBSCRIBE` does not — a phisher
   * sets that header for free — and the Bayes credit deliberately does not,
   * because the model learns what this user finds *unwanted*, which is a
   * bulk-mail judgement. What qualifies is authentication: phishing is
   * impersonation, and a passing DMARC is a cryptographic statement that the
   * visible `From` domain really did send the message. Withholding that from the
   * one score about impersonation is how a bank's own fraud alert — written, of
   * necessity, in the exact language of the attack it warns about — ends up
   * flagged as the attack.
   */
  counterPhishing?: boolean;
  /** Short human-readable evidence, safe to show a user. Never raw email HTML. */
  detail?: string;
};

export type SpamVerdict = {
  classification: SpamClassification;
  /** Sum of every symbol weight, including the Bayes contribution. */
  score: number;
  /**
   * Sum of the `phishing` symbols, plus any `ham` symbol marked
   * `counterPhishing` — which in practice means the authentication credits. See
   * `SpamSymbol.counterPhishing`.
   */
  phishingScore: number;
  symbols: SpamSymbol[];
  /**
   * Whether the personal Bayes model had enough training data to be consulted.
   * False on a fresh install, and the reason a new user still gets rule-only
   * filtering rather than nothing.
   */
  bayesApplied: boolean;
  /** The model's spam probability, or null when it was not consulted. */
  bayesProbability: number | null;
  /**
   * Set when the user has explicitly marked this message. An override short-
   * circuits scoring entirely: a human decision is not evidence to be weighed.
   */
  overridden: boolean;
};

/** Cleartext headers the engine reads. Every one is optional. */
export type SpamHeaders = {
  replyTo?: string;
  authenticationResults?: string;
  listUnsubscribe?: string;
  returnPath?: string;
  /**
   * The `Received` chain, accepted and deliberately **not scored**.
   *
   * It is here because a caller with the raw message has it to hand and passing
   * it must not be an error, but no rule reads it. Two reasons: the chain is
   * written by the relays themselves, so everything in it below the receiving
   * server is sender-controlled text; and what a client could soundly conclude
   * from it — did this message travel the path its domain authorises — is
   * precisely what `Authentication-Results` already states, having been checked
   * by the one hop that could check it. Scoring the hop names again would double-
   * count that evidence while adding a signal that a spammer writes for free.
   */
  received?: string;
  messageId?: string;
};

/**
 * Attachment metadata only — name, type, size. The bytes are never read, never
 * decoded and never executed.
 */
export type AttachmentMeta = { filename?: string; contentType?: string; size?: number };

/** An `<a href>` pairing lifted out of an HTML part. */
export type LinkPair = { href: string; text: string };

/**
 * Everything the engine is allowed to look at.
 *
 * Only content that is already readable on this device: a plaintext body, or a
 * body this device decrypted. Nothing here is fetched, and the engine never
 * follows a URL, loads a remote resource, or evaluates markup — `html` exists
 * solely so an anchor's visible text can be compared with its destination.
 */
export type SpamInput = {
  from?: { address: string; name?: string };
  to?: string[];
  subject?: string;
  /** Readable text. Subject is scored separately, so do not concatenate it here. */
  body?: string;
  /** Anchor pairs extracted from an HTML part, if the message had one. */
  links?: LinkPair[];
  headers?: SpamHeaders;
  attachments?: AttachmentMeta[];
  /** The signed-in address, so a lookalike of the user's own domain is visible. */
  selfAddress?: string;
};

/** A user's explicit correction. */
export type SpamMark = 'spam' | 'ham';

/* --------------------------------------------------------------- weights ---- */

/**
 * Thresholds, in the same units as the symbol weights.
 *
 * 5.0 is SpamAssassin's default required score and it is a good number for the
 * same reason: no single rule below is worth 5, so reaching it always takes a
 * combination. The phishing bar is lower because its symbols are individually
 * much stronger evidence — a `From`/`Reply-To` split across registrable domains
 * plus a link whose text lies about its host is already the whole attack.
 */
export const SPAM_THRESHOLD = 5.0;
export const PHISHING_THRESHOLD = 4.0;
