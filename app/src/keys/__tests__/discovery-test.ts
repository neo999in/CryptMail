/**
 * Key discovery against a stubbed transport — no network, ever.
 *
 * The distinction these tests exist to protect: `null` means *nobody has
 * published a key for this address*, and a thrown `DiscoveryError` means *we
 * could not find out*. The send path treats the first as "invite them and wait"
 * and must never treat a keyserver being down as the same thing.
 */
import { utf8ToBytes } from '../../lib/base64';
import { ADA_ARMORED } from '../../pgp/__tests__/fixtures';
import {
  DiscoveryError,
  Fetcher,
  LOOKUP_TIMEOUT_MS,
  lookupKey,
  PUBLISH_TIMEOUT_MS,
  publishKey,
  vksLookupUrl,
  wkdUrls,
} from '../discovery';
import { zBase32Sha1 } from '../zbase32';

const bytes = (text: string) => {
  const b = utf8ToBytes(text);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** Answers from a table of url-substring → response; anything else is a 404. */
function stub(routes: { match: string; status?: number; body?: string; throws?: Error }[]) {
  const calls: string[] = [];
  const fetch: Fetcher = async (url) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (route?.throws) throw route.throws;
    const status = route ? (route.status ?? 200) : 404;
    const body = route?.body ?? '';
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      arrayBuffer: async () => bytes(body),
    };
  };
  return { fetch, calls };
}

const deps = (routes: Parameters<typeof stub>[0]) => ({ ...stub(routes), timeoutMs: 50 });

