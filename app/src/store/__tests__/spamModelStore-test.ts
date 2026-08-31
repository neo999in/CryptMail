/**
 * What survives a restart, and what a damaged file is allowed to do.
 *
 * Two properties are pinned here.
 *
 * The first is recovery. A truncated write, a hand-edited value or a model written
 * by a future version of the app would all parse as JSON and then poison every
 * verdict the engine produced. So the load path validates structurally, and the
 * two halves are validated *independently*: a corrupted model with intact marks
 * keeps the marks, because a training corpus can be rebuilt by marking a few more
 * messages while the user's own decisions cannot be regenerated at all.
 *
 * The second is that a mark is a decision, not a cache. A message the user moved
 * out of spam must not drift back the next time the app opens, which is why the
 * marks are stored at all and why `setMark` is exercised down to its ordering.
 */
import { emptyModel, SPAM_MODEL_VERSION, train, type SpamModel } from '../../spam/bayes';
import type { SpamMark } from '../../spam/types';
import { emptySpamState, normaliseSpamState, setMark, type SpamState } from '../spamModelStore';

/** A model with something in it, so "kept" is distinguishable from "reset". */
const trained = (): SpamModel =>
  train(
    emptyModel(),
    { from: { address: 'promo@coin-blast.example' }, subject: 'Bitcoin doubling', body: 'Send bitcoin to our wallet.' },
    'spam',
  );

const marksOf = (state: SpamState): Record<string, SpamMark> => state.marks;

describe('normaliseSpamState', () => {
  it('returns an empty state for a store that has never been written', () => {
    expect(normaliseSpamState(null)).toEqual(emptySpamState());
    expect(normaliseSpamState(undefined)).toEqual(emptySpamState());
  });

  it('keeps a well-formed record exactly as it was', () => {
    const state: SpamState = { model: trained(), marks: { 'msg-1': 'spam', 'msg-2': 'ham' } };
    expect(normaliseSpamState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('recovers an empty model from a value that is not a record at all', () => {
    for (const value of ['a string', 42, true, [], [1, 2, 3]]) {
      expect(normaliseSpamState(value)).toEqual(emptySpamState());
    }
  });

  it('resets a model from an incompatible version rather than reading it', () => {
    // A future version may store counts that mean something different. Reading
    // them as though they were v1 counts would misfile mail silently, which is
    // worse than asking the user to mark a few messages again.
    const future = { ...trained(), version: SPAM_MODEL_VERSION + 1 };
    const state = normaliseSpamState({ model: future, marks: { 'msg-1': 'spam' } });
    expect(state.model).toEqual(emptyModel());
    // The marks are a separate decision and are kept.
    expect(state.marks).toEqual({ 'msg-1': 'spam' });
  });

  it('resets a model whose counts are damaged', () => {
    const cases: unknown[] = [
      { ...trained(), spam: null },
      { ...trained(), ham: 'none' },
      { ...trained(), spamMessages: -1 },
      { ...trained(), hamMessages: Number.NaN },
      { ...trained(), spam: { 'b:x': -3 } },
      { ...trained(), spam: { 'b:x': Number.POSITIVE_INFINITY } },
      { ...trained(), updatedAt: {} },
    ];
    for (const model of cases) {
      expect(normaliseSpamState({ model, marks: {} }).model).toEqual(emptyModel());
    }
  });

  it('keeps the model when only the marks are damaged', () => {
    const model = trained();
    const state = normaliseSpamState({ model, marks: 'not a record' });
    expect(state.model).toEqual(model);
    expect(state.marks).toEqual({});
  });

  it('drops individual marks that are not a verdict, keeping the rest', () => {
    const state = normaliseSpamState({
      model: emptyModel(),
      marks: { 'msg-1': 'spam', 'msg-2': 'maybe', 'msg-3': 'ham', 'msg-4': null, 'msg-5': 7, '': 'spam' },
    });
    expect(marksOf(state)).toEqual({ 'msg-1': 'spam', 'msg-3': 'ham' });
  });

  it('does not read marks out of an array', () => {
    // An array would give numeric keys that can never be message ids, and treating
    // it as a record would invent marks nobody made.
    expect(normaliseSpamState({ model: emptyModel(), marks: ['spam', 'ham'] }).marks).toEqual({});
  });

  it('survives a record with unexpected extra fields', () => {
    const state = normaliseSpamState({ model: emptyModel(), marks: {}, somethingElse: { deep: [1, 2] } });
    expect(state).toEqual(emptySpamState());
  });

  it('does not throw on any of the shapes a damaged file can take', () => {
    const hostile: unknown[] = [
      Number.NaN,
      { model: 0 },
      { marks: 0 },
      { model: { version: 1 } },
      { model: [], marks: [] },
      Object.create(null),
    ];
    for (const value of hostile) expect(() => normaliseSpamState(value)).not.toThrow();
  });
});

describe('emptySpamState', () => {
  it('is a fresh object each time, so two callers cannot share one model', () => {
    const a = emptySpamState();
    const b = emptySpamState();
    expect(a).toEqual(b);
    expect(a.model).not.toBe(b.model);
    expect(a.marks).not.toBe(b.marks);
  });
});

describe('setMark', () => {
  it('records a mark', () => {
    expect(setMark({}, 'msg-1', 'spam')).toEqual({ 'msg-1': 'spam' });
  });

  it('replaces a mark when the user changes their mind', () => {
    expect(setMark({ 'msg-1': 'spam' }, 'msg-1', 'ham')).toEqual({ 'msg-1': 'ham' });
  });

  it('clears a mark, returning the message to the engine’s judgement', () => {
    expect(setMark({ 'msg-1': 'spam', 'msg-2': 'ham' }, 'msg-1', null)).toEqual({ 'msg-2': 'ham' });
  });

  it('does not mutate the record it is given', () => {
    const before: Record<string, SpamMark> = { 'msg-1': 'spam' };
    setMark(before, 'msg-2', 'ham');
    setMark(before, 'msg-1', null);
    expect(before).toEqual({ 'msg-1': 'spam' });
  });

  it('returns the same record unchanged when there is nothing to do', () => {
    const marks: Record<string, SpamMark> = { 'msg-1': 'spam' };
    // Identity, not just equality: an unchanged reference is what lets the caller
    // skip a write to sealed storage.
    expect(setMark(marks, 'msg-2', null)).toBe(marks);
    expect(setMark(marks, '', 'spam')).toBe(marks);
  });

  it('moves a re-marked message to the end of the order', () => {
    // Insertion order is what makes "oldest" meaningful when the marks are trimmed,
    // so touching a mark has to count as recent activity.
    let marks: Record<string, SpamMark> = {};
    for (const id of ['a', 'b', 'c']) marks = setMark(marks, id, 'spam');
    marks = setMark(marks, 'a', 'ham');
    expect(Object.keys(marks)).toEqual(['b', 'c', 'a']);
  });
});
