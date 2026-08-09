/**
 * The key directory seam.
 *
 * One interface, two implementations — the same shape as the mail and crypto
 * seams, and for the same reason: a demo build must be able to walk the whole
 * discovery flow without a network, and must never hand a real keyserver the
 * addresses a user is typing into a fixture mailbox.
 *
 * | | demo | live |
 * |---|---|---|
 * | Trigger | demo mailbox (`mailMode === 'demo'`) | real Gmail |
 * | Lookup | in-memory fixtures | `keys.openpgp.org`, then WKD |
 *
 * Screens never touch this — `AppState` does (CLAUDE.md rule 5).
 */
import { mailMode } from '../config';
import { demoDirectory } from './demoDirectory';
import { DiscoveryResult, PublishOutcome } from './discovery';
import { vksDirectory } from './vksDirectory';

export interface KeyDirectory {
  readonly kind: 'vks' | 'demo';
  /** Human-readable name of where a published key ends up. Shown in the consent copy. */
  readonly listedAt: string;
  /** `null` means nothing is published for that address — a normal outcome. */
  lookup(email: string): Promise<DiscoveryResult | null>;
  publish(armored: string, email: string): Promise<{ status: PublishOutcome }>;
}

export const directory: KeyDirectory = mailMode === 'gmail' ? vksDirectory : demoDirectory;

export { DiscoveryError } from './discovery';
export type { DiscoveryResult, DiscoverySource, PublishOutcome } from './discovery';
export { autocryptKeyFrom, harvestAutocrypt } from './autocrypt';
