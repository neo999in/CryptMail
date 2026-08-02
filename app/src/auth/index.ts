import { appMode } from '../config';
import { demoAuth } from './demoAuth';
import { googleAuth } from './googleAuth';
import { AuthProvider } from './types';

export const auth: AuthProvider = appMode === 'live' ? googleAuth : demoAuth;

export * from './types';
