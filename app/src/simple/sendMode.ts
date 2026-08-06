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
import { AppMode } from '../config';
import { RecipientState } from '../state/AppState';

export type SendModeName = 'encrypted' | 'plain';

export type SendModeState = {
  available: boolean;
  /** Why it can't be used. Present only when `available` is false. */
  blockedReason?: string;
  /** Shown when the mode *is* usable but carries a caveat. */
  warning?: string;
};

export type SendModes = Record<SendModeName, SendModeState>;

export type SendModeInput = {
  recipients: RecipientState[];
  /** Whether the real Rust core is linked (config.hasNativeCore). */
  hasNativeCore: boolean;
  appMode: AppMode;
};

/**
 * A key whose fingerprint changed blocks encryption rather than warning, which
 * matches `deliver()` in AppState: security.md treats an unexpected key change
 * as a possible key substitution, and a possible MITM is not a click-through.
 */
export function evaluateSendModes({ recipients, hasNativeCore, appMode }: SendModeInput): SendModes {
  return { encrypted: encryptedMode(recipients, hasNativeCore, appMode), plain: plainMode(recipients) };
}

function encryptedMode(recipients: RecipientState[], hasNativeCore: boolean, appMode: AppMode): SendModeState {
  if (recipients.length === 0) {
    return { available: false, blockedReason: 'Add a recipient first.' };
  }

  const missing = recipients.filter((r) => r.status === 'missing').map((r) => r.email);
  if (missing.length > 0) {
    return {
      available: false,
      blockedReason: `No key for ${missing.join(', ')}. CryptMail will not send this encrypted.`,
    };
  }

  const changed = recipients.filter((r) => r.status === 'changed').map((r) => r.email);
  if (changed.length > 0) {
    return {
      available: false,
      blockedReason: `The key for ${changed.join(', ')} changed fingerprint. Re-verify it before sending.`,
    };
  }

  // The core gate. In demo mode the flow stays usable so the UI can be driven,
  // but the caller must surface that the bytes are encoded, not encrypted.
  if (!hasNativeCore) {
    if (appMode === 'demo') {
      return { available: true, warning: 'Demo mode — this message is encoded, not encrypted.' };
    }
    return { available: false, blockedReason: 'The crypto core is not linked; encrypted send is disabled.' };
  }

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
