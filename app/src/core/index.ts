import { demoCore } from './demoCore';
import { getNativeCore } from './nativeCore';
import { CryptCore } from './types';

/**
 * The one crypto core the app uses. Native when the Rust module is linked,
 * otherwise the clearly-labelled demo stand-in.
 */
export const core: CryptCore = getNativeCore() ?? demoCore;

export * from './types';
export { PLACEHOLDER_SUBJECT, buildPlaintext, isPgpMime, parseRfc822 } from './mime';
