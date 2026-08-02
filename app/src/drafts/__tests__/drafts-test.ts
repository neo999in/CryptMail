import { Draft, Drafts, isDraftEmpty, listDrafts, removeDraft, upsertDraft } from '../drafts';

function draft(id: string, updatedAt: string, over: Partial<Draft> = {}): Draft {
  return { id, to: ['a@b.com'], subject: 's', body: 'b', updatedAt, ...over };
}

describe('isDraftEmpty', () => {
  test('is empty with no recipients and blank subject and body', () => {
    expect(isDraftEmpty({ to: [], subject: '', body: '' })).toBe(true);
  });

  test('treats whitespace-only subject and body as empty', () => {
    expect(isDraftEmpty({ to: [], subject: '   ', body: '\n\t ' })).toBe(true);
  });

  test('is not empty when there is a recipient', () => {
    expect(isDraftEmpty({ to: ['a@b.com'], subject: '', body: '' })).toBe(false);
  });

  test('is not empty when subject or body has content', () => {
    expect(isDraftEmpty({ to: [], subject: 'Hi', body: '' })).toBe(false);
    expect(isDraftEmpty({ to: [], subject: '', body: 'text' })).toBe(false);
  });
});

describe('upsertDraft', () => {
  test('adds a draft by id', () => {
    const next = upsertDraft({}, draft('d1', '2026-07-23T10:00:00Z'));
    expect(next.d1.subject).toBe('s');
  });

  test('overwrites an existing draft without mutating the input', () => {
    const before: Drafts = { d1: draft('d1', '2026-07-23T10:00:00Z', { subject: 'old' }) };
    const next = upsertDraft(before, draft('d1', '2026-07-23T11:00:00Z', { subject: 'new' }));
    expect(next.d1.subject).toBe('new');
    expect(before.d1.subject).toBe('old');
  });
});

describe('removeDraft', () => {
  test('removes a draft by id', () => {
    const next = removeDraft({ d1: draft('d1', '2026-07-23T10:00:00Z') }, 'd1');
    expect(next.d1).toBeUndefined();
  });

  test('a missing id is a no-op and does not mutate the input', () => {
    const before: Drafts = { d1: draft('d1', '2026-07-23T10:00:00Z') };
    const next = removeDraft(before, 'nope');
    expect(Object.keys(next)).toEqual(['d1']);
    expect(before.d1).toBeDefined();
  });
});

describe('listDrafts', () => {
  test('returns drafts newest first by updatedAt', () => {
    const drafts: Drafts = {
      old: draft('old', '2026-07-23T08:00:00Z'),
      new: draft('new', '2026-07-23T12:00:00Z'),
      mid: draft('mid', '2026-07-23T10:00:00Z'),
    };
    expect(listDrafts(drafts).map((d) => d.id)).toEqual(['new', 'mid', 'old']);
  });

  test('is empty for an empty store', () => {
    expect(listDrafts({})).toEqual([]);
  });
});
