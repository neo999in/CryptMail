import {
  applyLabels,
  createLabel,
  deleteLabel,
  emptyLabelState,
  labelCounts,
  labelCoverage,
  labelNameProblem,
  labelNamesFor,
  labelsOn,
  listLabels,
  normaliseLabelState,
  renameLabel,
} from '../labels';

const NOW = '2026-09-13T10:00:00.000Z';

function withLabels(...names: string[]) {
  return names.reduce((state, name, i) => createLabel(state, name, `l${i + 1}`, NOW), emptyLabelState());
}

describe('creating and naming', () => {
  it('stores a trimmed, collapsed name', () => {
    const state = createLabel(emptyLabelState(), '  Tax   2026 ', 'l1', NOW);
    expect(state.labels.l1).toEqual({ id: 'l1', name: 'Tax 2026', createdAt: NOW });
  });

  it('refuses an empty name and a duplicate that differs only in case', () => {
    const state = withLabels('Work');
    expect(() => createLabel(state, '   ', 'l2', NOW)).toThrow('Give the label a name.');
    expect(() => createLabel(state, 'work', 'l2', NOW)).toThrow('already a label');
  });

  it('lets a label be renamed to its own name in a different case', () => {
    const state = renameLabel(withLabels('work'), 'l1', 'Work');
    expect(state.labels.l1.name).toBe('Work');
    expect(labelNameProblem(withLabels('A', 'B'), 'b', 'l1')).toMatch('already');
  });

  it('lists alphabetically, ignoring case', () => {
    expect(listLabels(withLabels('beta', 'Alpha', 'gamma')).map((l) => l.name)).toEqual(['Alpha', 'beta', 'gamma']);
  });
});

describe('applying', () => {
  it('adds and removes without duplicating', () => {
    let state = withLabels('Work', 'Family');
    state = applyLabels(state, ['m1', 'm2'], { add: ['l1'] });
    state = applyLabels(state, ['m1'], { add: ['l1', 'l2'] });
    expect(state.applied).toEqual({ m1: ['l1', 'l2'], m2: ['l1'] });

    state = applyLabels(state, ['m2'], { remove: ['l1'] });
    // A message left with nothing is dropped, so the map only holds labelled mail.
    expect(state.applied).toEqual({ m1: ['l1', 'l2'] });
  });

  it('ignores a label id that no longer exists', () => {
    const state = applyLabels(withLabels('Work'), ['m1'], { add: ['gone'] });
    expect(state.applied).toEqual({});
  });

  it('deleting a label takes it off every message', () => {
    let state = withLabels('Work', 'Family');
    state = applyLabels(state, ['m1'], { add: ['l1', 'l2'] });
    state = applyLabels(state, ['m2'], { add: ['l1'] });
    state = deleteLabel(state, 'l1');
    expect(state.labels.l1).toBeUndefined();
    expect(state.applied).toEqual({ m1: ['l2'] });
  });

  it('reports names, coverage and counts', () => {
    let state = withLabels('Work', 'Family');
    state = applyLabels(state, ['m1'], { add: ['l2', 'l1'] });
    state = applyLabels(state, ['m2'], { add: ['l1'] });

    expect(labelsOn(state, 'm1').map((l) => l.name)).toEqual(['Family', 'Work']);
    // A conversation row shows the union over its messages.
    expect(labelNamesFor(state, ['m2', 'm3'])).toEqual(['Work']);
    expect(labelCoverage(state, ['m1', 'm2'], 'l1')).toBe('all');
    expect(labelCoverage(state, ['m1', 'm2'], 'l2')).toBe('some');
    expect(labelCoverage(state, ['m3'], 'l2')).toBe('none');
    expect(labelCounts(state)).toEqual({ l1: 2, l2: 1 });
  });
});

it('normalises a damaged blob instead of trusting it', () => {
  const state = normaliseLabelState({
    labels: { l1: { id: 'l1', name: 'Work', createdAt: NOW } },
    applied: { m1: ['l1', 'missing'], m2: 'nonsense' as unknown as string[], m3: ['missing'] },
  });
  expect(state.applied).toEqual({ m1: ['l1'] });
  expect(normaliseLabelState(undefined)).toEqual(emptyLabelState());
});
