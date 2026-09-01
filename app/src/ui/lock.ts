/**
 * The trust indicator on a mail row, in one place.
 *
 * Shared by every list that shows mail — the inbox, Sent, Archive — because a
 * second copy of this mapping is how a screen ends up quietly disagreeing with
 * the inbox about what a message's trust state is.
 *
 * Trust colour is not themeable: `color.mint` and `color.coral` are fixed at
 * every accent, and every state carries a `label` so the meaning is never colour
 * alone. That label is the row's `accessibilityLabel`.
 */
import { EncryptionState } from '../state/types';
import { color } from '../theme';

export type LockChip = { icon: 'lock' | 'alert' | 'mail'; tint: string; label: string };

export function lockFor(encryption: EncryptionState): LockChip {
  if (encryption.kind === 'plain') return { icon: 'mail', tint: color.inkFaint, label: 'Not encrypted' };
  if (encryption.own) return { icon: 'lock', tint: color.mint, label: 'Encrypted, from you' };
  switch (encryption.trust) {
    case 'verified':
      return { icon: 'lock', tint: color.mint, label: 'Encrypted, verified key' };
    case 'seen':
      return { icon: 'lock', tint: color.mint, label: 'Encrypted, key not verified' };
    case 'changed':
      return { icon: 'alert', tint: color.coral, label: 'Encrypted, key changed' };
    default:
      return { icon: 'alert', tint: color.coral, label: 'Encrypted, no key on file' };
  }
}
