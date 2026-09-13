/**
 * Local labels — the user's own names for groups of mail (pure).
 *
 * **Local, and deliberately so.** The provider never learns a label's name or
 * which messages carry it. Gmail could hold them natively (`labels.create` +
 * `messages.modify`), but a label is a statement about content: "Lawyer",
 * "Diagnosis", "Payroll" filed onto a message the provider only ever sees as
 * ciphertext would hand it, in cleartext, exactly the summary the encryption
 * exists to withhold (docs/gmail-api-adoption.md §3). So labels live in a
 * per-account sealed store beside the search index, and every other client on
 * the account simply does not see them.
 *
 * Two maps rather than a label list on each message: renaming a label must be
 * one write, not a walk over every message that carries it, and deleting one
 * has to take it off everything at once.
 *
 * No storage, no React — persistence is `store/labelsStore.ts`, wiring is
 * `state/labels.ts`.
 */

export type Label = {
  id: string;
  name: string;
  createdAt: string;
};

export type LabelState = {
  /** Every label this mailbox has, by id. */
  labels: Record<string, Label>;
  /** Which labels each message carries, by message id. Never an empty array. */
  applied: Record<string, string[]>;
};

export const emptyLabelState = (): LabelState => ({ labels: {}, applied: {} });

/** A label name as it is stored: trimmed, inner whitespace collapsed, capped. */
export const MAX_LABEL_NAME = 40;

export function cleanLabelName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_NAME);
}

/**
 * Why a name cannot be used for a label, or `null` when it can.
 *
 * Names are unique case-insensitively: two labels that read the same on a row
 * would be two filters that look like one. `except` is the label being renamed,
 * which may of course keep its own name.
 */
export function labelNameProblem(state: LabelState, name: string, except?: string): string | null {
  const clean = cleanLabelName(name);
  if (!clean) return 'Give the label a name.';
  const taken = Object.values(state.labels).some(
    (label) => label.id !== except && label.name.toLowerCase() === clean.toLowerCase(),
  );
  return taken ? `There is already a label called “${clean}”.` : null;
}

/** Every label, alphabetically — the order every picker and list shows. */
export function listLabels(state: LabelState): Label[] {
  return Object.values(state.labels).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

/** Add a label. Throws with the reason when the name cannot be used. */
export function createLabel(state: LabelState, name: string, id: string, now: string): LabelState {
  const problem = labelNameProblem(state, name);
  if (problem) throw new Error(problem);
  return {
    ...state,
    labels: { ...state.labels, [id]: { id, name: cleanLabelName(name), createdAt: now } },
  };
}

export function renameLabel(state: LabelState, id: string, name: string): LabelState {
  const label = state.labels[id];
  if (!label) return state;
  const problem = labelNameProblem(state, name, id);
  if (problem) throw new Error(problem);
  return { ...state, labels: { ...state.labels, [id]: { ...label, name: cleanLabelName(name) } } };
}

/** Remove a label, and take it off every message that carried it. */
export function deleteLabel(state: LabelState, id: string): LabelState {
  if (!state.labels[id]) return state;
  const labels = { ...state.labels };
  delete labels[id];
  const applied: Record<string, string[]> = {};
  for (const [messageId, ids] of Object.entries(state.applied)) {
    const kept = ids.filter((labelId) => labelId !== id);
    if (kept.length > 0) applied[messageId] = kept;
  }
  return { labels, applied };
}

export type LabelChange = { add?: string[]; remove?: string[] };

/**
 * Put labels on, and take labels off, a set of messages.
 *
 * An id that names no label is ignored rather than stored — a label deleted
 * while a picker was open must not come back as a dangling reference. A
 * message left with no labels is dropped from `applied`, so the map only ever
 * grows with mail that is actually labelled.
 */
export function applyLabels(state: LabelState, messageIds: string[], change: LabelChange): LabelState {
  const add = (change.add ?? []).filter((id) => state.labels[id]);
  const remove = new Set(change.remove ?? []);
  const applied = { ...state.applied };
  for (const messageId of messageIds) {
    const current = applied[messageId] ?? [];
    const next = [...current.filter((id) => !remove.has(id))];
    for (const id of add) if (!next.includes(id)) next.push(id);
    if (next.length > 0) applied[messageId] = next;
    else delete applied[messageId];
  }
  return { ...state, applied };
}

/** The labels on one message, alphabetically. */
export function labelsOn(state: LabelState, messageId: string): Label[] {
  return (state.applied[messageId] ?? [])
    .map((id) => state.labels[id])
    .filter((label): label is Label => !!label)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * The label names a row shows — the union over every message it stands for.
 *
 * A conversation row carries a label when any message in it does, which is
 * how a thread is filed in every client that threads: labelling the reply you
 * got is labelling the conversation.
 */
export function labelNamesFor(state: LabelState, messageIds: string[]): string[] {
  const ids = new Set(messageIds.flatMap((id) => state.applied[id] ?? []));
  return listLabels(state)
    .filter((label) => ids.has(label.id))
    .map((label) => label.name);
}

/** Whether any of these messages carries the label. */
export function hasLabel(state: LabelState, messageIds: string[], labelId: string): boolean {
  return messageIds.some((id) => state.applied[id]?.includes(labelId));
}

/**
 * How a label sits across a selection: on all of it, some of it, or none.
 *
 * What the bulk picker draws — a check, a dash, or nothing — and what decides
 * whether a tap adds the label (not on everything yet) or removes it.
 */
export function labelCoverage(state: LabelState, messageIds: string[], labelId: string): 'all' | 'some' | 'none' {
  const carrying = messageIds.filter((id) => state.applied[id]?.includes(labelId)).length;
  if (carrying === 0) return 'none';
  return carrying === messageIds.length ? 'all' : 'some';
}

/** How many messages this device has filed under each label. */
export function labelCounts(state: LabelState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ids of Object.values(state.applied)) {
    for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

/** Tolerate a stored blob from an older or damaged write. */
export function normaliseLabelState(raw: Partial<LabelState> | null | undefined): LabelState {
  const labels = raw?.labels && typeof raw.labels === 'object' ? raw.labels : {};
  const applied: Record<string, string[]> = {};
  for (const [messageId, ids] of Object.entries(raw?.applied ?? {})) {
    if (!Array.isArray(ids)) continue;
    const kept = ids.filter((id) => typeof id === 'string' && labels[id]);
    if (kept.length > 0) applied[messageId] = kept;
  }
  return { labels, applied };
}
