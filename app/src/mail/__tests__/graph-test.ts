/**
 * What the Graph connector asks Microsoft for.
 *
 * As with `gmail-test.ts`, the requests are the whole of what this app controls,
 * so the requests are what these pin: which folder, which headers, which verb.
 * Nothing about Graph's own behaviour is asserted.
 */
import { AuthError } from '../../auth/types';
import { providerFiledAsJunk } from '../../categorizer/categorizer';
import { base64ToBytes, bytesToUtf8 } from '../../lib/base64';
import { createGraphClient } from '../graph';
import { Mailbox } from '../types';

type Asked = { url: string; init: RequestInit & { headers?: Record<string, string> } };

const original = globalThis.fetch;

function stubGraph(answer: { status?: number; json?: unknown; text?: string } = {}) {
  const asked: Asked[] = [];
  const fetch = async (url: unknown, init: RequestInit = {}) => {
    asked.push({ url: String(url), init: init as Asked['init'] });
    const status = answer.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => answer.json ?? { value: [] },
      text: async () => answer.text ?? '',
    };
  };
  (globalThis as unknown as { fetch: unknown }).fetch = fetch;
  return asked;
}

const client = () => createGraphClient('me@outlook.com', async () => 'access-token');

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = original;
});

describe('the folder per mailbox', () => {
  it.each([
    ['inbox', 'inbox'],
    ['sent', 'sentitems'],
    ['archive', 'archive'],
    ['spam', 'junkemail'],
    ['trash', 'deleteditems'],
  ] as [Mailbox, string][])('lists %s from the well-known %s folder', async (box, folder) => {
    const asked = stubGraph();
    await client().list(box);
    expect(asked[0].url).toContain(`/me/mailFolders/${folder}/messages?`);
  });

  it('adds the sync window as a filter on the property it orders by, and only when set', async () => {
    const asked = stubGraph();
    await client().list('inbox', { newerThanDays: 30 });
    await client().list('inbox');

    expect(decodeURIComponent(asked[0].url)).toMatch(/\$filter=receivedDateTime ge \d{4}-/);
    expect(asked[1].url).not.toContain('$filter');
  });
});

describe('a sender search', () => {
  it('filters on the sender after the ordered property, escaping a quote', async () => {
    const asked = stubGraph();
    await client().list('inbox', { from: "o'brien@example.com" });

    expect(decodeURIComponent(asked[0].url)).toContain(
      "$filter=receivedDateTime ge 1970-01-01T00:00:00Z and from/emailAddress/address eq 'o''brien@example.com'",
    );
  });
});

describe('every request', () => {
  /**
   * Archive and delete are moves in Exchange, and a move re-mints a message's
   * id unless the request asked for immutable ones. Missing it on any call would
   * leave the app holding ids that stop naming anything after a swipe.
   */
  it('asks for immutable ids', async () => {
    const asked = stubGraph();
    const c = client();
    await c.list('inbox');
    await c.updateFlags('abc', { archived: true, starred: true });
    await c.send('From: me@outlook.com\r\n\r\nhi');

    expect(asked.length).toBeGreaterThanOrEqual(4);
    for (const { init } of asked) expect(init.headers?.Prefer).toBe('IdType="ImmutableId"');
  });

  it('reports a rejected token as a sign-in to redo, not a status code', async () => {
    stubGraph({ status: 401 });
    const error = await client().list('inbox').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('reauth-required');
  });
});

describe('paging', () => {
  it('follows the cursor Graph handed back', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=xyz';
    const asked = stubGraph({ json: { value: [], '@odata.nextLink': next } });

    const first = await client().list('inbox');
    await client().list('inbox', { pageToken: first.nextPageToken });

    expect(first.nextPageToken).toBe(next);
    expect(asked[1].url).toBe(next);
  });

  /** The request carries the mailbox's bearer token; a foreign cursor would hand it over. */
  it('refuses a cursor that leaves Graph, without sending anything', async () => {
    const asked = stubGraph();
    await expect(client().list('inbox', { pageToken: 'https://evil.example/steal' })).rejects.toThrow(/leaves Microsoft Graph/);
    expect(asked).toHaveLength(0);
  });
});

