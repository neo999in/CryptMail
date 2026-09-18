/**
 * What a new-mail notification is allowed to say — features.md 0.10.
 *
 * Notifications are posted by `state/notify.ts` after a sync — in the app, or
 * from the background pass — and it asks `planFor` what to put in each one.
 * There is still no push relay (api.md); when there is, a push message reaches
 * the app only through `parseRelayPayload`. Pure: no React, no platform APIs,
 * no storage.
 *
 * ## The rules
 *
 * 1. **The lock screen is always generic.** Every plan carries a `lockScreen`
 *    version — "New message", or a count — and it is what the OS shows while
 *    the device is locked (Android `publicVersion` with
 *    `VISIBILITY_PRIVATE`; iOS "show previews: when unlocked"). No setting puts
 *    a sender, a subject or an address there, because a lock screen is read by
 *    whoever is holding the phone.
 * 2. **Content comes from this device, never from the push.** A plan is built
 *    from mail the app fetched and — if it was encrypted — decrypted itself.
 *    The relay's payload has no field that could carry content, and
 *    `parseRelayPayload` refuses one that tries.
 * 3. **Decrypt first, then reveal.** An encrypted message that has not been
 *    decrypted here shows nothing from its envelope either: its `From` is an
 *    unauthenticated header, and showing it would announce who is writing
 *    encrypted mail to this person before the signature was ever checked.
 * 4. **Only when unlocked, and only when asked.** The detailed version is
 *    built only if the device is unlocked at the moment of posting and the user
 *    chose a setting above `private`. Locked means generic, even if the
 *    setting allows more — it is not upgraded later by the OS.
 * 5. **The default reveals nothing.** `private`: a notification that mail
 *    arrived, and no more, unlocked or not.
 */

/** The user's choice. Ordered from least to most revealing. */
export type NotificationPreview = 'off' | 'private' | 'sender' | 'full';

export const NOTIFICATION_PREVIEWS: readonly NotificationPreview[] = ['off', 'private', 'sender', 'full'];

/** Nothing about a message is shown unless the user asks for it. */
export const DEFAULT_NOTIFICATION_PREVIEW: NotificationPreview = 'private';

/** The words the settings screen will use, so they are decided with the rules. */
export const NOTIFICATION_PREVIEW_LABEL: Record<NotificationPreview, { title: string; detail: string }> = {
  off: { title: 'Off', detail: 'No notifications.' },
  private: { title: 'Private', detail: 'Says that mail arrived. Never who from or what about.' },
  sender: { title: 'Sender', detail: 'Shows who it is from once the phone is unlocked.' },
  full: { title: 'Sender and subject', detail: 'Shows who it is from and what about once the phone is unlocked.' },
};

/** One message the app fetched itself, as sync saw it. */
export type NewMail = {
  /** Envelope sender address. */
  from: string;
  fromName?: string;
  /** The readable subject — the protected one, for encrypted mail decrypted here. */
  subject?: string;
  /** A few words of the readable body. */
  snippet?: string;
  /** Whether the message arrived encrypted. */
  encrypted: boolean;
  /**
   * Whether this device decrypted it. Meaningless for unencrypted mail. An
   * encrypted message that is not decrypted reveals nothing (rule 3).
   */
  decrypted: boolean;
};

export type DeviceState = {
  /** Locked at the moment the notification is posted. */
  locked: boolean;
};

export type NotificationText = { title: string; body: string };

export type NotificationPlan =
  | { post: false }
  | {
      post: true;
      /** What the lock screen shows. Always generic (rule 1). */
      lockScreen: NotificationText;
      /**
       * What the unlocked device shows. Equal to `lockScreen` whenever the
       * setting, the lock or the message's state does not allow more.
       */
      content: NotificationText;
      /** Always `private`: the OS shows `lockScreen` while locked. */
      visibility: 'private';
    };

/** The app's name, and the only title a generic notification has. */
export const GENERIC_TITLE = 'CryptMail';

