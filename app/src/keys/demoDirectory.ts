/**
 * An in-memory stand-in for the keyserver, used whenever the mailbox is the
 * demo one.
 *
 * It exists so the whole point of Phase 2 — *the first message to a stranger
 * encrypts, with no user interaction* — can be demonstrated and tested offline.
 * Two addresses matter when walking the demo:
 *
 *  · `sam@ridgeline.example` has a key published here and none in the keyring,
 *    so composing to Sam discovers a key and sends encrypted.
 *  · anything else has no key, so composing to it exercises the invite and the
 *    awaiting-key queue instead.
 *
 * Publishing writes into the same map, which means the pending → published
 * transition the real keyserver drives by email is observable here too.
 *
 * Like `demoMail.ts`, the fixture key is `fakePublicKey()` armor, which a real
 * OpenPGP parser rejects — so it is only seeded when the demo core is the one
 * that would have to read it back.
 */
import { core } from '../core';
import { fakePublicKey } from '../core/demoCore';
import { DiscoveryResult, PublishOutcome } from './discovery';
import type { KeyDirectory } from './index';

export const DEMO_STRANGER = {
  email: 'sam@ridgeline.example',
  fingerprint: 'D3B7411F90A2C6E8574D1B0938E2FA4C77C5019B',
};

const listings: Record<string, string> =
  core.kind === 'demo'
    ? { [DEMO_STRANGER.email]: fakePublicKey(DEMO_STRANGER.email, DEMO_STRANGER.fingerprint) }
    : {};

export const demoDirectory: KeyDirectory = {
  kind: 'demo',
  listedAt: 'a demo directory on this device',

  async lookup(email: string): Promise<DiscoveryResult | null> {
    await delay(260);
    const armored = listings[email.trim().toLowerCase()];
    return armored ? { armored, source: 'vks' } : null;
  },

  async publish(armored: string, email: string): Promise<{ status: PublishOutcome }> {
    await delay(320);
    listings[email.trim().toLowerCase()] = armored;
    // The real keyserver mails a confirmation link before it will serve a key by
    // address; the demo reports the same state so the UI is driven through it.
    return { status: 'pending-verification' };
  },
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
