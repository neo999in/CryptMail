/**
 * Filters & rules, and local labels, through the state layer.
 *
 * What features.md 0.1 and 0.2 call "done", as tests:
 *
 * - a rule applies to a matching message on the next refresh, and only once;
 * - it never fires on content this device has not decrypted — and does fire
 *   the moment `openMessage` has decrypted it;
 * - what a rule did is written to the account's store, so it is not redone;
 * - archiving several messages updates the list at once and reaches the
 *   provider for each, and a refresh the provider answers without them keeps
 *   them gone;
 * - labels never reach the provider.
 */
import { FlagPatch, Mailbox, MailClient, MailSummary } from '../../mail/types';
import { NO_ACTIONS } from '../../rules/rules';
import { accountIdFor } from '../../store/accountScope';
import { saveLabels } from '../../store/labelsStore';
import { saveRules } from '../../store/rulesStore';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem, State } from '../types';

const ACCOUNT = accountIdFor('gmail', 'me@example.com');
const PLACEHOLDER = '[Encrypted message]';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../store/searchIndex', () => ({
  ...jest.requireActual('../../store/searchIndex'),
  saveSearchIndex: jest.fn(async () => {}),
  loadSearchIndex: jest.fn(async () => ({})),
}));

jest.mock('../../store/keyring', () => ({
  ...jest.requireActual('../../store/keyring'),
  saveKeyring: jest.fn(async () => {}),
  loadKeyring: jest.fn(async () => ({})),
}));

jest.mock('../../store/labelsStore', () => ({
  ...jest.requireActual('../../store/labelsStore'),
  saveLabels: jest.fn(async () => {}),
}));

jest.mock('../../store/rulesStore', () => ({
  ...jest.requireActual('../../store/rulesStore'),
  saveRules: jest.fn(async () => {}),
}));

jest.mock('../../core', () => {
  const actual = jest.requireActual('../../core');
  return {
    ...actual,
    core: {
      ...actual.core,
      looksEncrypted: (raw: string) => raw.startsWith('ENC:'),
      parseEncrypted: async (raw: string) => ({
        subject: raw.slice(4),
        body: 'decrypted body',
        attachments: [],
      }),
    },
  };
});

function row(id: string, over: Partial<MailSummary> = {}): MailSummary {
  return {
    id,
    from: { address: 'billing@acme.test' },
    to: ['me@example.com'],
    date: '2026-09-13T10:00:00.000Z',
    subject: `Invoice ${id}`,
    snippet: 'Amount due.',
    unread: true,
    starred: false,
    ...over,
  };
}

const tagged = (summary: MailSummary): InboxItem => ({ ...summary, account: ACCOUNT });

function client(inbox: () => MailSummary[], raw: Record<string, string> = {}) {
  const flagged: { id: string; patch: FlagPatch }[] = [];
  const impl: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    async list(box: Mailbox) {
      return { messages: box === 'inbox' ? inbox() : [] };
    },
    getRaw: async (id) => raw[id] ?? '',
    send: async () => {},
    async updateFlags(id, patch) {
      flagged.push({ id, patch });
    },
  };
  return { impl, flagged };
}

function harness(over: Partial<State>, impl: ReturnType<typeof client>) {
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
      ...over,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  mail.current = impl.impl;
  mail.clients.set(ACCOUNT, impl.impl);
  return { store, services, ...impl };
}

const settle = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

beforeEach(() => jest.clearAllMocks());

it('applies a saved rule on the next refresh, once, and persists what fired', async () => {
  let inbox = [row('m1'), row('m2', { from: { address: 'friend@example.com' }, subject: 'Hello' })];
  const impl = client(() => inbox);
  const { store, services, flagged } = harness({}, impl);

  await services.rules.saveRule({
    name: 'Invoices',
    enabled: true,
    conditions: [{ field: 'subject', contains: 'invoice' }],
    actions: { ...NO_ACTIONS, star: true, markRead: true },
  });
  await services.mailbox.refreshInbox();

  expect(flagged).toEqual([{ id: 'm1', patch: { starred: true, unread: false } }]);
  const m1 = store.get().messages.find((m) => m.id === 'm1');
  expect(m1).toMatchObject({ starred: true, unread: false });
  expect(saveRules).toHaveBeenLastCalledWith(ACCOUNT, expect.objectContaining({ fired: { m1: [expect.any(String)] } }));

  // The user un-stars it by hand; the provider agrees. The next sync must not
  // star it again.
  inbox = [row('m1', { starred: false, unread: false }), inbox[1]];
  flagged.length = 0;
  await services.mailbox.refreshInbox();
  expect(flagged).toEqual([]);
});

