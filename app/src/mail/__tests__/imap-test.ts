import { AuthError } from '../../auth/types';
import { createImapClient, ImapAccount, parseMessageId, threadRoot } from '../imap';
import { connectImap, ImapError } from '../imapConnection';
import { MailError } from '../types';
import { FakeImapServer, FakeSmtpServer } from './fakeServers';

const ADDRESS = 'me@example.org';

function account(overrides: Partial<ImapAccount> = {}): ImapAccount {
  return {
    imap: { host: 'imap.example.org', port: 993, security: 'tls' },
    smtp: { host: 'smtp.example.org', port: 465, security: 'tls' },
    username: ADDRESS,
    saveSentCopy: true,
    ...overrides,
  };
}

/** One client over both fakes, routing each connection by port. */
function setup(options: { imap?: FakeImapServer; smtp?: FakeSmtpServer; account?: Partial<ImapAccount>; password?: string } = {}) {
  const imap = options.imap ?? new FakeImapServer();
  const smtp = options.smtp ?? new FakeSmtpServer();
  const acct = account(options.account);
  const open = (target: { host: string; port: number; tls: boolean }) =>
    target.port === acct.smtp.port ? smtp.open(target) : imap.open(target);
  const client = createImapClient(ADDRESS, async () => ({ account: acct, password: options.password ?? 'secret' }), {
    open,
    idleMs: 5,
  });
  return { imap, smtp, client, acct };
}

const raw = (n: number, extra = '') =>
  [
    `From: Sender ${n} <s${n}@example.com>`,
    'To: me@example.org',
    `Subject: Message ${n}`,
    `Message-ID: <m${n}@example.com>`,
    'Date: Thu, 17 Sep 2026 10:00:00 +0000',
    extra,
    '',
    `Body ${n}`,
  ]
    .filter((l, i, all) => l !== '' || i === all.length - 2)
    .join('\r\n');

afterEach(() => {
  jest.useRealTimers();
});

