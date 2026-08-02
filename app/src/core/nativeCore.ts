/**
 * Binding to the real `ciphermail-core` (Rust → UniFFI → Kotlin → turbo module).
 *
 * The native module does not exist yet: it arrives with M2 of
 * docs/prototype-plan.md. Until then `getNativeCore()` returns null and the app
 * falls back to `demoCore` with encrypted sending disabled — never silently.
 *
 * When M2 lands, the Kotlin module must register under the name below and
 * expose these methods; no other file needs to change.
 */
import { NativeModules } from 'react-native';

import { isPgpMime } from './mime';
import { BuildRequest, CipherCore, DecryptedMessage, Identity, PublicKeyInfo } from './types';

export const NATIVE_MODULE_NAME = 'CipherMailCore';

type NativeBridge = {
  generateIdentity(email: string): Promise<string>;
  loadIdentity(email: string): Promise<string | null>;
  importPublicKey(armored: string): Promise<string>;
  buildEncrypted(requestJson: string): Promise<string>;
  parseEncrypted(rfc822: string): Promise<string>;
};

export function getNativeCore(): CipherCore | null {
  const bridge = (NativeModules as Record<string, NativeBridge | undefined>)[NATIVE_MODULE_NAME];
  if (!bridge) return null;

  return {
    kind: 'native',
    generateIdentity: async (email) => JSON.parse(await bridge.generateIdentity(email)) as Identity,
    loadIdentity: async (email) => {
      const json = await bridge.loadIdentity(email);
      return json ? (JSON.parse(json) as Identity) : null;
    },
    importPublicKey: async (armored) => JSON.parse(await bridge.importPublicKey(armored)) as PublicKeyInfo,
    buildEncrypted: (request: BuildRequest) => bridge.buildEncrypted(JSON.stringify(request)),
    parseEncrypted: async (rfc822) => JSON.parse(await bridge.parseEncrypted(rfc822)) as DecryptedMessage,
    looksEncrypted: isPgpMime,
  };
}
