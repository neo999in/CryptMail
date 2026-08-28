/**
 * The key directory seam.
 *
 * One interface, one implementation: `keys.openpgp.org` first, WKD second. The
 * interface stays because it is the seam WKD-only or enterprise directories would
 * arrive through, and because `listedAt` is what the publish-consent copy names —
 * a screen must never hard-code where a user's key is being uploaded.
 *
 * It used to select an in-memory fixture directory whenever the mailbox was a
 * fixture one. With Gmail the only mailbox there is no such build, and the rule
 * that gating protected — never hand a real keyserver the addresses typed into a
 * demo — is satisfied by there being no demo to type into.
 *
 * Screens never touch this — `AppState` does (CLAUDE.md rule 5).
 */
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

export const directory: KeyDirectory = vksDirectory;

export { DiscoveryError } from './discovery';
export type { DiscoveryResult, DiscoverySource, PublishOutcome } from './discovery';
export { autocryptKeyFrom, harvestAutocrypt } from './autocrypt';
