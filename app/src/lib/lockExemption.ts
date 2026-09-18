/**
 * Leaving the app for something the app itself opened.
 *
 * Attaching a file, sharing an export, signing in with Google or Microsoft —
 * each hands the screen to another activity, and Android reports that as
 * CryptMail going to the background. With the lock set to "Immediately", every
 * attachment would come back to a PIN pad. Wrapping those calls here tells the
 * app lock (`ui/appLock.tsx`) that this trip away was ours.
 *
 * Bounded: an exemption only covers a trip shorter than `EXEMPTION_LIMIT_MS`.
 * Someone who opens the file picker and then walks off with the phone for an
 * hour comes back to the lock like any other return.
 *
 * Deliberately tiny and free of React, because it is called from `lib/files.ts`
 * and `auth/`, which must not import from `ui/`.
 */
export const EXEMPTION_LIMIT_MS = 5 * 60_000;

let open = 0;

/** Run `task`, treating the app going to the background meanwhile as expected. */
export async function whileAway<T>(task: () => Promise<T>): Promise<T> {
  open++;
  try {
    return await task();
  } finally {
    open--;
  }
}

/** Whether something CryptMail started is currently holding the screen. */
export function awayIsExpected(): boolean {
  return open > 0;
}
