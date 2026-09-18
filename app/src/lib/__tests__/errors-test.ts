import { CoreError } from '../../core/types';
import { MailError } from '../../mail/types';
import { unwrapNative, userMessage } from '../errors';

describe('userMessage', () => {
  it('passes a message written for a person through untouched', () => {
    const e = new Error('That code does not unlock your backup. Check what you wrote down.');
    expect(userMessage(e)).toBe(e.message);
    expect(userMessage(new CoreError('There is no key on this device yet.', 'no-key'))).toBe(
      'There is no key on this device yet.',
    );
  });

  it('removes Expo’s native rejection wrapper', () => {
    const e = new Error(
      "Call to function 'ExpoClipboard.getStringAsync' has been rejected.\n→ Caused by: The clipboard is empty",
    );
    expect(userMessage(e)).toBe('The clipboard is empty.');
  });

  it('says “offline” for every way the platform reports no network', () => {
    for (const text of [
      'Network request failed',
      'TypeError: Failed to fetch',
      'Could not refresh the session: Network request failed',
      "java.net.UnknownHostException: Unable to resolve host \"gmail.googleapis.com\"",
    ]) {
      expect(userMessage(new TypeError(text))).toMatch(/Check your internet connection/);
    }
  });

  it('says “too slow” for an abort or a timeout', () => {
    expect(userMessage(Object.assign(new Error('Aborted'), { name: 'AbortError' }))).toMatch(/took too long/);
    expect(userMessage(new Error('java.net.SocketTimeoutException: timeout'))).toMatch(/took too long/);
  });

  it('turns a provider’s HTTP status into what it means, without the JSON body', () => {
    const body = 'Gmail 403: {"error":{"code":403,"message":"Request had insufficient authentication scopes."}}';
    expect(userMessage(new MailError(body, 403))).toBe(
      'Gmail refused access. If you removed CryptMail’s access in your account settings, sign in again.',
    );
    expect(userMessage(new MailError('Gmail 503', 503))).toMatch(/Gmail is having trouble/);
    expect(userMessage(new MailError('Graph 429: slow down', 429))).toMatch(/Outlook is limiting requests/);
    expect(userMessage(new MailError('Gmail 403: rateLimitExceeded', 403))).toMatch(/limiting requests/);
  });

  it('leaves a MailError that was already written for a person alone', () => {
    expect(userMessage(new MailError('That message is no longer on the server.', 404))).toBe(
      'That message is no longer on the server.',
    );
  });

  it('names what Google Sign-In’s status codes mean', () => {
    expect(userMessage(Object.assign(new Error('DEVELOPER_ERROR'), { code: 'DEVELOPER_ERROR' }))).toMatch(
      /isn’t set up for this build/,
    );
    expect(userMessage(new Error('10: Developer console is not set up correctly.'))).toMatch(
      /isn’t set up for this build/,
    );
    expect(userMessage(Object.assign(new Error('x'), { code: 'IN_PROGRESS' }))).toMatch(/already open/);
  });

  it('hides a programming error behind something a person can act on', () => {
    expect(userMessage(new TypeError("undefined is not a function (near '...x.map...')"))).toMatch(
      /restart CryptMail/,
    );
    expect(userMessage(new SyntaxError('JSON Parse error: Unexpected character: <'))).toMatch(/restart CryptMail/);
  });

  it('never returns nothing', () => {
    expect(userMessage(undefined)).toBe('Something went wrong. Try again.');
    expect(userMessage(new Error(''))).toBe('Something went wrong. Try again.');
    expect(userMessage({})).toBe('Something went wrong. Try again.');
  });

  it('finishes a bare phrase as a sentence', () => {
    expect(userMessage('could not save the file')).toBe('Could not save the file.');
    expect(userMessage({ message: 'already done!' })).toBe('Already done!');
  });
});

describe('unwrapNative', () => {
  it('drops a Java exception class in front of the text', () => {
    expect(unwrapNative('java.io.IOException: disk full')).toBe('disk full');
    expect(unwrapNative('IllegalStateException: no activity')).toBe('no activity');
  });

  it('leaves ordinary text alone', () => {
    expect(unwrapNative('Error rate is high: 3 retries')).toBe('Error rate is high: 3 retries');
  });
});
