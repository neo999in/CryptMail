import { MailSummary } from '../../mail/types';
import {
  applyRules,
  describeActions,
  describeConditions,
  draftRuleFrom,
  dropLabelFromRules,
  emptyRulesState,
  matchRule,
  NO_ACTIONS,
  pruneFired,
  removeRule,
  Rule,
  ruleProblem,
  RulesState,
  upsertRule,
} from '../rules';

const PLACEHOLDER = '[Encrypted message]';

function summary(over: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    from: { address: 'billing@acme.test', name: 'Acme Billing' },
    to: ['me@example.com'],
    date: '2026-09-13T10:00:00.000Z',
    subject: 'Your invoice for September',
    snippet: 'Amount due: 40.00',
    unread: true,
    starred: false,
    ...over,
  };
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Invoices',
    enabled: true,
    conditions: [{ field: 'subject', contains: 'invoice' }],
    actions: { ...NO_ACTIONS, star: true },
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const state = (...rules: Rule[]): RulesState => ({ rules, fired: {} });
const labelIds = new Set(['l1']);

describe('matching', () => {
  it('matches the sender by name or address, case-insensitively', () => {
    const input = { summary: summary(), encrypted: false };
    expect(matchRule({ conditions: [{ field: 'from', contains: 'ACME.TEST' }] }, input, {})).toBe(true);
    expect(matchRule({ conditions: [{ field: 'from', contains: 'acme billing' }] }, input, {})).toBe(true);
    expect(matchRule({ conditions: [{ field: 'from', contains: 'someone' }] }, input, {})).toBe(false);
  });

  it('requires every condition', () => {
    const input = { summary: summary(), encrypted: false };
    const both = [
      { field: 'from' as const, contains: 'acme' },
      { field: 'content' as const, contains: 'amount due' },
    ];
    expect(matchRule({ conditions: both }, input, {})).toBe(true);
    expect(matchRule({ conditions: [...both, { field: 'subject', contains: 'october' }] }, input, {})).toBe(false);
  });

  it('never matches an empty condition, or a rule with none', () => {
    const input = { summary: summary(), encrypted: false };
    expect(matchRule({ conditions: [] }, input, {})).toBe(false);
    expect(matchRule({ conditions: [{ field: 'subject', contains: '  ' }] }, input, {})).toBe(false);
  });

  describe('encrypted mail', () => {
    const sealed = summary({ subject: PLACEHOLDER, snippet: '-----BEGIN PGP MESSAGE----- invoice' });

    it('does not read the subject or body until this device has decrypted it', () => {
      const input = { summary: sealed, encrypted: true };
      // Neither the placeholder nor the ciphertext snippet is a stand-in.
      expect(matchRule({ conditions: [{ field: 'content', contains: 'invoice' }] }, input, {})).toBe(false);
      expect(matchRule({ conditions: [{ field: 'subject', contains: 'encrypted' }] }, input, {})).toBe(false);
    });

    it('reads the decrypted content once it is indexed', () => {
      const index = { m1: { subject: 'Invoice #42', body: 'Private numbers' } };
      const input = { summary: sealed, encrypted: true };
      expect(matchRule({ conditions: [{ field: 'subject', contains: 'invoice' }] }, input, index)).toBe(true);
      expect(matchRule({ conditions: [{ field: 'content', contains: 'private' }] }, input, index)).toBe(true);
      expect(matchRule({ conditions: [{ field: 'subject', contains: 'private' }] }, input, index)).toBe(false);
    });

    it('matches the sender, which is cleartext, without decrypting anything', () => {
      const input = { summary: sealed, encrypted: true };
      expect(matchRule({ conditions: [{ field: 'from', contains: 'acme' }] }, input, {})).toBe(true);
    });
  });
});