it('never fires on an encrypted message until this device has decrypted it', async () => {
  const sealed = row('e1', { subject: PLACEHOLDER, snippet: 'ciphertext invoice' });
  const impl = client(() => [sealed], { e1: 'ENC:Invoice from Acme' });
  const { store, services, flagged } = harness({}, impl);

  await services.rules.saveRule({
    name: 'Invoices',
    enabled: true,
    conditions: [{ field: 'subject', contains: 'invoice' }],
    actions: { ...NO_ACTIONS, star: true },
  });
  await services.mailbox.refreshInbox();
  expect(flagged).toEqual([]);
  expect(store.get().rules.fired).toEqual({});

  await services.mailbox.openMessage(store.get().messages[0]);
  await settle();

  expect(flagged).toEqual([{ id: 'e1', patch: { starred: true } }]);
});

it('files matching mail under a label, locally, without telling the provider', async () => {
  const impl = client(() => [row('m1')]);
  const { store, services, flagged } = harness({}, impl);
  const label = await services.labels.createLabel('Bills');

  await services.rules.saveRule({
    name: 'Bills',
    enabled: true,
    conditions: [{ field: 'from', contains: 'acme' }],
    actions: { ...NO_ACTIONS, labelId: label.id },
  });
  await services.mailbox.refreshInbox();

  expect(store.get().labels.applied).toEqual({ m1: [label.id] });
  expect(saveLabels).toHaveBeenCalled();
  expect(flagged).toEqual([]);
});

it('leaves a merged row from another mailbox to that mailbox’s own rules', async () => {
  const other = accountIdFor('gmail', 'other@example.com');
  const impl = client(() => []);
  const { store, services, flagged } = harness(
    { messages: [{ ...row('x1'), account: other }, tagged(row('m1'))] },
    impl,
  );

  await services.rules.saveRule({
    name: 'All Acme',
    enabled: true,
    conditions: [{ field: 'from', contains: 'acme' }],
    actions: { ...NO_ACTIONS, star: true },
  });

  expect(flagged.map((f) => f.id)).toEqual(['m1']);
  expect(Object.keys(store.get().rules.fired)).toEqual(['m1']);
});

it('deleting a label takes it off messages and off the rules that used it', async () => {
  const impl = client(() => []);
  const { store, services } = harness({ messages: [tagged(row('m1'))] }, impl);
  const label = await services.labels.createLabel('Bills');
  await services.labels.setLabels(['m1'], { add: [label.id] });
  await services.rules.saveRule({
    name: 'Bills',
    enabled: true,
    conditions: [{ field: 'from', contains: 'nobody' }],
    actions: { ...NO_ACTIONS, star: true, labelId: label.id },
  });

  await services.labels.deleteLabel(label.id);

  expect(store.get().labels).toEqual({ labels: {}, applied: {} });
  expect(store.get().rules.rules[0].actions).toEqual({ ...NO_ACTIONS, star: true });
});

it('archives three selected messages at once, and a refresh keeps them archived', async () => {
  let inbox = [row('m1'), row('m2'), row('m3'), row('m4')];
  const impl = client(() => inbox);
  const { store, services, flagged } = harness({ messages: inbox.map(tagged) }, impl);

  const archiving = Promise.all(['m1', 'm2', 'm3'].map((id) => services.mailbox.archiveMessage(id)));
  // Optimistic: the rows are gone before any provider call has returned.
  expect(store.get().messages.map((m) => m.id)).toEqual(['m4']);
  await archiving;
  expect(flagged.map((f) => f.id).sort()).toEqual(['m1', 'm2', 'm3']);

  inbox = [row('m4')];
  await services.mailbox.refreshInbox();
  expect(store.get().messages.map((m) => m.id)).toEqual(['m4']);
});

it('refuses a rule that would act on everything', async () => {
  const { services } = harness({}, client(() => []));
  await expect(
    services.rules.saveRule({
      name: 'Oops',
      enabled: true,
      conditions: [{ field: 'from', contains: '' }],
      actions: { ...NO_ACTIONS, archive: true },
    }),
  ).rejects.toThrow('needs some text');
});
