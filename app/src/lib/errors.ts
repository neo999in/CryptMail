/**
 * The one place a caught error becomes words on screen.
 *
 * Most errors in this app are already written for a person — the IMAP layer,
 * the send path and the recovery drill all say what happened in plain terms.
 * The ones that are not come from *below* the app, and they arrive looking the
 * same every time:
 *
 * - Expo's wrapper around a native rejection: "Call to function
 *   'CryptMailCore.importRecoveryBackup' has been rejected. → Caused by: …"
 * - `fetch` with no network: "Network request failed"
 * - a provider's HTTP status with its JSON body: "Gmail 403: { "error": … }"
 * - Google Sign-In's status codes: "DEVELOPER_ERROR", "10: …"
 * - a JavaScript bug surfacing as "undefined is not a function"
 *
 * `userMessage` recognises those and says what they mean and what to do. Any
 * other message passes through untouched, because it was written on purpose.
 * Screens call this instead of reading `e.message`; nothing else changes.
 */
const GENERIC = 'Something went wrong. Try again.';

const OFFLINE = 'Couldn’t connect. Check your internet connection and try again.';

const SLOW = 'That took too long to answer. Check your connection and try again.';

/**
 * What `fetch`, OkHttp and the socket layer say when there is no route to the
 * server. Matched anywhere in the text: an error that wraps one ("Could not
 * refresh the session: Network request failed") means the same thing.
 */
const NETWORK =
  /network request failed|failed to fetch|networkerror|network error|unable to resolve host|unknownhostexception|enotfound|econnrefused|econnreset|enetunreach|connectexception|no address associated with hostname|internet connection appears to be offline/i;

const TIMEOUT = /\btimed? ?out\b|etimedout|sockettimeoutexception/i;

/** Google Sign-In reports by status code; these are the ones a person can act on. */
const SIGN_IN_CODES: Record<string, string> = {
  DEVELOPER_ERROR:
    'Google sign-in isn’t set up for this build of CryptMail (the OAuth client doesn’t match). See docs/running-it.md.',
  '10': 'Google sign-in isn’t set up for this build of CryptMail (the OAuth client doesn’t match). See docs/running-it.md.',
  NETWORK_ERROR: OFFLINE,
  '7': OFFLINE,
  IN_PROGRESS: 'A sign-in is already open. Finish or close it, then try again.',
  SIGN_IN_CANCELLED: 'Sign-in was cancelled.',
  '12501': 'Sign-in was cancelled.',
  PLAY_SERVICES_NOT_AVAILABLE: 'Google sign-in needs Google Play services, which this device doesn’t have.',
};

export function userMessage(e: unknown): string {
  const raw = unwrapNative(textOf(e));

  if (isAbort(e)) return SLOW;

  const code = codeOf(e) ?? raw.match(/^(\d{1,5}):/)?.[1];
  if (code && SIGN_IN_CODES[code]) return SIGN_IN_CODES[code];

  if (NETWORK.test(raw)) return OFFLINE;
  if (TIMEOUT.test(raw)) return SLOW;

  const http = raw.match(/^(Gmail|Graph) (\d{3})\b/);
  if (http && nameOf(e) === 'MailError') {
    return providerStatus(http[1] === 'Gmail' ? 'Gmail' : 'Outlook', Number(http[2]), raw);
  }

  // A programming error has nothing in it for the reader, and "undefined is not
  // a function" reads as though they did something wrong.
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError) {
    return 'Something went wrong on this device. Try again — if it keeps happening, restart CryptMail.';
  }

  return tidy(raw) || GENERIC;
}

/** What a provider's HTTP status means to someone looking at their mail. */
export function providerStatus(provider: string, status: number, detail = ''): string {
  if (status === 429 || /ratelimit|rate limit|quota/i.test(detail)) {
    return `${provider} is limiting requests right now. Wait a minute and try again.`;
  }
  if (status === 401) return `Your ${provider} sign-in has expired. Sign in again to continue.`;
  if (status === 403) {
    return `${provider} refused access. If you removed CryptMail’s access in your account settings, sign in again.`;
  }
  if (status === 404) return 'That message or folder is no longer on the server. Refresh to update the list.';
  if (status === 408 || status === 504) return SLOW;
  if (status === 413) return `That message is too large for ${provider} to accept.`;
  if (status >= 500) return `${provider} is having trouble right now. Try again in a moment.`;
  return `${provider} couldn’t do that (error ${status}). Try again.`;
}

function textOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

function nameOf(e: unknown): unknown {
  return (e as { name?: unknown } | null)?.name;
}

function isAbort(e: unknown): boolean {
  return nameOf(e) === 'AbortError';
}

/**
 * Drop Expo's "Call to function … has been rejected. → Caused by:" wrapper and
 * any Java/Kotlin exception class in front of the text that matters.
 */
export function unwrapNative(text: string): string {
  let out = /has been rejected/.test(text) ? (text.split(/Caused by:\s*/).pop() ?? text) : text;
  out = out.replace(/^(?:[\w$]+\.)*[\w$]*(?:Exception|Error):\s*/, '');
  return out.trim();
}

/** A capital to start and a full stop to end — the rest is the author's. */
function tidy(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const capital = t[0].toUpperCase() + t.slice(1);
  return /[.!?…)”"]$/.test(capital) ? capital : `${capital}.`;
}