describe('a list row', () => {
  const row = {
    id: 'AAk=',
    conversationId: 'conv-1',
    from: { emailAddress: { name: 'Alice', address: 'Alice@Example.com' } },
    toRecipients: [{ emailAddress: { address: 'me@outlook.com' } }],
    receivedDateTime: '2026-09-01T10:00:00Z',
    subject: '[Encrypted message]',
    bodyPreview: '-----BEGIN PGP MESSAGE-----',
    isRead: false,
    flag: { flagStatus: 'flagged' },
    internetMessageId: '<m1@example.com>',
    internetMessageHeaders: [
      { name: 'Autocrypt', value: 'addr=alice@example.com; keydata=AAAA' },
      { name: 'References', value: '<m0@example.com>' },
    ],
  };

  it('carries the cleartext headers the sync reads, Autocrypt above all', async () => {
    stubGraph({ json: { value: [row] } });
    const [summary] = (await client().list('inbox')).messages;

    expect(summary).toMatchObject({
      id: 'AAk=',
      threadId: 'conv-1',
      from: { address: 'alice@example.com', name: 'Alice' },
      to: ['me@outlook.com'],
      unread: true,
      starred: true,
      messageId: '<m1@example.com>',
      references: '<m0@example.com>',
      autocrypt: 'addr=alice@example.com; keydata=AAAA',
    });
  });

  /** Otherwise the categoriser would un-hide Outlook's junk into Primary. */
  it('marks mail from the junk folder as junk', async () => {
    stubGraph({ json: { value: [row] } });
    const [junk] = (await client().list('spam')).messages;
    stubGraph({ json: { value: [row] } });
    const [inbox] = (await client().list('inbox')).messages;

    expect(providerFiledAsJunk(junk.labels)).toBe(true);
    expect(providerFiledAsJunk(inbox.labels)).toBe(false);
  });
});

describe('the MIME source', () => {
  it('reads a message from $value, never from the JSON rendering', async () => {
    const asked = stubGraph({ text: 'Content-Type: multipart/encrypted\r\n\r\n...' });
    const raw = await client().getRaw('AAk=');

    expect(asked[0].url).toMatch(/\/me\/messages\/AAk%3D\/\$value$/);
    expect(raw).toContain('multipart/encrypted');
  });

  it('sends MIME as base64 in a text/plain body', async () => {
    const asked = stubGraph();
    const mime = 'From: me@outlook.com\r\nSubject: [Encrypted message]\r\n\r\nbody';
    await client().send(mime);

    expect(asked[0].url).toMatch(/\/me\/sendMail$/);
    expect(asked[0].init.method).toBe('POST');
    expect(asked[0].init.headers?.['Content-Type']).toBe('text/plain');
    expect(bytesToUtf8(base64ToBytes(String(asked[0].init.body)))).toBe(mime);
  });
});

describe('flags', () => {
  const bodies = (asked: Asked[]) => asked.map((a) => [a.init.method, a.url.replace(/^.*\/v1\.0\/me/, ''), a.init.body]);

  it('stars and reads with a PATCH, and moves nothing', async () => {
    const asked = stubGraph();
    await client().updateFlags('id1', { starred: true, unread: false });

    expect(bodies(asked)).toEqual([
      ['PATCH', '/messages/id1', JSON.stringify({ isRead: true, flag: { flagStatus: 'flagged' } })],
    ]);
  });

  it('archives into the archive folder, which is where Outlook itself puts it', async () => {
    const asked = stubGraph();
    await client().updateFlags('id1', { archived: true });
    expect(bodies(asked)).toEqual([['POST', '/messages/id1/move', JSON.stringify({ destinationId: 'archive' })]]);
  });

  it('lets trash win over archive, and restores either to the inbox', async () => {
    const asked = stubGraph();
    await client().updateFlags('id1', { trashed: true, archived: true });
    await client().updateFlags('id1', { trashed: false });
    await client().updateFlags('id1', { archived: false });

    expect(asked.map((a) => JSON.parse(String(a.init.body)).destinationId)).toEqual(['deleteditems', 'inbox', 'inbox']);
  });

  /** Mark as spam and Not spam, pushed to where the mail lives. */
  it('files junk into the junk folder, and rescues it to the inbox', async () => {
    const asked = stubGraph();
    await client().updateFlags('id1', { junk: true });
    await client().updateFlags('id1', { junk: false });

    expect(bodies(asked)).toEqual([
      ['POST', '/messages/id1/move', JSON.stringify({ destinationId: 'junkemail' })],
      ['POST', '/messages/id1/move', JSON.stringify({ destinationId: 'inbox' })],
    ]);
  });

  it('makes one move per patch: trash over junk, junk over archive', async () => {
    const asked = stubGraph();
    await client().updateFlags('id1', { trashed: true, junk: true });
    await client().updateFlags('id1', { junk: true, archived: true });

    expect(asked.map((a) => JSON.parse(String(a.init.body)).destinationId)).toEqual(['deleteditems', 'junkemail']);
  });
});
