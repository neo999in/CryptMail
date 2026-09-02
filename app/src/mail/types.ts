/**
 * Provider connector contract (architecture.md §2). The prototype ships one
 * implementation, Gmail REST; everything above this line is
 * provider-agnostic, which is what keeps Outlook and IMAP additive.
 */

export type MailSummary = {
  id: string;
  threadId?: string;
  from: { address: string; name?: string };
  to: string[];
  date: string;
  /** Header subject — the placeholder for encrypted mail. */
  subject: string;
  /** Provider-supplied preview; never trusted for encrypted mail. */
  snippet: string;
  unread: boolean;
  starred: boolean;
  /**
   * The message's own `Message-ID`, and its `References` header verbatim.
   *
   * Cleartext threading metadata (message-format.md) — captured so a reply can
   * emit `In-Reply-To`/`References` and land in the same conversation.
   */
  messageId?: string;
  references?: string;
  /**
   * Raw `Autocrypt` header value, when the message carried one.
   *
   * Cleartext, so it costs one extra metadata header per message and lets the
   * sync path learn senders' keys without opening — or decrypting — anything.
   */
  autocrypt?: string;
  /**
   * Cleartext envelope headers, when the provider supplied them.
   *
   * Read by the spam engine (`spam/headers.ts`): whether a message authenticated,
   * whether replies would leave the sender's domain, and whether it carries
   * unsubscribe hygiene are the strongest client-side phishing signals, and all
   * three live in headers rather than in the body.
   *
   * Every one is optional and stays optional. They are metadata the provider may
   * or may not stamp, and **absence is never treated as failure** — a message with
   * no `Authentication-Results` is the ordinary case, not a suspicious one. A
   * connector that supplies none of them yields exactly the behaviour that existed
   * before these fields did.
   */
  replyTo?: string;
  authenticationResults?: string;
  listUnsubscribe?: string;
  returnPath?: string;
  /**
   * The provider's own labels, verbatim (`CATEGORY_PROMOTIONS`, `SPAM`, …).
   *
   * Cleartext metadata the provider assigned, so it costs nothing to carry — it
   * arrives on the same `format=metadata` response the headers do. Read by the
   * categoriser for **plaintext mail only**: a label is the provider's reading of
   * content it could see, and an encrypted message gives it nothing to read.
   *
   * That applies to the junk label as much as to the category ones. A `SPAM`
   * label on plaintext mail is a verdict from a filter with reputation data no
   * client has, and it decides the Junk bucket; the same label on an encrypted
   * message is a verdict about ciphertext, so it is ignored and the message stays
   * visible (`categorizer/categorizer.ts`).
   */
  labels?: string[];
};

/**
 * A list of mail the provider can serve.
 *
 * `archive` is not a folder anywhere — it is everything the account keeps that is
 * not in the inbox, not sent, and not a draft. Gmail models it as a query rather
 * than a label, which is why connectors translate this rather than passing it on.
 *
 * `spam` is the provider's own junk folder, and it has to be asked for by name:
 * a message the provider filed as spam is **not** in the inbox — Gmail moves it
 * out — so listing the inbox can never return it. Without this, the app's Junk
 * destination could only ever show mail the provider *delivered* and this device
 * then flagged, which is an empty list on a mailbox whose provider filter works.
 */
export type Mailbox = 'inbox' | 'sent' | 'archive' | 'spam';

/**
 * One page of rows, plus the cursor that reaches the page behind it.
 *
 * `nextPageToken` absent means the mailbox has no older mail — that is the only
 * thing that ends paging, so a connector must not omit a cursor it still has.
 */
export type MailPage = {
  messages: MailSummary[];
  nextPageToken?: string;
};

/** A change to a message's flags. `archived: true` removes it from the inbox. */
export type FlagPatch = { unread?: boolean; starred?: boolean; archived?: boolean };

export interface MailClient {
  readonly kind: 'gmail';
  readonly address: string;
  /**
   * One page of a mailbox, newest first. `pageToken` continues a previous page.
   *
   * Paged rather than capped: a mailbox is older than any one page, and without a
   * cursor the app could only ever show its newest `limit` messages.
   */
  list(box: Mailbox, options?: { limit?: number; pageToken?: string }): Promise<MailPage>;
  /** Full RFC 5322 source — what the crypto core needs. */
  getRaw(id: string): Promise<string>;
  send(rfc822: string): Promise<void>;
  /** Update read/starred/archived state. Metadata only — never touches ciphertext. */
  updateFlags(id: string, patch: FlagPatch): Promise<void>;
}

export class MailError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MailError';
  }
}
