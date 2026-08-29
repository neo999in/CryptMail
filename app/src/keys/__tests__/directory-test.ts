/**
 * Which directory the app talks to.
 *
 * There is one, and it is `keys.openpgp.org` — the fixture directory that used to
 * be selected whenever the mailbox was a fixture one is gone along with the
 * fixture mailbox. What is still worth pinning is `listedAt`: publishing a key is
 * a consent decision, and the name of the place it is being uploaded to has to
 * come from the directory itself rather than being written into a screen, or the
 * consent copy and the upload can disagree.
 *
 * The directory's own network behaviour — VKS then WKD, timeouts, what counts as
 * "not published" versus "could not be reached" — is covered in
 * `discovery-test.ts` against an injected transport.
 */
import { directory } from '../index';

describe('directory selection', () => {
  it('uses keys.openpgp.org — the only directory there is', () => {
    expect(directory.kind).toBe('vks');
  });

  it('names where a key would be listed, so the consent copy can say it', () => {
    expect(directory.listedAt).toBe('keys.openpgp.org');
  });
});
