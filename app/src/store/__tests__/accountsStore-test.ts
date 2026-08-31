/**
 * The index of connected mailboxes.
 *
 * The interesting logic is `normalise`: `active` must always name an account
 * that exists, because every scoped store read and write in the app is keyed on
 * it. An `active` pointing at a removed account would leave the previous
 * mailbox's keyring and drafts on screen with nothing to write them back to.
 */
import { accountRefFor } from '../accountScope';
import { NO_ACCOUNTS, removeAccount, upsertAccount } from '../accountsStore';

const ONE = accountRefFor('demo', 'you@gmail.com');
const TWO = accountRefFor('demo', 'you@work.example');

describe('upsertAccount', () => {
  it('adds an account and puts it in front', () => {
    const state = upsertAccount(NO_ACCOUNTS, ONE);

    expect(state.accounts).toEqual([ONE]);
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

    expect(state.accounts).toEqual([renamed]);
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