describe('lookupKey', () => {
  it('returns the key VKS serves, tagged with its source', async () => {
    const found = await lookupKey('ada@example.com', deps([{ match: 'by-email', body: ADA_ARMORED }]));
    expect(found?.source).toBe('vks');
    expect(found?.armored).toContain('BEGIN PGP PUBLIC KEY BLOCK');
  });

  it('returns null when nothing is published anywhere — a normal outcome', async () => {
    await expect(lookupKey('nobody@example.com', deps([]))).resolves.toBeNull();
  });

  it('falls through to WKD when VKS has nothing', async () => {
    const d = deps([{ match: '.well-known/openpgpkey', body: ADA_ARMORED }]);
    const found = await lookupKey('ada@example.com', d);
    expect(found?.source).toBe('wkd');
    expect(d.calls[0]).toContain('keys.openpgp.org');
  });

  it('armors the binary key WKD actually serves', async () => {
    // WKD hands back key packets, not text. The packet reader only speaks armor.
    const binary = new Uint8Array([0x99, 0x01, 0x0d, 0x04, 0xff]);
    const fetch: Fetcher = async (url) => ({
      ok: !url.includes('by-email'),
      status: url.includes('by-email') ? 404 : 200,
      text: async () => '',
      arrayBuffer: async () => binary.buffer.slice(0) as ArrayBuffer,
    });
    const found = await lookupKey('ada@example.com', { fetch });
    expect(found?.armored.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toBe(true);
    expect(found?.armored).toContain('mQEN');
  });

  it('throws rather than reporting "no key" when no source could be reached', async () => {
    const unreachable = new Error('Network request failed');
    const d = deps([
      { match: 'by-email', throws: unreachable },
      { match: '.well-known', throws: unreachable },
    ]);
    await expect(lookupKey('ada@example.com', d)).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('reports a server error as a failure, not as an absence', async () => {
    const d = deps([
      { match: 'by-email', status: 503 },
      { match: '.well-known', status: 503 },
    ]);
    await expect(lookupKey('ada@example.com', d)).rejects.toMatchObject({ code: 'server' });
  });

  it('settles instead of hanging when the keyserver never answers', async () => {
    const fetch: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    await expect(lookupKey('ada@example.com', { fetch, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('reports our own deadline as a timeout however the platform words it', async () => {
    // React Native rejects an aborted fetch as a plain Error reading "Fetch
    // request has been canceled" — no `AbortError` name anywhere. Recognising
    // the deadline by the shape of the error means the platform gets to decide
    // whether our own timeout is understood, and on a phone it was not: the
    // user saw the raw platform string instead of being told the keyserver was
    // slow. What we know for certain is that *we* aborted it.
    const fetch: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('fetch failed: Fetch request has been canceled')),
        );
      });
    await expect(lookupKey('ada@example.com', { fetch, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('did not answer in time'),
    });
  });

  it('treats a 404 from one source and a failure from another as "not published"', async () => {
    // VKS is authoritative about *its* answer; a WKD host that is simply absent
    // must not turn a clean "no key" into an error the user cannot act on.
    const d = deps([{ match: '.well-known', throws: new Error('DNS failure') }]);
    await expect(lookupKey('ada@example.com', d)).resolves.toBeNull();
  });

  it('does not let a WKD 404 mask a VKS that could not be reached', async () => {
    // The inverse of the case above, and the one that matters: most domains
    // publish no WKD at all, so a 404 there is the norm. If that counted as a
    // definite "nobody has a key", every keyserver outage would be reported to
    // the user as "this person does not use encryption" — and the message would
    // sit in the queue forever waiting for a key that was there all along.
    const d = deps([{ match: 'by-email', throws: new Error('Network request failed') }]);
    await expect(lookupKey('ada@example.com', d)).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('does not let a WKD 404 mask a VKS timeout', async () => {
    const d = deps([{ match: 'by-email', status: 503 }]);
    await expect(lookupKey('ada@example.com', d)).rejects.toMatchObject({ code: 'server' });
  });
});

describe('url construction', () => {
  it('escapes the address in the VKS URL', () => {
    expect(vksLookupUrl('a+b@example.com')).toBe(
      'https://keys.openpgp.org/vks/v1/by-email/a%2Bb%40example.com',
    );
  });

  it('builds both WKD URLs with the hashed local part', () => {
    // The published test vector from the WKD draft: "Joe.Doe" hashes to this.
    expect(zBase32Sha1('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    expect(wkdUrls('Joe.Doe@Example.ORG')).toEqual([
      'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=joe.doe',
      'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=joe.doe',
    ]);
  });
});

describe('publishKey', () => {
  it('uploads, then asks for the confirmation email', async () => {
    const d = deps([
      { match: 'upload', body: JSON.stringify({ token: 'tok', status: { 'ada@example.com': 'unpublished' } }) },
      { match: 'request-verify', body: JSON.stringify({ status: { 'ada@example.com': 'pending' } }) },
    ]);
    await expect(publishKey(ADA_ARMORED, 'ada@example.com', d)).resolves.toEqual({
      status: 'pending-verification',
    });
    expect(d.calls.some((u) => u.includes('/vks/v1/upload'))).toBe(true);
    expect(d.calls.some((u) => u.includes('/vks/v1/request-verify'))).toBe(true);
  });

  it('reports an address the keyserver already serves as published', async () => {
    const d = deps([
      { match: 'upload', body: JSON.stringify({ token: 'tok', status: { 'ada@example.com': 'published' } }) },
    ]);
    await expect(publishKey(ADA_ARMORED, 'ada@example.com', d)).resolves.toEqual({ status: 'published' });
  });

  it('surfaces a rejected upload rather than claiming success', async () => {
    const d = deps([{ match: 'upload', status: 400, body: 'bad key' }]);
    await expect(publishKey(ADA_ARMORED, 'ada@example.com', d)).rejects.toBeInstanceOf(DiscoveryError);
  });

  it("repeats the keyserver's own reason for refusing a key", async () => {
    // VKS explains a rejection in a JSON `error` field, and that sentence is the
    // whole diagnosis — "unsupported key version" and "malformed" send the user
    // somewhere completely different. A bare status code sends them nowhere.
    const d = deps([
      { match: 'upload', status: 400, body: JSON.stringify({ error: 'unsupported key version' }) },
    ]);
    await expect(publishKey(ADA_ARMORED, 'ada@example.com', d)).rejects.toMatchObject({
      message: expect.stringContaining('unsupported key version'),
    });
  });

  it("does not double the full stop the keyserver already wrote", async () => {
    const d = deps([
      {
        match: 'upload',
        status: 400,
        body: JSON.stringify({ error: 'OpenPGP v6 (RFC 9580) is not yet supported.' }),
      },
    ]);
    await expect(publishKey(ADA_ARMORED, 'ada@example.com', d)).rejects.toMatchObject({
      message: 'Key upload failed (400): OpenPGP v6 (RFC 9580) is not yet supported.',
    });
  });

  it('waits longer than a lookup does, because a person asked for this one', async () => {
    // A lookup runs while someone types and has to give up quickly. Publishing
    // is a button press whose whole purpose is the round trip, and it uploads a
    // far larger key than a lookup downloads. Six seconds is a typing budget,
    // not a keyserver's: measured from here, keys.openpgp.org takes upwards of
    // fifteen.
    const budgets: number[] = [];
    const fetch: Fetcher = async (url, init) => {
      init?.signal?.addEventListener('abort', () => undefined);
      budgets.push(Date.now());
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: 't', status: { 'ada@example.com': 'published' } }),
        arrayBuffer: async () => bytes(''),
      };
    };
    await publishKey(ADA_ARMORED, 'ada@example.com', { fetch });
    expect(PUBLISH_TIMEOUT_MS).toBeGreaterThan(LOOKUP_TIMEOUT_MS);
    expect(budgets).toHaveLength(1);
  });

  it('still reports a status when the body explains nothing', async () => {
    const d = deps([{ match: 'upload', status: 503, body: '<html>maintenance</html>' }]);
    await expect(publishKey(ADA_ARMORED, 'ada@example.com', d)).rejects.toMatchObject({
      message: expect.stringContaining('503'),
    });
  });
});
