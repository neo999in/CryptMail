/**
 * Which UI stack mounts: the four-screen `simple` one or the `full` eight-screen
 * one. Persisted so the choice survives a restart.
 *
 * Prototype storage is AsyncStorage-backed like the other stores here — this is
 * a display preference, not secret material.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type UiMode = 'simple' | 'full';

const STORE_KEY = 'cryptmail.uimode.v1';

export const DEFAULT_UI_MODE: UiMode = 'simple';

export async function loadUiMode(): Promise<UiMode> {
  const stored = await AsyncStorage.getItem(STORE_KEY);
  return stored === 'simple' || stored === 'full' ? stored : DEFAULT_UI_MODE;
}

export async function saveUiMode(mode: UiMode): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, mode);
}
