/**
 * In-memory mailbox for demo mode: the three inbox states from the design
 * (encrypted+verified, encrypted+unverified, not encrypted), plus a working
 * Sent path so an end-to-end send can be walked through without Gmail.
 *
 * ## Why the fixtures depend on which core is loaded
 *
 * The encrypted fixtures below are built by `demoCore` — base64 behind a
 * `CRYPTMAIL-DEMO-V1:` tag — and are encrypted "from" contacts whose armor is
 * `fakePublicKey()` output. A real core can do nothing with either: it rejects
 * the fake keys as malformed and cannot decrypt the fake ciphertext.
 *
 * They also cannot simply be re-made for a real core. Producing genuine
 * ciphertext *from* Anya requires Anya's private key, and the demo does not have
 * one — inventing it would mean shipping a private key in the repo.
 *
 * So with a native core the mailbox serves only what stays true: the plaintext
 * fixtures, plus a message explaining the absence. Encrypted demo mail then
 * comes from actually sending one, which round-trips through the real core and
 * is a better demonstration anyway.
 *
 * ## The filter fixtures
 *
 * Three plaintext messages exist for the spam engine rather than for the crypto:
 * one phishing attempt, one bulk-mail blast, and one perfectly legitimate
 * security notice that says *verify*, *account* and *password*. The third is the
 * important one — it is the shape of mail a keyword filter ruins, so having it in
 * the demo inbox means a regression in the false-positive direction is visible
 * without a Gmail account. Every URL in them is on a `.example`/`.invalid`
 * domain, which cannot resolve; nothing here is ever fetched in any case.
 */
import { core } from '../core';
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

