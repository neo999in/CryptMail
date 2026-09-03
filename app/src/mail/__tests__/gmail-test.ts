/**
 * What the connector asks Gmail for, one mailbox at a time.
 *
 * The junk folder is why this file exists. `messages.list` leaves SPAM and TRASH
 * out of every result unless it is told otherwise, and a message Gmail files as
 * spam is not in `INBOX` either — Gmail moves it out. So a Spam view assembled
 * from the inbox query is empty on any account whose provider filter is doing its
 * job, which is exactly how the app behaved against a real mailbox: two messages
 * in Gmail's Spam folder, nothing in CryptMail's.
 *
 * The query string is the whole of what this app controls here, so the query
 * string is what these pin. Nothing about Gmail's own behaviour is asserted.
 */
import { createGmailClient } from '../gmail';
import { Mailbox } from '../types';

type Json = Record<string, unknown>;

const original = globalThis.fetch;

/**
 * Records every URL asked for and answers from a two-route table: the list call,
 * and the per-id metadata call behind it. `/messages?` is the discriminator —
 * a metadata GET is `/messages/<id>?…`.
 */
function stubGmail(routes: { list?: Json; message?: Json } = {}) {
  const urls: string[] = [];
  const fetch = async (url: unknown) => {
    const asked = String(url);
    urls.push(asked);
    const body = asked.includes('/messages?') ? (routes.list ?? { messages: [] }) : (routes.message ?? {});
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  (globalThis as unknown as { fetch: unknown }).fetch = fetch;
  return urls;
}

const client = () => createGmailClient('me@example.com', async () => 'access-token');

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = original;
});

describe('the query per mailbox', () => {
  it('asks for the junk folder by label, and lifts the default exclusion', async () => {
    const urls = stubGmail();

    await client().list('spam');

    // Both halves are needed and neither is redundant: the flag lifts the blanket
    // exclusion of SPAM and TRASH, the label narrows the result to junk alone.
    expect(urls[0]).toContain('labelIds=SPAM');
    expect(urls[0]).toContain('includeSpamTrash=true');
  });

  it('asks for the trash folder by label, and lifts the same exclusion', async () => {
    const urls = stubGmail();

    await client().list('trash');

    // Deleted mail is excluded from `messages.list` by default exactly as junk
    // is, so without both halves the Trash destination is empty on a mailbox
    // full of deleted mail — the same bug the junk folder had.
    expect(urls[0]).toContain('labelIds=TRASH');
    expect(urls[0]).toContain('includeSpamTrash=true');
  });

  it('never widens any other list to include junk', async () => {
    for (const box of ['inbox', 'sent', 'archive'] as Mailbox[]) {
      const urls = stubGmail();
      await client().list(box);
      // Spam and trash are lists of their own. A flag left on the inbox query
      // would mix suspected phishing — and mail the reader deleted — into the
      // mail people skim.
      expect(urls[0]).not.toContain('includeSpamTrash');
      expect(urls[0]).not.toContain('SPAM');
      expect(urls[0]).not.toContain('TRASH');
    }
  });

  it('still asks the inbox for the inbox label', async () => {
    const urls = stubGmail();
    await client().list('inbox');
    expect(urls[0]).toContain('labelIds=INBOX');
  });

  it('pages junk on the cursor it is given', async () => {
    const urls = stubGmail();
    await client().list('spam', { limit: 10, pageToken: 'p2' });
    expect(urls[0]).toContain('maxResults=10');
    expect(urls[0]).toContain('pageToken=p2');
  });
});

describe('what a junk row carries back', () => {
  it("keeps the provider's labels, which is what files the message", async () => {
    // Without `labels` reaching `MailSummary` the categoriser has nothing to defer
    // to, and a fetched junk message would land in Primary — worse than not
    // fetching it, because the app would then be un-hiding the provider's spam.
    const urls = stubGmail({
      list: { messages: [{ id: 'm1', threadId: 't1' }] },
      message: {
        id: 'm1',
        threadId: 't1',
        labelIds: ['SPAM'],
        internalDate: '1754300000000',
        snippet: 'Amazon Amazon Dear Customer, Greetings from Amazon.',
        payload: {
          headers: [
            { name: 'From', value: 'Amazon.in <no-reply@amazon-refunds.example>' },
            { name: 'Subject', value: 'Refund on order 408-6419373-4985156' },
            { name: 'To', value: 'me@example.com' },
          ],
        },
      },
    });

    const page = await client().list('spam');

    expect(urls).toHaveLength(2);
    expect(page.messages[0].labels).toEqual(['SPAM']);
    expect(page.messages[0].subject).toBe('Refund on order 408-6419373-4985156');
    expect(page.messages[0].from.name).toBe('Amazon.in');
  });

  it('reports no cursor as the end of the folder', async () => {
    stubGmail({ list: { messages: [] } });
    await expect(client().list('spam')).resolves.toEqual({ messages: [], nextPageToken: undefined });
  });
});

/**
 * Deleting and restoring.
 *
 * These are the one flag change that is not a label edit: Gmail has dedicated
 * `messages.trash` / `messages.untrash` endpoints, and `messages.modify` may
 * refuse `TRASH` outright. So what is pinned here is which endpoint is called —
 * a move that quietly turned into a label patch would appear to work and leave
 * the message where it was.
 */
describe('moving a message to the trash and back', () => {
  /** Records the path and HTTP method of every call. */
  function stubCalls() {
    const calls: { url: string; method?: string }[] = [];
    const fetch = async (url: unknown, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    (globalThis as unknown as { fetch: unknown }).fetch = fetch;
    return calls;
  }

  it('deletes through messages.trash', async () => {
    const calls = stubCalls();
    await client().updateFlags('m1', { trashed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/messages/m1/trash');
    expect(calls[0].method).toBe('POST');
  });

  it('restores through messages.untrash', async () => {
    const calls = stubCalls();
    await client().updateFlags('m1', { trashed: false });
    expect(calls[0].url).toContain('/messages/m1/untrash');
  });

  it('still applies the labels riding along with the move', async () => {
    // Opening a message and then deleting it produces both in one patch. The
    // move goes first and on its own, so the label edit cannot land on a
    // message the modify call would have had to find somewhere else.
    const calls = stubCalls();
    await client().updateFlags('m1', { trashed: true, unread: false });
    expect(calls.map((c) => c.url.split('/messages/')[1])).toEqual(['m1/trash', 'm1/modify']);
  });

  it('leaves the trash alone when no move was asked for', async () => {
    const calls = stubCalls();
    await client().updateFlags('m1', { starred: true });
    expect(calls.every((c) => !c.url.includes('trash'))).toBe(true);
  });
});
