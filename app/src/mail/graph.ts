/**
 * Outlook.com / Microsoft 365 connector, over Microsoft Graph.
 *
 * HTTPS only, like `gmail.ts`. Scopes: Mail.ReadWrite + Mail.Send (config.ts).
 *
 * Three things differ from Gmail enough to shape this file:
 *
 *  1. **Ids change when a message moves** — unless every request asks for
 *     immutable ids. Archive and delete are *moves* in Exchange, so without the
 *     `Prefer: IdType="ImmutableId"` header the id the app holds would stop
 *     naming anything the moment a row was swiped. It is sent on every call,
 *     because an id minted without it is a different id.
 *  2. **Archive is a folder.** Gmail's archive is a query; Outlook's is the
 *     well-known `archive` folder, which is also where Outlook's own Archive
 *     button puts mail. Using it is what keeps this app and Outlook agreeing.
 *  3. **The message JSON is not the message.** Anything the crypto core reads
 *     comes from `/$value` — the MIME source — never from Graph's rendering of
 *     it, which re-serialises the body.
 */
import { AuthError } from '../auth/types';
import { encodeUtf8Base64 } from '../lib/base64';
import { parseAddress } from '../lib/format';
import { FlagPatch, MailClient, MailError, Mailbox, MailSummary } from './types';

const ORIGIN = 'https://graph.microsoft.com/';
const API = `${ORIGIN}v1.0/me`;

type TokenSource = () => Promise<string>;

/** Graph's well-known folder names. */
const FOLDER: Record<Mailbox, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  archive: 'archive',
  spam: 'junkemail',
  trash: 'deleteditems',
};

/**
 * Where a message sits, as the label the rest of the app reads.
 *
 * Graph has no labels, but the folder a message was listed from is the same
 * claim. `JUNK` is already in the categoriser's list of junk labels, so a
 * message Outlook filed as junk is not un-hidden into Primary.
 */
const LABEL: Record<Mailbox, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  archive: 'ARCHIVE',
  spam: 'JUNK',
  trash: 'TRASH',
};

/**
 * Fields for a list row. `internetMessageHeaders` carries the cleartext headers
 * Graph has no property for — Autocrypt above all, which is how the sync learns
 * senders' keys without opening anything.
 */
const SELECT = [
  'id',
  'conversationId',
  'from',
  'toRecipients',
  'replyTo',
  'receivedDateTime',
  'subject',
  'bodyPreview',
  'isRead',
  'flag',
  'internetMessageId',
  'internetMessageHeaders',
].join(',');

