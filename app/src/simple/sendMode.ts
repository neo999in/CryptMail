/**
 * Which send modes are available for a set of recipients, and why not.
 *
 * Extracted from the compose screen on purpose: this is the fail-safe from
 * encryption.md, and the repo convention is that logic worth trusting lives in a
 * framework-free module with tests beside it. Nothing here sends anything.
 *
 * The rule this encodes is *not* "never send plaintext" — encryption.md allows
 * an explicit opt-out, and M4 of prototype-plan.md is a plaintext send. It is
 * "never send plaintext the user believed was encrypted": the two modes are
 * independent, and `encrypted` being blocked never promotes `plain`.
 */
import { CryptoMode } from '../config';
import { RecipientState } from '../state/AppState';

export type SendModeName = 'encrypted' | 'plain';

export type SendModeState = {
  available: boolean;
  /** Why it can't be used. Present only when `available` is false. */
  blockedReason?: string;
  /** Shown when the mode *is* usable but carries a caveat. */
  warning?: string;
  /**
   * The send is allowed but delivery waits: nobody has published a key for
   * these recipients yet, so the message is held and an invite goes out. The
   * caller must not report this as "sent" (docs/encryption.md, invite-and-queue).
   */
  queued?: boolean;
  /** Addresses being waited on, when `queued`. */
  pending?: string[];
};

export type SendModes = Record<SendModeName, SendModeState>;

export type SendModeInput = {
  recipients: RecipientState[];
  /** Whether the real core is linked — `config.cryptoMode`. */
  cryptoMode: CryptoMode;
};

/**
 * A key whose fingerprint changed blocks encryption rather than warning, which
 * matches `deliver()` in AppState: security.md treats an unexpected key change
 * as a possible key substitution, and a possible MITM is not a click-through.
 */
export function evaluateSendModes({ recipients, cryptoMode }: SendModeInput): SendModes {
  return { encrypted: encryptedMode(recipients, cryptoMode), plain: plainMode(recipients) };
}

function encryptedMode(recipients: RecipientState[], cryptoMode: CryptoMode): SendModeState {
  if (recipients.length === 0) {
    return { available: false, blockedReason: 'Add a recipient first.' };
  }

  // A changed fingerprint is checked *first* and blocks outright. It is not a
  // wait: a substituted key does not become the right key by the passage of
  // time, so it must never be swept into the queued outcome below.
  const changed = recipients.filter((r) => r.status === 'changed').map((r) => r.email);
  if (changed.length > 0) {
    return {
      available: false,
      blockedReason: `The key for ${changed.join(', ')} changed fingerprint. Re-verify it before sending.`,
    };
  }

  // The core gate. The demo core keeps the flow usable so the UI can be driven
  // before M2 lands, but the caller must surface that the bytes are only
  // encoded. It is never silently treated as encryption (CLAUDE.md rule 2).
  // It rides along with whatever else is worth saying rather than replacing it.
  const demoNote = cryptoMode === 'demo' ? 'Demo mode — this message is encoded, not encrypted.' : null;

  // No key yet is no longer a dead end. The message is still encrypted-or-
  // nothing — it is held until a key appears, and a contentless invite goes out
  // meanwhile — so the mode stays available and says plainly that delivery
  // waits. This does *not* make `plain` any more attractive; the two modes stay
  // independent, and nothing here selects one on the user's behalf.
  const missing = recipients.filter((r) => r.status === 'missing').map((r) => r.email);
  if (missing.length > 0) {
    return {
      available: true,
      queued: true,
      pending: missing,
      warning: join(
        `${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no published key yet. ` +
          'CryptMail will invite them and send this once they have one — it is not delivered until then.',
        demoNote,
      ),
    };
  }

  if (demoNote) return { available: true, warning: demoNote };

  const unverified = recipients.filter((r) => r.status === 'ok').length;
  if (unverified > 0) {
    return {
      available: true,
      warning:
        unverified === recipients.length
          ? 'Recipient keys are trusted on first use, not verified.'
          : 'Some recipient keys are trusted on first use, not verified.',
    };
  }

  return { available: true };
}

const join = (first: string, second: string | null) => (second ? `${first} ${second}` : first);

/**
 * Plaintext is always technically possible — it is a normal email. It is gated
 * on the user picking it, which is the caller's job, not this function's.
 */
function plainMode(recipients: RecipientState[]): SendModeState {
  if (recipients.length === 0) {
    return { available: false, blockedReason: 'Add a recipient first.' };
  }
  return {
    available: true,
    warning: 'Not encrypted. Google and anyone on the network can read this message.',
  };
}

/**
 * The mode a fresh compose screen should start on: encrypted whenever it is
 * usable. Plaintext is never selected on the user's behalf — if encryption is
 * blocked this returns null and the screen must make the user choose.
 */
export function defaultSendMode(modes: SendModes): SendModeName | null {
  return modes.encrypted.available ? 'encrypted' : null;
}
