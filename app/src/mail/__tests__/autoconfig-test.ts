import { discoverSettings, guessSettings, parseAutoconfig } from '../autoconfig';
import { certificateMatchesHost } from '../socket';

const ISPDB = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.net">
    <incomingServer type="pop3">
      <hostname>pop.example.net</hostname><port>995</port><socketType>SSL</socketType>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.net</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.net</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.%EMAILDOMAIN%</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe('parseAutoconfig', () => {
  it('prefers TLS from the first byte, and fills in the placeholders', () => {
    expect(parseAutoconfig(ISPDB, 'Jane@Example.net')).toEqual({
      imap: { host: 'imap.example.net', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.net', port: 587, security: 'starttls' },
      username: 'Jane',
      saveSentCopy: true,
    });
  });

  it('never offers a plaintext server', () => {
    const plain = ISPDB.replace(/<socketType>(SSL|STARTTLS)<\/socketType>/g, '<socketType>plain</socketType>');
    expect(parseAutoconfig(plain, 'jane@example.net')).toBeNull();
  });

  it('skips a server that only takes OAuth, since a password cannot sign in to it', () => {
    const oauth = ISPDB.replace(/password-cleartext/g, 'OAuth2');
    expect(parseAutoconfig(oauth, 'jane@example.net')).toBeNull();
  });

  it('knows which servers file their own sent copy', () => {
    const gmail = ISPDB.replace('smtp.%EMAILDOMAIN%', 'smtp.gmail.com');
    expect(parseAutoconfig(gmail, 'jane@example.net')?.saveSentCopy).toBe(false);
  });
});

describe('discoverSettings', () => {
  const reply = (body: string | null) =>
    Promise.resolve(body === null ? ({ ok: false, text: async () => '' } as Response) : ({ ok: true, text: async () => body } as Response));

  it('asks the provider first and trusts it over the ISPDB', async () => {
    const provider = ISPDB.replace(/imap\.example\.net/g, 'mail.example.net');
    const urls: string[] = [];
    const found = await discoverSettings('jane@example.net', (url) => {
      urls.push(url);
      return reply(url.startsWith('https://autoconfig.example.net/') ? provider : url.includes('thunderbird') ? ISPDB : null);
    });
    expect(found.source).toBe('provider');
    expect(found.account.imap.host).toBe('mail.example.net');
    // HTTPS only, and Mozilla is told the domain — never the address.
    expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
    expect(urls.filter((u) => u.includes('thunderbird'))).toEqual(['https://autoconfig.thunderbird.net/v1.1/example.net']);
  });

  it('falls back to the ISPDB, then to a guess', async () => {
    expect((await discoverSettings('jane@example.net', (url) => reply(url.includes('thunderbird') ? ISPDB : null))).source).toBe('ispdb');

    const guessed = await discoverSettings('jane@example.net', () => Promise.reject(new Error('offline')));
    expect(guessed).toEqual({ account: guessSettings('jane@example.net'), source: 'guess' });
    expect(guessed.account.imap).toEqual({ host: 'imap.example.net', port: 993, security: 'tls' });
  });
});

describe('certificateMatchesHost', () => {
  it.each([
    ['imap.example.org', 'imap.example.org', true],
    ['IMAP.Example.org', 'imap.example.org.', true],
    ['*.example.org', 'imap.example.org', true],
    ['*.example.org', 'example.org', false],
    ['*.example.org', 'a.b.example.org', false],
    ['*.example.org', 'imap.example.org.evil.com', false],
    ['imap.evil.com', 'imap.example.org', false],
    ['*.1.2.3', '4.1.2.3', false],
    [undefined, 'imap.example.org', false],
  ])('CN %s for host %s → %s', (cn, host, expected) => {
    expect(certificateMatchesHost(cn, host)).toBe(expected);
  });
});