describe('applying', () => {
  it('turns matching actions into flag changes and labels', () => {
    const r = rule({ actions: { star: true, markRead: true, archive: true, labelId: 'l1' } });
    const { outcomes, fired } = applyRules([{ summary: summary(), encrypted: false }], {}, state(r), { labelIds });
    expect(outcomes).toEqual([
      { id: 'm1', flags: { starred: true, unread: false, archived: true }, addLabels: ['l1'], rules: ['r1'] },
    ]);
    expect(fired).toEqual({ m1: ['r1'] });
  });

  it('leaves out changes that change nothing, but still records the rule as fired', () => {
    const r = rule({ actions: { ...NO_ACTIONS, star: true, markRead: true } });
    const input = { summary: summary({ starred: true, unread: false }), encrypted: false };
    const { outcomes, fired } = applyRules([input], {}, state(r), { labelIds });
    expect(outcomes[0].flags).toEqual({});
    expect(fired).toEqual({ m1: ['r1'] });
  });

  it('fires once per message, so a user who undoes it is not overruled', () => {
    const first = applyRules([{ summary: summary(), encrypted: false }], {}, state(rule()), { labelIds });
    const again = applyRules(
      [{ summary: summary({ starred: false }), encrypted: false }],
      {},
      { rules: [rule()], fired: first.fired },
      { labelIds },
    );
    expect(again.outcomes).toEqual([]);
  });

  it('skips disabled and unsaveable rules, and labels that are gone', () => {
    const off = rule({ id: 'off', enabled: false });
    const empty = rule({ id: 'empty', conditions: [] });
    const orphan = rule({ id: 'orphan', actions: { ...NO_ACTIONS, labelId: 'deleted' } });
    const { outcomes } = applyRules([{ summary: summary(), encrypted: false }], {}, state(off, empty, orphan), {
      labelIds,
    });
    expect(outcomes).toEqual([{ id: 'm1', flags: {}, addLabels: [], rules: ['orphan'] }]);
  });

  it('asks before archiving', () => {
    const r = rule({ actions: { ...NO_ACTIONS, archive: true } });
    const { outcomes } = applyRules([{ summary: summary(), encrypted: false }], {}, state(r), {
      labelIds,
      canArchive: () => false,
    });
    expect(outcomes[0].flags).toEqual({});
  });

  it('does not fire on an encrypted message it cannot read yet, and does once it can', () => {
    const sealed = { summary: summary({ subject: PLACEHOLDER }), encrypted: true };
    const before = applyRules([sealed], {}, state(rule()), { labelIds });
    expect(before.outcomes).toEqual([]);
    expect(before.fired).toEqual({});

    const index = { m1: { subject: 'Invoice', body: '' } };
    const after = applyRules([sealed], index, { rules: [rule()], fired: before.fired }, { labelIds });
    expect(after.outcomes.map((o) => o.flags)).toEqual([{ starred: true }]);
  });
});

describe('editing', () => {
  it('refuses a rule with no condition, an empty condition, or no action', () => {
    expect(ruleProblem(rule({ conditions: [] }))).toMatch('condition');
    expect(ruleProblem(rule({ conditions: [{ field: 'from', contains: ' ' }] }))).toMatch('text');
    expect(ruleProblem(rule({ actions: NO_ACTIONS }))).toMatch('Choose');
    expect(ruleProblem(rule())).toBeNull();
  });

  it('upserts in place and removes with its fired record', () => {
    let s = upsertRule(emptyRulesState(), rule());
    s = upsertRule(s, rule({ id: 'r2' }));
    s = upsertRule(s, rule({ name: 'Renamed' }));
    expect(s.rules.map((r) => [r.id, r.name])).toEqual([
      ['r1', 'Renamed'],
      ['r2', 'Invoices'],
    ]);

    s = { ...s, fired: { m1: ['r1', 'r2'], m2: ['r1'] } };
    s = removeRule(s, 'r1');
    expect(s.rules.map((r) => r.id)).toEqual(['r2']);
    expect(s.fired).toEqual({ m1: ['r2'] });
  });

  it('drops a deleted label from the rules that used it', () => {
    const s = dropLabelFromRules(state(rule({ actions: { ...NO_ACTIONS, star: true, labelId: 'l1' } })), 'l1');
    expect(s.rules[0].actions).toEqual({ ...NO_ACTIONS, star: true });
  });

  it('prunes the fired record only past the cap, keeping what is on screen', () => {
    const fired = { a: ['r'], b: ['r'], c: ['r'] };
    expect(pruneFired(fired, new Set(['a']), 5)).toBe(fired);
    expect(pruneFired(fired, new Set(['a']), 2)).toEqual({ a: ['r'] });
  });
});

describe('words', () => {
  it('drafts from the sender, offering a subject only when readable', () => {
    expect(draftRuleFrom({ summary: summary(), encrypted: false }, {})).toEqual({
      from: 'billing@acme.test',
      subject: 'Your invoice for September',
    });
    expect(draftRuleFrom({ summary: summary({ subject: PLACEHOLDER }), encrypted: true }, {}).subject).toBeNull();
  });

  it('describes conditions and actions', () => {
    expect(describeConditions(rule().conditions)).toBe('Subject contains “invoice”');
    expect(describeActions({ star: true, markRead: false, archive: true, labelId: 'l1' }, () => 'Bills')).toBe(
      'Star, archive, label “Bills”',
    );
    expect(describeActions(NO_ACTIONS)).toBe('Does nothing');
  });
});