describe('list', () => {
  it('returns rows newest first and pages by UID', async () => {
    const { imap, client } = setup();
    for (let n = 1; n <= 3; n++) imap.addMessage('INBOX', raw(n));

    const first = await client.list('inbox', { limit: 2 });
    expect(first.messages.map((m) => m.subject)).toEqual(['Message 3', 'Message 2']);
    expect(first.nextPageToken).toBeDefined();

    const second = await client.list('inbox', { limit: 2, pageToken: first.nextPageToken });
    expect(second.messages.map((m) => m.subject)).toEqual(['Message 1']);
    // Nothing older: an absent cursor is what ends paging.
    expect(second.nextPageToken).toBeUndefined();
  });

  it('decodes headers the way a provider API would have', async () => {
    const { imap, client } = setup();
    imap.addMessage(
      'INBOX',
      [
        'From: =?UTF-8?B?w5xiZXIgR3LDvMOfZQ==?= <UBER@Example.com>',
        'To: "Doe, Jane" <jane@example.org>, bob@example.org',
        'Subject: =?UTF-8?Q?Caf=C3=A9?= =?UTF-8?Q?_menu?=',
        'Message-ID: <reply@example.com>',
        'References: <root@example.com> <mid@example.com>',
        'Autocrypt: addr=uber@example.com; keydata=AAAA',
        '',
        'hi',
      ].join('\r\n'),
      { flags: ['\\Flagged'] },
    );

    const [row] = (await client.list('inbox')).messages;
    expect(row.from).toEqual({ address: 'uber@example.com', name: 'Über Grüße' });
    expect(row.to).toEqual(['jane@example.org', 'bob@example.org']);
    expect(row.subject).toBe('Café menu');
    expect(row.unread).toBe(true);
    expect(row.starred).toBe(true);
    expect(row.threadId).toBe('<root@example.com>');
    expect(row.autocrypt).toBe('addr=uber@example.com; keydata=AAAA');
    expect(row.labels).toEqual(['INBOX']);
    expect(row.date).toBe('2026-09-17T10:00:00.000Z');
  });

  it('finds special folders by attribute first, then by name', async () => {
    const imap = new FakeImapServer({ delimiter: '.' });
    imap.addBox('INBOX.Sent Items', ['\\Sent']);
    imap.addBox('INBOX.Junk');
    imap.addMessage('INBOX.Sent Items', raw(1));
    imap.addMessage('INBOX.Junk', raw(2));
    const { client } = setup({ imap });

    expect((await client.list('sent')).messages.map((m) => m.subject)).toEqual(['Message 1']);
    const spam = (await client.list('spam')).messages;
    expect(spam.map((m) => m.subject)).toEqual(['Message 2']);
    expect(spam[0].labels).toEqual(['JUNK']);
  });

  it('shows mail that arrived after the folder was first selected on this session', async () => {
    const { imap, client } = setup();
    expect((await client.list('inbox')).messages).toEqual([]);
    imap.addMessage('INBOX', raw(1));
    expect((await client.list('inbox')).messages.map((m) => m.subject)).toEqual(['Message 1']);
    expect(imap.connections).toBe(1);
  });

  it('answers an empty page for a folder the server does not have', async () => {
    const { client } = setup();
    expect(await client.list('archive')).toEqual({ messages: [] });
  });

  it('asks the server for the sync window', async () => {
    const { imap, client } = setup();
    imap.addMessage('INBOX', raw(1));
    await client.list('inbox', { newerThanDays: 30 });
    expect(imap.log.some((l) => /UID SEARCH UNDELETED SINCE \d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(l))).toBe(true);
  });

  it('asks the server for one sender, and refuses an address that could end the quoted string', async () => {
    const { imap, client } = setup();
    imap.addMessage('INBOX', raw(1));
    await client.list('inbox', { from: 'bob@example.com' });
    expect(imap.log.some((l) => l.includes('UID SEARCH UNDELETED FROM "bob@example.com"'))).toBe(true);

    const before = imap.log.length;
    expect(await client.list('inbox', { from: 'x" OR ALL "' })).toEqual({ messages: [] });
    expect(imap.log.slice(before).some((l) => l.includes('SEARCH'))).toBe(false);
  });

  it('runs overlapping lists one after another on one session', async () => {
    const imap = new FakeImapServer();
    imap.addBox('Junk', ['\\Junk']);
    imap.addMessage('INBOX', raw(1));
    imap.addMessage('Junk', raw(2));
    const { client } = setup({ imap });

    const [inbox, spam] = await Promise.all([client.list('inbox'), client.list('spam')]);
    expect(inbox.messages.map((m) => m.subject)).toEqual(['Message 1']);
    expect(spam.messages.map((m) => m.subject)).toEqual(['Message 2']);
    expect(imap.connections).toBe(1);
  });
});

describe('getRaw', () => {
  it('returns the message byte-for-byte, however many bytes its characters take', async () => {
    const { imap, client } = setup();
    const source = raw(1).replace('Body 1', 'Grüße 👋\r\n.\r\nline after a dot');
    imap.addMessage('INBOX', source);
    const [row] = (await client.list('inbox')).messages;
    expect(await client.getRaw(row.id)).toBe(source);
  });

  it('does not mark the message read', async () => {
    const { imap, client } = setup();
    const message = imap.addMessage('INBOX', raw(1));
    const [row] = (await client.list('inbox')).messages;
    await client.getRaw(row.id);
    expect(message.flags.has('\\Seen')).toBe(false);
  });
});

