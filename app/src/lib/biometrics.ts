/**
 * The device's fingerprint (or face) check — the only module that touches
 * `expo-local-authentication`, the way `lib/files.ts` is the only one that
 * touches the file APIs.
 *
 * Strong biometrics only on Android (`biometricsSecurityLevel: 'strong'`):
 * Class 2 face unlock on many phones can be fooled by a photo, and the app lock
 * must not be weaker than the PIN it stands in for. The device's own PIN or
 * pattern is not offered as a fallback either (`disableDeviceFallback`) — the
 * fallback is CryptMail's PIN, which is the point of having one.
 *
 * There is no web implementation, and none is pretended: web reports
 * `unsupported`, and the settings screen says so.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { whileAway } from './lockExemption';

export type BiometricAvailability =
  | 'available'
  /** The hardware is there but nothing strong enough is enrolled. */
  | 'not-enrolled'
  | 'no-hardware'
  | 'unsupported';

export type BiometricKind = 'fingerprint' | 'face' | 'biometrics';

export type BiometricOutcome = 'ok' | 'cancelled' | 'lockout' | 'failed' | 'unavailable';

export async function biometricAvailability(): Promise<BiometricAvailability> {
  if (Platform.OS === 'web') return 'unsupported';
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) return 'no-hardware';
    if (!(await LocalAuthentication.isEnrolledAsync())) return 'not-enrolled';
    // Enrolled, but maybe only with something weaker than Class 3 — which the
    // prompt below would then refuse.
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG ? 'available' : 'not-enrolled';
  } catch {
    return 'unsupported';
  }
}

/** What to call it on screen — "Use fingerprint" reads better than "Use biometrics" when we know. */
export async function biometricKind(): Promise<BiometricKind> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    const fingerprint = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    if (fingerprint && !face) return 'fingerprint';
    if (face && !fingerprint) return 'face';
  } catch {
    // Fall through to the generic word.
  }
  return 'biometrics';
}

export const BIOMETRIC_NAME: Record<BiometricKind, string> = {
  fingerprint: 'fingerprint',
  face: 'face unlock',
  biometrics: 'biometrics',
};

export async function authenticateBiometric(promptMessage: string): Promise<BiometricOutcome> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    // The system prompt can pause the activity; that is not the user leaving.
    const result = await whileAway(() =>
      LocalAuthentication.authenticateAsync({
        promptMessage,
        cancelLabel: 'Use PIN',
        disableDeviceFallback: true,
        biometricsSecurityLevel: 'strong',
      }),
    );
    if (result.success) return 'ok';
    switch (result.error) {
      case 'user_cancel':
      case 'system_cancel':
      case 'app_cancel':
      case 'user_fallback':
        return 'cancelled';
      case 'lockout':
        return 'lockout';
      case 'not_enrolled':
      case 'not_available':
      case 'passcode_not_set':
        return 'unavailable';
      default:
        return 'failed';
    }
  } catch {
    return 'failed';
  }
}
