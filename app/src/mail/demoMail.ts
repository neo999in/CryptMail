/**
 * In-memory mailbox for demo mode: the three inbox states from the design
 * (encrypted+verified, encrypted+unverified, not encrypted), plus a working
 * Sent path so an end-to-end send can be walked through without Gmail.
 */
import { demoCore, fakePublicKey } from '../core/demoCore';
import { buildPlaintext, parseRfc822 } from '../core/mime';
import { parseAddress } from '../lib/format';
import { MailClient, MailSummary } from './types';

export const DEMO_ADDRESS = 'you@gmail.com';

export const demoContacts = {
  anya: {
    name: 'Anya Kessler',
    email: 'anya@partner.com',
    fingerprint: '4F2A9C71E3081BD577A03E6CB2940F8AD5C36A1982EF4471',
  },
  jordan: {
    name: 'Jordan Lee',
    email: 'jordan@lee.legal',
    fingerprint: '91C4D0A7761E5B3388F2C40D1A9E7735E60B84C2DD173F56',
  },
} as const;

export const demoContactKeys = {
  anya: fakePublicKey(demoContacts.anya.email, demoContacts.anya.fingerprint),
  jordan: fakePublicKey(demoContacts.jordan.email, demoContacts.jordan.fingerprint),
};

type Stored = { summary: MailSummary; raw: string };

export async function createDemoMailClient(address: string = DEMO_ADDRESS): Promise<MailClient> {
  const store: Stored[] = await seed(address);

  return {
    kind: 'demo',
    address,

    async listInbox(limit = 20) {
      await delay(220);
      return store
        .slice()
        .sort((a, b) => b.summary.date.localeCompare(a.summary.date))
        .slice(0, limit)
        .map((m) => m.summary);
    },

    async getRaw(id) {
      await delay(140);
      const found = store.find((m) => m.summary.id === id);
      if (!found) throw new Error(`No such message: ${id}`);
      return found.raw;
    },

    async send(rfc822) {
      await delay(420);
      // A sent message lands in the mailbox exactly as the provider stores it —
      // ciphertext included. That is the point of the demo.
      store.unshift(toStored(`sent-${store.length + 1}`, rfc822, false));
    },

    async updateFlags(id, patch) {
      await delay(120);
      const idx = store.findIndex((m) => m.summary.id === id);
      if (idx === -1) return;
      if (patch.archived) {
        store.splice(idx, 1);
        return;
      }
      const summary = store[idx].summary;
      if (patch.unread !== undefined) summary.unread = patch.unread;
      if (patch.starred !== undefined) summary.starred = patch.starred;
    },
  };
}

async function seed(address: string): Promise<Stored[]> {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  const fromAnya = await demoCore.buildEncrypted({
    from: `${demoContacts.anya.name} <${demoContacts.anya.email}>`,
    to: [address],
    subject: 'Q3 board deck — final numbers',
    body:
      "Numbers are locked — revenue is up 18% QoQ and we're ahead on net retention.\n\n" +
      "Deck attached. Let's keep this one between us until Thursday.",
    recipientKeys: [demoContactKeys.anya],
    autocryptKey: demoContactKeys.anya,
  });

  const jordanReply = await demoCore.buildEncrypted({
    from: `${demoContacts.jordan.name} <${demoContacts.jordan.email}>`,
    to: [address],
    subject: 'Re: contract redlines',
    body: 'Thanks — one more change on clause 4 and I think we are done. Call at 3?',
    recipientKeys: [demoContactKeys.jordan],
    autocryptKey: demoContactKeys.jordan,
  });

  const jordanOriginal = await demoCore.buildEncrypted({
    from: `${demoContacts.jordan.name} <${demoContacts.jordan.email}>`,
    to: [address],
    subject: 'contract redlines',
    body: 'First pass of redlines attached — clauses 3 and 4 are the ones to look at. Thoughts?',
    recipientKeys: [demoContactKeys.jordan],
    autocryptKey: demoContactKeys.jordan,
  });

  const newsletter = buildPlaintext({
    from: 'Newsletter <digest@weekly.example>',
    to: [address],
    subject: 'Your weekly digest',
    body: 'This one is not encrypted — it was sent by someone who is not a CipherMail user.',
  });

  return [
    toStored('demo-1', fromAnya, true, 'thr-q3board', at(41)),
    toStored('demo-2', jordanReply, true, 'thr-redlines', at(130)),
    toStored('demo-2a', jordanOriginal, false, 'thr-redlines', at(200)),
    toStored('demo-3', newsletter, false, undefined, at(60 * 26)),
  ];
}

function toStored(id: string, raw: string, unread: boolean, threadId?: string, date?: string): Stored {
  const { headers } = parseRfc822(raw);
  const from = parseAddress(headers['from'] ?? '');
  const encrypted = demoCore.looksEncrypted(raw);
  return {
    raw,
    summary: {
      id,
      threadId,
      from,
      to: (headers['to'] ?? '').split(',').map((a) => parseAddress(a).address),
      date: date ?? new Date(headers['date'] ?? Date.now()).toISOString(),
      subject: headers['subject'] ?? '(no subject)',
      snippet: encrypted ? 'Encrypted — open to decrypt on this device.' : firstLine(raw),
      unread,
      starred: false,
    },
  };
}

function firstLine(raw: string): string {
  const { body } = parseRfc822(raw);
  return body.split('\n').find((l) => l.trim().length > 0)?.slice(0, 120) ?? '';
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