export async function createDemoMailClient(
  address: string = DEMO_ADDRESS,
  /**
   * Whether to include fixtures `demoCore` encrypted. Defaults to "only when
   * the demo core is the one that would have to read them back". Injectable so
   * tests can drive both shapes without a native module.
   */
  includeDemoCiphertext: boolean = core.kind === 'demo',
): Promise<MailClient> {
  const store: Stored[] = await seed(address, includeDemoCiphertext);

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

async function seed(address: string, includeDemoCiphertext: boolean): Promise<Stored[]> {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  const newsletter = buildPlaintext({
    from: 'Newsletter <digest@weekly.example>',
    to: [address],
    subject: 'Your weekly digest',
    body: 'This one is not encrypted — it was sent by someone who is not a CryptMail user.',
  });

  const filterFixtures = spamFixtures(address, at);

  if (!includeDemoCiphertext) {
    // Say plainly why the inbox is thinner than the design shows, rather than
    // presenting an empty mailbox or a row that fails to open.
    const explanation = buildPlaintext({
      from: 'CryptMail <demo@cryptmail.invalid>',
      to: [address],
      subject: 'Demo mail, real encryption',
      body:
        'The real crypto core is loaded, so the demo cannot fake encrypted mail for you.\n\n' +
        'The sample encrypted messages were produced by the demo core and are not real ' +
        'ciphertext; a real core correctly refuses to read them. Making genuine ones would ' +
        "need the sender's private key, which the demo does not have and should not ship.\n\n" +
        'Compose a message to yourself instead — it will be encrypted and decrypted for real.',
    });
    return [
      toStored('demo-note', explanation, true, undefined, at(5)),
      toStored('demo-3', newsletter, false, undefined, at(60 * 26)),
      ...filterFixtures,
    ];
  }

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

  return [
    toStored('demo-1', fromAnya, true, 'thr-q3board', at(41)),
    toStored('demo-2', jordanReply, true, 'thr-redlines', at(130)),
    toStored('demo-2a', jordanOriginal, false, 'thr-redlines', at(200)),
    toStored('demo-3', newsletter, false, undefined, at(60 * 26)),
    ...filterFixtures,
  ];
}

/**
 * Three messages for the filter: one phishing, one bulk blast, one legitimate
 * security notice that a keyword filter would ruin.
 *
 * `demo-legit-security` is deliberately the hardest case in the mailbox. It says
 * *password*, *verify*, *sign-in* and *account*, and it must still land in
 * Primary — it passes SPF, DKIM and DMARC, its links point at the domain it was
 * sent from, and it names the reader. If it ever shows up under Spam, the engine
 * has regressed towards keyword matching, which is the failure mode that matters
 * most.
 *
 * Hosts are `.example`/`.invalid` (RFC 2606/6761 — permanently unresolvable), so
 * even a mistaken fetch could not reach anything. The engine never fetches.
 */
function spamFixtures(address: string, at: (minutesAgo: number) => string): Stored[] {
  // Phishing: a lookalike domain, a display name claiming a brand it does not own,
  // a Reply-To on free mail, a failing DMARC, and a link whose text lies about
  // where it goes. No single one of those decides it — together they are the shape.
  const phishing = withHeaders(
    buildPlaintext({
      from: 'PayPal Service <security@paypa1-verify.example>',
      to: [address],
      subject: 'Urgent: your account will be suspended within 24 hours',
      body:
        'Dear Customer,\n\n' +
        'We detected unusual activity on your account. Your account will be locked ' +
        'unless you confirm your identity immediately.\n\n' +
        'Verify now: http://198.51.100.24/paypal/login/verify?session=8f21\n\n' +
        'Failure to act will result in permanent suspension.\n\n' +
        'PayPal Security Team',
    }),
    [
      'Reply-To: paypal.support.recovery@gmail.com',
      'Return-Path: <bounce@mailer-9931.example>',
      'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=paypa1-verify.example; ' +
        'dkim=none; dmarc=fail header.from=paypa1-verify.example',
    ],
  );

  // Bulk mail: shouting, prize language and a payment, which is spam without being
  // an impersonation. It carries List-Unsubscribe and passes SPF, so the engine has
  // to reach "spam" on content rather than on authentication — and it must not be
  // called phishing, because nothing here claims to be anyone.
  const bulk = withHeaders(
    buildPlaintext({
      from: 'Rewards Team <winners@prize-drop.example>',
      to: [address],
      subject: '🎉🎁🏆 CONGRATULATIONS YOU HAVE WON A FREE IPHONE!!!',
      body:
        'Dear valued customer,\n\n' +
        'You have been selected as our lucky winner! Claim your prize today only — ' +
        'this offer expires today.\n\n' +
        'A small processing fee of $25 is required to release your reward. Act now ' +
        'before it is too late!\n\n' +
        'Claim here: http://bit.ly/3xqZp1a\n\n' +
        'Unsubscribe at any time.',
    }),
    [
      'List-Unsubscribe: <mailto:stop@prize-drop.example>',
      'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=prize-drop.example; dkim=pass header.i=@prize-drop.example',
    ],
  );

  // Legitimate, and full of the words a naive filter watches for.
  const legitimate = withHeaders(
    buildPlaintext({
      from: 'Northgate Bank <no-reply@northgate-bank.example>',
      to: [address],
      subject: 'Your password was changed',
      body:
        `Hello,\n\n` +
        'The password for your Northgate Bank account was changed on Tuesday at 14:12. ' +
        'You do not need to do anything if this was you.\n\n' +
        'If it was not, sign in and review your recent activity:\n' +
        'https://www.northgate-bank.example/security/activity\n\n' +
        'We will never ask you for your password, PIN or card details by email.\n\n' +
        'Northgate Bank',
    }),
    [
      'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=northgate-bank.example; ' +
        'dkim=pass header.i=@northgate-bank.example; dmarc=pass header.from=northgate-bank.example',
      'Return-Path: <no-reply@northgate-bank.example>',
    ],
  );

  return [
    toStored('demo-phish', phishing, true, undefined, at(18)),
    toStored('demo-bulk', bulk, true, undefined, at(95)),
    toStored('demo-legit-security', legitimate, true, undefined, at(240)),
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
      snippet: encrypted ? 'Encrypted — open to decrypt on this device.' : snippetOf(raw),
      unread,
      starred: false,
      messageId: headers['message-id'],
      references: headers['references'],
      autocrypt: headers['autocrypt'],
      // The four headers the filter reads. Carried the same way Gmail's own
      // `toSummary` carries them — present when the message has them, absent when
      // it does not, because absence must never read as failure.
      replyTo: headers['reply-to'],
      authenticationResults: headers['authentication-results'],
      listUnsubscribe: headers['list-unsubscribe'],
      returnPath: headers['return-path'],
    },
  };
}

/**
 * Add raw header lines to a built message.
 *
 * `buildPlaintext` writes the headers a *sender* controls, which is the right
 * surface for it: `Authentication-Results` and `Return-Path` are written by a
 * receiving server, and `Reply-To`/`List-Unsubscribe` are not part of anything
 * CryptMail composes. The fixtures need them because they are what the filter
 * reads, so they are spliced in here rather than by widening the builder.
 */
function withHeaders(raw: string, lines: string[]): string {
  if (lines.length === 0) return raw;
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  if (split === -1) return [...lines, '', normalized].join('\n');
  return `${normalized.slice(0, split)}\n${lines.join('\n')}${normalized.slice(split)}`;
}

/**
 * A provider-style preview of a plaintext body.
 *
 * Gmail's `snippet` is a flattened prefix of the message — roughly 200 characters
 * of running text, not the first line — and that is what everything above
 * `MailClient` treats `summary.snippet` as: the readable preview a row is
 * displayed from, searched by, and (for plaintext) categorised on.
 *
 * The demo used to return only the first non-blank line, which for a message
 * opening "Dear valued customer," is four words of salutation. That made the demo
 * mailbox score plaintext mail on materially less text than the live mailbox
 * would, and it silently disarmed the bulk-mail fixture this file adds for the
 * filter: `demo-bulk`'s prize-and-payment wording sits on lines two and four, so
 * the row was categorised as though the message said nothing at all. Flattening to
 * a prefix is what makes the demo and live paths read the same shape of text.
 */
function snippetOf(raw: string): string {
  const { body } = parseRfc822(raw);
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
