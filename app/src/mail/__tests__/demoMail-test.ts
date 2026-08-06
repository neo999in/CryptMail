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
