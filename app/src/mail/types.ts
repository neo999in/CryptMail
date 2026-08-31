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
};

/** A change to a message's flags. `archived: true` removes it from the inbox. */
export type FlagPatch = { unread?: boolean; starred?: boolean; archived?: boolean };

export interface MailClient {
  readonly kind: 'gmail';
  readonly address: string;
  listInbox(limit?: number): Promise<MailSummary[]>;
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
