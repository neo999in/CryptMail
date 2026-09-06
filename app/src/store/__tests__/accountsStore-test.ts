/**
 * The index of connected mailboxes.
 *
 * The interesting logic is `normalise`: `active` must always name an account
 * that exists, because every scoped store read and write in the app is keyed on
 * it. An `active` pointing at a removed account would leave the previous
 * mailbox's keyring and drafts on screen with nothing to write them back to.
 */
import { AccountRef, DEFAULT_ACCOUNT_SETTINGS, accountRefFor } from '../accountScope';
import { NO_ACCOUNTS, removeAccount, setAccountSettings, upsertAccount } from '../accountsStore';

const ONE = accountRefFor('gmail', 'you@gmail.com');
const TWO = accountRefFor('gmail', 'you@work.example');

/**
 * What a ref looks like once it has been through the store.
 *
 * Every reader gets a complete `settings`, filled in by `normalise` — so the
 * refs the tests construct are compared against the settled shape rather than
 * the bare one a sign-in produces.
 */
const settled = (ref: AccountRef, settings = {}): AccountRef => ({
  ...ref,
  settings: { ...DEFAULT_ACCOUNT_SETTINGS, ...settings },
});

describe('upsertAccount', () => {
  it('adds an account and puts it in front', () => {
    const state = upsertAccount(NO_ACCOUNTS, ONE);

    expect(state.accounts).toEqual([settled(ONE)]);
    expect(state.active).toBe(ONE.id);
  });

  it('keeps the first account connected when a second arrives', () => {
    const state = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), TWO);

    expect(state.accounts.map((a) => a.id)).toEqual([ONE.id, TWO.id]);
    expect(state.active).toBe(TWO.id);
  });

  it('refreshes an account already listed rather than duplicating it', () => {
    const renamed = { ...ONE, name: 'Personal' };
    const state = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), renamed);

    expect(state.accounts).toEqual([settled(renamed)]);
  });
});

/**
 * The settings a user chose are the one thing on a ref the provider does not
 * own, so re-registering an account must not carry the sign-in's blanks over
 * them. Every boot re-registers every account.
 */
describe('account settings', () => {
  it('defaults on an account that has never been configured', () => {
    const state = upsertAccount(NO_ACCOUNTS, ONE);

    expect(state.accounts[0].settings).toEqual(DEFAULT_ACCOUNT_SETTINGS);
  });

  it('survives the re-registration every launch performs', () => {
    const named = setAccountSettings(upsertAccount(NO_ACCOUNTS, ONE), ONE.id, {
      displayName: 'Personal',
      syncWindow: '30',
    });

    const rebooted = upsertAccount(named, ONE, false);

    expect(rebooted.accounts[0].settings).toEqual({
      ...DEFAULT_ACCOUNT_SETTINGS,
      displayName: 'Personal',
      syncWindow: '30',
    });
  });

  it('patches one field and leaves the others alone', () => {
    const state = setAccountSettings(
      setAccountSettings(upsertAccount(NO_ACCOUNTS, ONE), ONE.id, { displayName: 'Personal' }),
      ONE.id,
      { blockRemoteImages: true },
    );

    expect(state.accounts[0].settings).toEqual({
      ...DEFAULT_ACCOUNT_SETTINGS,
      displayName: 'Personal',
      blockRemoteImages: true,
    });
  });

  it('changes one mailbox without touching the other', () => {
    const both = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), TWO);

    const state = setAccountSettings(both, TWO.id, { avatar: 'initials' });

    expect(state.accounts[0].settings?.avatar).toBe('photo');
    expect(state.accounts[1].settings?.avatar).toBe('initials');
  });

  /**
   * A value from a future build, an older one, or a hand-edited blob. Coerced
   * on read for the same reason `normalisePrefs` does it: a screen must never be
   * handed a sync window with no meaning behind it.
   */
  it('coerces a stored value it does not recognise', () => {
    const nonsense = { ...ONE, settings: { avatar: 'briefcase', syncWindow: '400', displayName: 7 } };

    const state = upsertAccount(NO_ACCOUNTS, nonsense as unknown as AccountRef);

    expect(state.accounts[0].settings).toEqual(DEFAULT_ACCOUNT_SETTINGS);
  });
});

describe('removeAccount', () => {
  it('falls back to another account rather than leaving active dangling', () => {
    const both = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), TWO);

    expect(removeAccount(both, TWO.id).active).toBe(ONE.id);
  });

  it('leaves nothing active when the last account goes', () => {
    const state = removeAccount(upsertAccount(NO_ACCOUNTS, ONE), ONE.id);

    expect(state).toEqual(NO_ACCOUNTS);
  });

  it('does not disturb the active account when a different one is removed', () => {
    const both = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), TWO);

    expect(removeAccount(both, ONE.id).active).toBe(TWO.id);
  });
});

/**
 * A merged inbox of one mailbox is just that mailbox, with a control that says
 * otherwise. It is turned off rather than shown as a lie.
 */
describe('unified', () => {
  it('stays off while only one account is connected', () => {
    const state = upsertAccount({ ...NO_ACCOUNTS, unified: true }, ONE);

    expect(state.unified).toBe(false);
  });

  it('is allowed once there are two', () => {
    const both = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), TWO);

    expect(upsertAccount({ ...both, unified: true }, TWO).unified).toBe(true);
  });

  /**
   * Turning it off on the way down to one account is not a preference the app
   * remembers and re-applies: a user who removes a mailbox and adds a different
   * one later should not find their inbox silently merged again.
   */
  it('does not come back by itself when a second account returns', () => {
    const both = upsertAccount(upsertAccount(NO_ACCOUNTS, ONE), TWO);
    const merged = upsertAccount({ ...both, unified: true }, TWO);

    expect(upsertAccount(removeAccount(merged, TWO.id), TWO).unified).toBe(false);
  });
});
