/** Demo sign-in: no network, no tokens, one fixed identity. */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getAsyncItemMigrating } from '../lib/legacyStorageKey';
import { DEMO_ADDRESS } from '../mail/demoMail';
import { AuthProvider, Session } from './types';

const STORE_KEY = 'cryptmail.session.demo';

const session: Session = {
  provider: 'demo',
  email: DEMO_ADDRESS,
  accessToken: 'demo',
  expiresAt: Number.MAX_SAFE_INTEGER,
};

export const demoAuth: AuthProvider = {
  provider: 'demo',

  async signIn() {
    await new Promise((r) => setTimeout(r, 500));
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(session));
    return session;
  },

  async restore() {
    const stored = await getAsyncItemMigrating(STORE_KEY);
    return stored ? (JSON.parse(stored) as Session) : null;
  },

  async signOut() {
    await AsyncStorage.removeItem(STORE_KEY);
  },

  async freshAccessToken() {
    return session.accessToken;
  },
};
