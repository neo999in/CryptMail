/**
 * The live directory: `keys.openpgp.org` first, WKD second.
 *
 * A thin binding of `discovery.ts` to the platform `fetch`. Everything with
 * logic in it lives there, behind an injectable transport, so it can be tested
 * without a network.
 */
import { DiscoveryResult, lookupKey, publishKey, PublishOutcome } from './discovery';
import type { KeyDirectory } from './index';

const deps = { fetch: globalThis.fetch };

export const vksDirectory: KeyDirectory = {
  kind: 'vks',
  listedAt: 'keys.openpgp.org',

  lookup(email: string): Promise<DiscoveryResult | null> {
    return lookupKey(email, deps);
  },

  publish(armored: string, email: string): Promise<{ status: PublishOutcome }> {
    return publishKey(armored, email, deps);
  },
};
