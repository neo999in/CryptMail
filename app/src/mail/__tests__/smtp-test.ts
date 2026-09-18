import { bytesToUtf8 } from '../../lib/base64';
import { dataFor, envelopeOf, sendSmtp, SmtpError, verifySmtp } from '../smtp';
import { FakeSmtpServer } from './fakeServers';

const message = [
  'From: "Me" <me@example.org>',
  'To: alice@example.com',
  'Bcc: carol@example.com,',
  ' dave@example.com',
  'Subject: hi',
  '',
  '.leading dot',
  'end',
].join('\n');

describe('the message on the wire', () => {
  it('reads the envelope from To, Cc and Bcc, including a folded Bcc', () => {
    expect(envelopeOf(message)).toEqual({
      from: 'me@example.org',
      recipients: ['alice@example.com', 'carol@example.com', 'dave@example.com'],
    });
  });

  it('drops the Bcc header and its continuation, uses CRLF, and dot-stuffs', () => {
    const data = bytesToUtf8(dataFor(message));
    expect(data).not.toMatch(/bcc|carol|dave/i);
    expect(data).toBe('From: "Me" <me@example.org>\r\nTo: alice@example.com\r\nSubject: hi\r\n\r\n..leading dot\r\nend\r\n.\r\n');
  });
});

describe('a session', () => {
  const tls = { host: 'smtp.example.org', port: 465, security: 'tls' as const };
  const starttls = { host: 'smtp.example.org', port: 587, security: 'starttls' as const };

  it('authenticates with PLAIN and delivers to every envelope recipient', async () => {
    const server = new FakeSmtpServer();
    await sendSmtp(server.open, tls, 'me@example.org', 'secret', message);
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0].recipients).toEqual(['alice@example.com', 'carol@example.com', 'dave@example.com']);
    // Not the device's name: it would land in every recipient's Received header.
    expect(server.log.find((l) => l.includes('EHLO'))).toBe('TLS: EHLO [127.0.0.1]');
  });

  it('falls back to LOGIN when PLAIN is not offered', async () => {
    const server = new FakeSmtpServer({ auth: ['LOGIN'] });
    await sendSmtp(server.open, tls, 'me@example.org', 'secret', message);
    expect(server.messages).toHaveLength(1);
  });

  it('reports a refused password as an auth failure, having sent nothing', async () => {
    const server = new FakeSmtpServer({ password: 'other' });
    const error = await sendSmtp(server.open, tls, 'me@example.org', 'secret', message).catch((e) => e);
    expect(error).toBeInstanceOf(SmtpError);
    expect(error.kind).toBe('auth');
    expect(server.log.some((l) => l.includes('MAIL FROM'))).toBe(false);
  });

  it('upgrades with STARTTLS before authenticating', async () => {
    const server = new FakeSmtpServer({ starttls: true });
    await verifySmtp(server.open, starttls, 'me@example.org', 'secret');
    const auth = server.log.find((l) => l.includes('AUTH'));
    expect(auth?.startsWith('TLS:')).toBe(true);
  });

  it('refuses a server that does not offer STARTTLS, before any credential', async () => {
    const server = new FakeSmtpServer({ starttls: false });
    const error = await verifySmtp(server.open, starttls, 'me@example.org', 'secret').catch((e) => e);
    expect(error.message).toMatch(/does not offer STARTTLS/);
    expect(server.log.some((l) => l.includes('AUTH'))).toBe(false);
  });

  it('will not put an address that could carry a second command on the wire', async () => {
    const server = new FakeSmtpServer();
    const evil = message.replace('To: alice@example.com', 'To: <alice@example.com>\r\nRCPT TO:<x@evil.example>');
    const hostile = message.replace('To: alice@example.com', 'To: "x" <a b@example.com>');
    await expect(sendSmtp(server.open, tls, 'me@example.org', 'secret', hostile)).rejects.toThrow(/not an address/);
    // The CRLF variant never parses as a recipient at all: header lines are split first.
    expect(envelopeOf(evil).recipients).not.toContain('x@evil.example');
  });
});
