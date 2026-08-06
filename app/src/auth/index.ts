import { mailMode } from '../config';
import { demoAuth } from './demoAuth';
import { googleAuth } from './googleAuth';
import { AuthProvider } from './types';

/**
 * Sign-in follows the *mail* capability alone. It used to follow `appMode`,
 * which also required the native crypto core — so a correctly configured OAuth
 * client still fell back to the fake identity until the Rust core existed.
 */
export const auth: AuthProvider = mailMode === 'gmail' ? googleAuth : demoAuth;

export * from './types';
