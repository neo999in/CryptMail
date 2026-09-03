/**
 * Gmail REST connector (prototype-plan.md M4).
 *
 * HTTPS only — no IMAP sockets. Scopes: gmail.readonly + gmail.send.
 */
import { base64ToBytes, bytesToUtf8, encodeUtf8Base64, fromBase64Url, toBase64Url } from '../lib/base64';
import { parseAddress } from '../lib/format';
import { AuthError } from '../auth/types';
import { MailClient, MailError, Mailbox, MailSummary } from './types';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

type TokenSource = () => Promise<string>;

export function createGmailClient(address: string, getAccessToken: TokenSource): MailClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getAccessToken();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // A token can be revoked between the refresh and this call, so a 401 here
      // is the same situation as a failed refresh and has to reach the user as
      // "sign in again" rather than a bare status code they cannot act on.
      if (res.status === 401) {
        throw new AuthError(
          'Google rejected the session. Sign in again to continue.',
          'reauth-required',
        );
      }
      throw new MailError(`Gmail ${res.status}: ${detail.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  return {
    kind: 'gmail',
    address,

    async list(box, { limit = 20, pageToken } = {}) {
      const list = await call<{
        messages?: { id: string; threadId: string }[];
        nextPageToken?: string;
      }>(
        `/messages?maxResults=${limit}${selector(box)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      );
      const ids = list.messages ?? [];
      // Metadata format is enough for the list; raw is fetched lazily on open.
      const details = await Promise.all(
        ids.map((m) =>
          call<GmailMessage>(
            // `Autocrypt` rides along with the rest: it is cleartext, and asking
            // for it here is what lets the sync harvest senders' keys without
            // fetching a single message body.
            //
            // The four envelope headers after it are for the spam engine, and they
            // are cheap for the same reason: `format=metadata` returns headers
            // only, so requesting more of them adds no body bytes and no extra
            // round trip. Gmail simply omits any header a message did not carry,
            // which is why every one is optional on `MailSummary`.
            `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Autocrypt&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To&metadataHeaders=Authentication-Results&metadataHeaders=List-Unsubscribe&metadataHeaders=Return-Path`,
          ),
        ),
      );
      // Each id costs its own metadata GET, so a page is `limit + 1` requests —
      // which is what keeps the page small rather than fetching the mailbox.
      return { messages: details.map(toSummary), nextPageToken: list.nextPageToken };
    },

    async getRaw(id) {
      const message = await call<{ raw: string }>(`/messages/${id}?format=RAW`);
      return bytesToUtf8(base64ToBytes(fromBase64Url(message.raw)));
    },

    async send(rfc822) {
      await call('/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw: toBase64Url(encodeUtf8Base64(rfc822)) }),
      });
    },

    async updateFlags(id, patch) {
      // Deleting and restoring are their own endpoints, not label edits: Gmail
      // treats `TRASH` as a system label `messages.modify` may refuse, and the
      // dedicated calls are what other clients on the account will agree with.
      // Done first and on its own, so a patch that also carries `unread: false`
      // — which is what opening a message then deleting it produces — still ends
      // with the message in the right place.
      if (patch.trashed !== undefined) {
        await call(`/messages/${id}/${patch.trashed ? 'trash' : 'untrash'}`, { method: 'POST' });
      }

      const addLabelIds: string[] = [];
      const removeLabelIds: string[] = [];
      if (patch.starred === true) addLabelIds.push('STARRED');
      if (patch.starred === false) removeLabelIds.push('STARRED');
      if (patch.unread === true) addLabelIds.push('UNREAD');
      if (patch.unread === false) removeLabelIds.push('UNREAD');
      if (patch.archived) removeLabelIds.push('INBOX');
      if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;
      // Requires the gmail.modify scope, which `config.ts` requests. Verified
      // against a real mailbox on 2026-08-08: a star set here survives a cold
      // restart, so the label change reaches Google rather than 403ing.
      await call(`/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds, removeLabelIds }),
      });
    },
  };
}

/**
 * The query for one mailbox.
 *
 * Inbox and Sent are labels; **archive is not**. Gmail has no archived label —
 * archiving removes `INBOX` and leaves the message in All Mail — so it is asked
 * for by exclusion. Drafts and sent mail are excluded explicitly because they are
 * also "not in the inbox" and would otherwise appear here.
 *
 * The junk folder has to opt in twice, and that is the whole reason the app's
 * Spam view was empty against a real mailbox. `messages.list` omits SPAM and TRASH unless
 * `includeSpamTrash` is set, so the flag lifts that exclusion; `labelIds=SPAM`
 * then narrows the result to the junk folder alone rather than mixing junk into
 * every other list. Both are sent because each does a different half of the job —
 * the flag alone would widen every query, and the label alone is filtered out by
 * the default exclusion before it can match anything.
 *
 * Trash opts in the same way and for the same reason, with `labelIds=TRASH`: a
 * deleted message is excluded from `messages.list` by default, so without the
 * flag the Trash destination would be permanently empty even on a mailbox full
 * of deleted mail.
 *
 * The other three lists therefore need no exclusion of their own: spam and trash
 * are already absent from them, which is also why archive's `-in:` query does not
 * mention either.
 */
function selector(box: Mailbox): string {
  if (box === 'sent') return '&labelIds=SENT';
  if (box === 'archive') return `&q=${encodeURIComponent('-in:inbox -in:sent -in:draft')}`;
  if (box === 'spam') return '&labelIds=SPAM&includeSpamTrash=true';
  if (box === 'trash') return '&labelIds=TRASH&includeSpamTrash=true';
  return '&labelIds=INBOX';
}

type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
};

function toSummary(message: GmailMessage): MailSummary {
  const headers = message.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const from = parseAddress(header('From'));
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    to: header('To')
      .split(',')
      .map((a) => parseAddress(a).address)
      .filter(Boolean),
    date: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : new Date(header('Date') || Date.now()).toISOString(),
    subject: header('Subject') || '(no subject)',
    snippet: decodeEntities(message.snippet ?? ''),
    unread: message.labelIds?.includes('UNREAD') ?? false,
    starred: message.labelIds?.includes('STARRED') ?? false,
    messageId: header('Message-ID') || undefined,
    references: header('References') || undefined,
    autocrypt: header('Autocrypt') || undefined,
    replyTo: header('Reply-To') || undefined,
    authenticationResults: header('Authentication-Results') || undefined,
    listUnsubscribe: header('List-Unsubscribe') || undefined,
    returnPath: header('Return-Path') || undefined,
    labels: message.labelIds,
  };
}

const decodeEntities = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

/** Exposed for the `users.getProfile` smoke check in M3. */
export async function getProfileAddress(accessToken: string): Promise<string> {
  const res = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new MailError(`Gmail ${res.status}`, res.status);
  const profile = (await res.json()) as { emailAddress: string };
  return profile.emailAddress;
}