/** Longest subject or snippet a notification carries; the OS truncates anyway. */
export const MAX_PREVIEW_CHARS = 120;

/**
 * The notification for a batch of new mail — or none.
 *
 * A batch, because sync delivers what arrived since the last one, and five
 * notifications for five messages is five times the lock-screen exposure of
 * one that says "5 new messages".
 */
export function planFor(
  mail: readonly NewMail[],
  preview: NotificationPreview,
  device: DeviceState,
): NotificationPlan {
  if (preview === 'off' || mail.length === 0) return { post: false };

  const lockScreen = genericText(mail.length);
  const generic = { post: true as const, lockScreen, content: lockScreen, visibility: 'private' as const };

  if (preview === 'private' || device.locked) return generic;

  // Only what this device can vouch it read (rule 3).
  const readable = mail.filter(isReadable);
  if (readable.length === 0) return generic;

  if (mail.length === 1) {
    const [message] = readable;
    const sender = senderOf(message);
    if (preview === 'sender') return { ...generic, content: { title: sender, body: 'New message' } };
    return { ...generic, content: { title: sender, body: clip(message.subject) || clip(message.snippet) || 'New message' } };
  }

  // Several: who from, never what about — a subject list is a lock-screen
  // leak waiting for a notification shade tall enough to show it. Anyone not
  // readable is counted, not named.
  const names = [...new Set(readable.map(senderOf))];
  const hidden = mail.length - readable.length;
  const body = names.join(', ') + (hidden > 0 ? ` and ${hidden} more` : '');
  return { ...generic, content: { title: `${mail.length} new messages`, body: clip(body) } };
}

function genericText(count: number): NotificationText {
  return { title: GENERIC_TITLE, body: count === 1 ? 'New message' : `${count} new messages` };
}

function isReadable(message: NewMail): boolean {
  return !message.encrypted || message.decrypted;
}

function senderOf(message: NewMail): string {
  return clip(message.fromName?.trim()) || message.from;
}

/** One line, trimmed, and short. Newlines in a subject would be a second line on the shade. */
function clip(text: string | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_PREVIEW_CHARS ? `${line.slice(0, MAX_PREVIEW_CHARS - 1)}…` : line;
}

/* ------------------------------------------------------- relay payload ---- */

/**
 * The entire push payload the relay may send (api.md, "Push payload contract").
 *
 * `v` is the contract version. `t` is the only instruction there is: go and
 * sync. `a` is an opaque token the device minted at registration and maps back
 * to one of its own accounts — random, never derived from the address, so the
 * relay cannot recover which mailbox it is, and two devices on the same account
 * hold different ones.
 *
 * Nothing else. No message id, no count, no sender, no timestamp: each would
 * be something the relay learns about the mail, or something a forged push
 * could make the app display.
 */
export type RelayPayload = { v: 1; t: 'sync'; a: string };

const ACCOUNT_TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const PAYLOAD_KEYS = ['a', 't', 'v'];

/**
 * Accept a push only if it is exactly the contract, and nothing more.
 *
 * Strict on purpose: an extra field is refused rather than ignored, because
 * the day a relay starts sending `subject` "just for the notification", the
 * app is where that has to fail loudly. It is also why the FCM `data` map is
 * what gets passed here — a message with a `notification` block is displayed
 * by the OS without the app ever running, so the relay must never send one,
 * and a payload that has one is not this contract.
 */
export function parseRelayPayload(data: unknown): RelayPayload | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((k, i) => k !== PAYLOAD_KEYS[i])) return null;
  // FCM data values are strings, so the version may arrive as "1".
  if (record.v !== 1 && record.v !== '1') return null;
  if (record.t !== 'sync') return null;
  if (typeof record.a !== 'string' || !ACCOUNT_TOKEN.test(record.a)) return null;
  return { v: 1, t: 'sync', a: record.a };
}