describe('updateFlags', () => {
  it('sets read and starred on the server', async () => {
    const { imap, client } = setup();
    const message = imap.addMessage('INBOX', raw(1));
    const [row] = (await client.list('inbox')).messages;

    await client.updateFlags(row.id, { unread: false, starred: true });
    expect([...message.flags].sort()).toEqual(['\\Flagged', '\\Seen']);
    await client.updateFlags(row.id, { starred: false });
    expect([...message.flags]).toEqual(['\\Seen']);
  });

  it('archives into a folder it creates, and the original id still undoes it', async () => {
    const { imap, client } = setup();
    imap.addMessage('INBOX', raw(1));
    const [row] = (await client.list('inbox')).messages;

    await client.updateFlags(row.id, { archived: true });
    expect(imap.log.some((l) => l.includes('CREATE "Archive"'))).toBe(true);
    expect(imap.boxes.get('INBOX')!.messages).toHaveLength(0);
    expect(imap.boxes.get('Archive')!.messages).toHaveLength(1);

    // The swipe's undo holds the inbox id, which named a UID that is now gone.
    await client.updateFlags(row.id, { archived: false });
    expect(imap.boxes.get('Archive')!.messages).toHaveLength(0);
    expect(imap.boxes.get('INBOX')!.messages).toHaveLength(1);
  });

  it('moves to the server-marked Trash and Junk', async () => {
    const imap = new FakeImapServer();
    imap.addBox('Deleted Messages', ['\\Trash']);
    imap.addBox('Spam', ['\\Junk']);
    imap.addMessage('INBOX', raw(1));
    imap.addMessage('INBOX', raw(2));
    const { client } = setup({ imap });
    const [second, first] = (await client.list('inbox')).messages;

    await client.updateFlags(first.id, { trashed: true });
    await client.updateFlags(second.id, { junk: true });
    expect(imap.boxes.get('Deleted Messages')!.messages.map((m) => m.raw)).toEqual([raw(1)]);
    expect(imap.boxes.get('Spam')!.messages.map((m) => m.raw)).toEqual([raw(2)]);
  });

  it('refuses to report a change to a message that is gone', async () => {
    const { imap, client } = setup();
    imap.addMessage('INBOX', raw(1));
    const [row] = (await client.list('inbox')).messages;
    imap.boxes.get('INBOX')!.messages = [];

    await expect(client.updateFlags(row.id, { unread: false })).rejects.toBeInstanceOf(MailError);
    await expect(client.updateFlags(row.id, { trashed: true })).rejects.toBeInstanceOf(MailError);
  });

  it('copies, flags and expunges only that UID on a server without MOVE', async () => {
    const imap = new FakeImapServer({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    imap.addBox('Trash', ['\\Trash']);
    imap.addMessage('INBOX', raw(1));
    const other = imap.addMessage('INBOX', raw(2), { flags: ['\\Deleted'] });
    const { client } = setup({ imap });
    const rows = (await client.list('inbox')).messages;
    expect(rows).toHaveLength(1); // the \Deleted one is not listed

    await client.updateFlags(rows[0].id, { trashed: true });
    expect(imap.log.some((l) => /UID EXPUNGE \d+$/.test(l))).toBe(true);
    expect(imap.log.some((l) => /\bEXPUNGE$/.test(l) && !l.includes('UID'))).toBe(false);
    // Someone else's pending deletion is left for them.
    expect(imap.boxes.get('INBOX')!.messages).toEqual([other]);
  });
});

describe('send', () => {
  const outgoing = [
    'From: me@example.org',
    'To: alice@example.com',
    'Cc: "Bob B" <bob@example.com>',
    'Bcc: carol@example.com',
    'Subject: [Encrypted message]',
    '',
    '-----BEGIN PGP MESSAGE-----',
    '.',
    '-----END PGP MESSAGE-----',
  ].join('\r\n');

  it('submits over SMTP without the Bcc line, then files a copy in Sent', async () => {
    const imap = new FakeImapServer();
    imap.addBox('Sent', ['\\Sent']);
    const { smtp, client } = setup({ imap });

    await client.send(outgoing);

    expect(smtp.messages).toHaveLength(1);
    const [delivered] = smtp.messages;
    expect(delivered.from).toBe('me@example.org');
    expect(delivered.recipients).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
    expect(delivered.data).not.toMatch(/^Bcc:/im);
    // Dot-stuffed on the wire, so a line of "." did not end the message early.
    expect(delivered.data).toContain('\r\n..\r\n');

    expect(imap.appended).toHaveLength(1);
    expect(imap.appended[0].box).toBe('Sent');
    expect(imap.appended[0].flags).toEqual(['\\Seen']);
    expect(imap.appended[0].raw).toBe(outgoing);
  });

  it('waits for the go-ahead before a literal when the server lacks LITERAL+', async () => {
    const imap = new FakeImapServer({ capabilities: ['IMAP4rev1', 'MOVE', 'UIDPLUS'] });
    imap.addBox('Sent', ['\\Sent']);
    const { client } = setup({ imap });
    await client.send(outgoing);
    expect(imap.appended[0].raw).toBe(outgoing);
  });

  it('does not file a copy when the server files its own', async () => {
    const imap = new FakeImapServer();
    imap.addBox('Sent', ['\\Sent']);
    const { client } = setup({ imap, account: { saveSentCopy: false } });
    await client.send(outgoing);
    expect(imap.appended).toHaveLength(0);
  });

  it('still counts as sent when the Sent copy cannot be filed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const imap = new FakeImapServer({ password: 'other' });
    const { smtp, client } = setup({ imap });
    // A throw here would make the outbox retry — and deliver twice.
    await expect(client.send(outgoing)).resolves.toBeUndefined();
    expect(smtp.messages).toHaveLength(1);
    warn.mockRestore();
  });

  it('fails the send when SMTP refuses a recipient, and delivers nothing', async () => {
    const { smtp, client } = setup({ smtp: new FakeSmtpServer({ rejectRecipient: 'bob@example.com' }) });
    await expect(client.send(outgoing)).rejects.toThrow(/bob@example.com/);
    expect(smtp.messages).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('reports a refused password as reauth-required', async () => {
    const { imap, client } = setup({ password: 'wrong' });
    imap.addMessage('INBOX', raw(1));
    const error = await client.list('inbox').catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('reauth-required');
  });

  it('does not treat a server that cannot check the password right now as a wrong password', async () => {
    const { client } = setup({ imap: new FakeImapServer({ loginFailureCode: 'UNAVAILABLE' }) });
    const error = await client.list('inbox').catch((e) => e);
    expect(error).toBeInstanceOf(MailError);
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it('reconnects once when the server dropped an idle session', async () => {
    const { imap, client } = setup();
    imap.addMessage('INBOX', raw(1));
    await client.list('inbox');
    imap.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect((await client.list('inbox')).messages).toHaveLength(1);
    expect(imap.connections).toBe(2);
  });

  it('sends a password it cannot quote as a literal', async () => {
    const imap = new FakeImapServer({ password: 'pä"ss\\word' });
    const { client } = setup({ imap, password: 'pä"ss\\word' });
    await expect(client.list('inbox')).resolves.toEqual({ messages: [] });
    expect(imap.log.some((l) => /LOGIN "me@example.org" \{\d+\+\}$/.test(l))).toBe(true);
  });
});

describe('STARTTLS', () => {
  const endpoint = { host: 'imap.example.org', port: 143, security: 'starttls' as const };

  it('upgrades before logging in, and never logs in in plaintext', async () => {
    const imap = new FakeImapServer({ starttls: true });
    const connection = await connectImap(imap.open, endpoint, ADDRESS, 'secret');
    expect(imap.log.filter((l) => l.startsWith('PLAIN:')).map((l) => l.split(' ')[2])).toEqual(['CAPABILITY', 'STARTTLS']);
    expect(imap.log.some((l) => l.startsWith('TLS:') && l.includes('LOGIN'))).toBe(true);
    await connection.logout();
  });

  it('refuses a server that does not offer STARTTLS, before any credential', async () => {
    const imap = new FakeImapServer({ starttls: false });
    const error = await connectImap(imap.open, endpoint, ADDRESS, 'secret').catch((e) => e);
    expect(error).toBeInstanceOf(ImapError);
    expect(error.message).toMatch(/does not offer STARTTLS/);
    expect(imap.log.some((l) => l.includes('LOGIN'))).toBe(false);
  });

  it.each([
    ['in the same packet as the OK', true],
    ['just after the OK', false],
  ])('drops a connection that sent plaintext after STARTTLS, %s', async (_, injectInSameChunk) => {
    const imap = new FakeImapServer({
      starttls: true,
      injectAfterStartTls: '* OK [CAPABILITY IMAP4rev1] injected\r\n',
      injectInSameChunk,
    });
    const error = await connectImap(imap.open, endpoint, ADDRESS, 'secret').catch((e) => e);
    expect(error).toBeInstanceOf(ImapError);
    expect(error.message).toMatch(/before the TLS handshake/);
    expect(imap.log.some((l) => l.includes('LOGIN'))).toBe(false);
  });
});

describe('ids and threads', () => {
  it('round-trips a folder name that itself contains colons', () => {
    expect(parseMessageId('7:42:Work:Clients')).toEqual({ uidValidity: 7, uid: 42, folder: 'Work:Clients' });
  });

  it('threads a reply under the first message it references', () => {
    expect(threadRoot({ references: '<a@x> <b@x>', 'message-id': '<c@x>' })).toBe('<a@x>');
    expect(threadRoot({ 'in-reply-to': '<b@x>', 'message-id': '<c@x>' })).toBe('<b@x>');
    expect(threadRoot({ 'message-id': '<c@x>' })).toBe('<c@x>');
    expect(threadRoot({})).toBeUndefined();
  });
});