export function createGraphClient(address: string, getAccessToken: TokenSource): MailClient {
  async function call(pathOrUrl: string, init: RequestInit = {}, expect: 'json' | 'text' | 'none' = 'json') {
    // A page cursor is a full URL Graph handed back. It is followed only on
    // Graph's own origin: this request carries the mailbox's bearer token, and a
    // cursor pointing anywhere else would hand that token to whoever wrote it.
    const absolute = /^https?:\/\//i.test(pathOrUrl);
    if (absolute && !pathOrUrl.startsWith(ORIGIN)) {
      throw new MailError('Refused to follow a page link that leaves Microsoft Graph.');
    }
    const token = await getAccessToken();
    const res = await fetch(absolute ? pathOrUrl : `${API}${pathOrUrl}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'IdType="ImmutableId"',
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Same reasoning as gmail.ts: a token revoked after the refresh reaches
      // the user as "sign in again", not a status code.
      if (res.status === 401) {
        throw new AuthError('Microsoft rejected the session. Sign in again to continue.', 'reauth-required');
      }
      if (res.status === 429) {
        const wait = res.headers?.get?.('Retry-After');
        throw new MailError(`Microsoft is throttling this mailbox${wait ? `; try again in ${wait}s` : ''}.`, 429);
      }
      throw new MailError(`Graph ${res.status}: ${detail.slice(0, 200)}`, res.status);
    }
    if (expect === 'none') return undefined;
    return expect === 'text' ? res.text() : res.json();
  }

  const messagePath = (id: string) => `/messages/${encodeURIComponent(id)}`;

  return {
    kind: 'outlook',
    address,

    async list(box, { limit = 20, pageToken, newerThanDays, from } = {}) {
      const page = (await call(pageToken ?? listPath(box, limit, newerThanDays, from))) as {
        value?: GraphMessage[];
        '@odata.nextLink'?: string;
      };
      // One request per page, unlike Gmail's `limit + 1`: Graph returns the
      // row fields inline, so there is no per-id metadata fetch behind it.
      return {
        messages: (page.value ?? []).map((m) => toSummary(m, box)),
        nextPageToken: page['@odata.nextLink'],
      };
    },

    async getRaw(id) {
      return (await call(`${messagePath(id)}/$value`, {}, 'text')) as string;
    },

    async send(rfc822) {
      // Graph takes MIME as base64 in a text/plain body — not JSON. It files the
      // copy in Sent Items itself, which, since the MIME is ciphertext, is
      // ciphertext too.
      await call(
        '/sendMail',
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: encodeUtf8Base64(rfc822) },
        'none',
      );
    },

    async updateFlags(id, patch) {
      const fields: Record<string, unknown> = {};
      if (patch.unread !== undefined) fields.isRead = !patch.unread;
      if (patch.starred !== undefined) fields.flag = { flagStatus: patch.starred ? 'flagged' : 'notFlagged' };
      if (Object.keys(fields).length > 0) {
        await call(messagePath(id), { method: 'PATCH', body: JSON.stringify(fields) });
      }

      const destination = destinationOf(patch);
      if (destination) {
        await call(`${messagePath(id)}/move`, {
          method: 'POST',
          body: JSON.stringify({ destinationId: destination }),
        });
      }
    },
  };
}

/**
 * The folder a patch moves a message to, or null when it moves nothing.
 *
 * One move per patch, strongest first: trash, then junk, then archive — as in
 * gmail.ts, where a deleted message is deleted whatever else rode along. Every
 * way back out lands in the inbox: Graph does not remember where a message came
 * from, and the inbox is where both Outlook and Gmail put one they restore.
 */
function destinationOf(patch: FlagPatch): string | null {
  if (patch.trashed !== undefined) return patch.trashed ? 'deleteditems' : 'inbox';
  if (patch.junk !== undefined) return patch.junk ? 'junkemail' : 'inbox';
  if (patch.archived !== undefined) return patch.archived ? 'archive' : 'inbox';
  return null;
}

/**
 * The first page of one folder.
 *
 * The sync window is a `$filter` on the same property the list is ordered by —
 * Graph refuses an `$orderby` whose property does not also lead the filter.
 */
function listPath(box: Mailbox, limit: number, newerThanDays?: number, from?: string): string {
  const params = [`$top=${limit}`, `$select=${SELECT}`, `$orderby=${encodeURIComponent('receivedDateTime desc')}`];
  const filters: string[] = [];
  if (newerThanDays && newerThanDays > 0) {
    const since = new Date(Date.now() - Math.floor(newerThanDays) * 86_400_000).toISOString();
    filters.push(`receivedDateTime ge ${since}`);
  } else if (from) {
    // Still leads with the ordered property, which Graph requires; this bound
    // excludes nothing.
    filters.push('receivedDateTime ge 1970-01-01T00:00:00Z');
  }
  // OData string literal: a quote is escaped by doubling it.
  if (from) filters.push(`from/emailAddress/address eq '${from.replace(/'/g, "''")}'`);
  if (filters.length > 0) params.push(`$filter=${encodeURIComponent(filters.join(' and '))}`);
  return `/mailFolders/${FOLDER[box]}/messages?${params.join('&')}`;
}

type GraphAddress = { emailAddress?: { name?: string; address?: string } };

type GraphMessage = {
  id: string;
  conversationId?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  receivedDateTime?: string;
  subject?: string;
  bodyPreview?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
};

function toSummary(message: GraphMessage, box: Mailbox): MailSummary {
  const headers = message.internetMessageHeaders ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const sender = message.from?.emailAddress;
  const from = sender?.address
    ? { address: sender.address.toLowerCase(), ...(sender.name ? { name: sender.name } : {}) }
    : parseAddress(header('From'));

  return {
    id: message.id,
    threadId: message.conversationId,
    from,
    to: (message.toRecipients ?? []).map((r) => r.emailAddress?.address ?? '').filter(Boolean),
    date: new Date(message.receivedDateTime || header('Date') || Date.now()).toISOString(),
    subject: message.subject || '(no subject)',
    snippet: message.bodyPreview ?? '',
    unread: message.isRead === false,
    starred: message.flag?.flagStatus === 'flagged',
    messageId: message.internetMessageId || header('Message-ID') || undefined,
    references: header('References') || undefined,
    autocrypt: header('Autocrypt') || undefined,
    replyTo: header('Reply-To') || message.replyTo?.[0]?.emailAddress?.address || undefined,
    authenticationResults: header('Authentication-Results') || undefined,
    listUnsubscribe: header('List-Unsubscribe') || undefined,
    returnPath: header('Return-Path') || undefined,
    labels: [LABEL[box]],
  };
}
