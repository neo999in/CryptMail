/**
 * The key directory seam.
 *
 * One interface, three implementations — the same shape as the mail and crypto
 * seams, and for the same reason: a demo build must be able to walk the whole
 * discovery flow without a network, and must never hand a real keyserver the
 * addresses a user is typing into a fixture mailbox. The third says no to every
 * lookup, which is this build's default.
 *
 * | | demo | none | live |
 * |---|---|---|---|
 * | Trigger | no mailbox configured (`mailMode !== 'real'`) | `KEY_DIRECTORY_ENABLED` off | a real mailbox, lookup on |
 * | Lookup | in-memory fixtures | nothing — always `null` | `keys.openpgp.org`, then WKD |
 *
 * The middle column is the current build. `config.KEY_DIRECTORY_ENABLED` holds
 * the reasoning; `noDirectory.ts` holds what it means for a send.
 *
 * Screens never touch this — `AppState` does (CLAUDE.md rule 5).
 */
import { KEY_DIRECTORY_ENABLED, mailMode } from '../config';
import { demoDirectory } from './demoDirectory';
import { DiscoveryResult, PublishOutcome } from './discovery';
import { noDirectory } from './noDirectory';
import { vksDirectory } from './vksDirectory';

export interface KeyDirectory {
  readonly kind: 'vks' | 'demo' | 'none';
  /** Human-readable name of where a published key ends up. Shown in the consent copy. */
  readonly listedAt: string;
  /** `null` means nothing is published for that address — a normal outcome. */
  lookup(email: string): Promise<DiscoveryResult | null>;
  publish(armored: string, email: string): Promise<{ status: PublishOutcome }>;
}

/**
 * Lookup off wins over everything: a build that must not ask a server about an
 * address must not ask a fixture one either, or the behaviour under test
 * differs from the behaviour that ships.
 */
export const directory: KeyDirectory = !KEY_DIRECTORY_ENABLED
  ? noDirectory
  : mailMode === 'real'
    ? vksDirectory
    : demoDirectory;

export { DiscoveryError } from './discovery';
export type { DiscoveryResult, DiscoverySource, PublishOutcome } from './discovery';
export { autocryptKeyFrom, harvestAutocrypt } from './autocrypt';
