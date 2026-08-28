/**
 * The demo mailbox has to stay honest about which core is loaded.
 *
 * Its encrypted fixtures are `demoCore` output encrypted to `fakePublicKey()`
 * armor. A real core rejects the keys as malformed and cannot decrypt the
 * ciphertext, so serving those rows against a native core produces an inbox
 * whose messages fail to open. See the note at the top of `demoMail.ts`.
 */
import { createDemoMailClient, DEMO_ADDRESS } from '../demoMail';
import { demoCore } from '../../core/demoCore';
import { categorizeMessage, verdictFor } from '../../categorizer/categorizer';
import { PLACEHOLDER_SUBJECT } from '../../core';

async function inbox(includeDemoCiphertext: boolean) {
  const client = await createDemoMailClient(DEMO_ADDRESS, includeDemoCiphertext);
  const summaries = await client.listInbox(20);
  const raws = await Promise.all(summaries.map((s) => client.getRaw(s.id)));
  return { client, summaries, raws };
}

describe('with the demo core', () => {
  it('serves the encrypted fixtures the design calls for', async () => {
    const { raws } = await inbox(true);
    expect(raws.filter((r) => demoCore.looksEncrypted(r)).length).toBeGreaterThan(0);
  });
});

describe('with a real core', () => {
  it('serves no demo ciphertext, because a real core could not read it', async () => {
    const { raws } = await inbox(false);
    expect(raws.filter((r) => demoCore.looksEncrypted(r))).toHaveLength(0);
  });

  it('explains the absence rather than showing an empty mailbox', async () => {
    const { summaries } = await inbox(false);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some((s) => /demo mail, real encryption/i.test(s.subject))).toBe(true);
  });

  it('still round-trips a message the real core sends itself', async () => {
    // The Sent path is untouched by the gating: whatever the active core
    // produces goes into the mailbox verbatim, which is the demo that matters.
    const { client } = await inbox(false);
    const rfc822 = await demoCore.buildEncrypted({
      from: DEMO_ADDRESS,
      to: [DEMO_ADDRESS],
      subject: 'hello',
      body: 'body',
      recipientKeys: ['irrelevant-for-this-assertion'],
    });
    await client.send(rfc822);

    const [newest] = await client.listInbox(1);
    expect(await client.getRaw(newest.id)).toBe(rfc822);
  });
});

/**
 * The three filter fixtures exist so a regression in either direction is visible
 * in the demo inbox itself. Nothing asserted them, which is how `demo-bulk` came
 * to sit in Primary: the row's `snippet` was the first non-blank body line —
 * "Dear valued customer," — so the prize and payment wording two lines below it
 * was never scored, and the fixture documented as bulk mail was classified on four
 * words of salutation. Gmail's own `snippet` is a flattened prefix of the body, so
 * the demo now builds the same shape.
 *
 * These assert the *row*, exactly as `InboxScreen` and the drawer badges compute
 * it — not a hand-built input — because that is the path the mistake was on.
 */
describe('the spam fixtures land where they are documented to land', () => {
  const row = async (id: string) => {
    const { summaries } = await inbox(true);
    const summary = summaries.find((s) => s.id === id);
    if (!summary) throw new Error(`fixture missing: ${id}`);
    const encrypted = summary.subject.trim() === PLACEHOLDER_SUBJECT;
    return {
      category: categorizeMessage(summary, encrypted, {}),
      verdict: verdictFor(summary, encrypted, {}),
    };
  };

  it('files the phishing fixture as spam, and names it phishing', async () => {
    const { category, verdict } = await row('demo-phish');
    expect(category).toBe('spam');
    expect(verdict.classification).toBe('phishing-suspicious');
  });

  it('files the bulk fixture as spam, and does not call it phishing', async () => {
    // Nothing in it claims to be anyone, so the phishing score must stay negative:
    // it authenticates and carries List-Unsubscribe. It is unwanted, not a lie.
    const { category, verdict } = await row('demo-bulk');
    expect(category).toBe('spam');
    expect(verdict.classification).toBe('spam');
  });

  it('leaves the legitimate security notice in Primary', async () => {
    // The hardest case in the mailbox: it says password, verify, sign in and
    // account. If this ever moves to Spam the engine has regressed to keywords.
    const { category, verdict } = await row('demo-legit-security');
    expect(category).toBe('primary');
    expect(verdict.classification).toBe('legitimate');
  });

  it('leaves the ordinary plaintext newsletter in Primary', async () => {
    const { category } = await row('demo-3');
    expect(category).toBe('primary');
  });
});
