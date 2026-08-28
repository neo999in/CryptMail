/**
 * The one place app state is read from and written to.
 *
 * Everything here exists to answer a single awkward question: what does a piece
 * of async work — a directory lookup, an inbox harvest, a queue drain — see when
 * it resumes after an `await`? React's `state` is a *snapshot* taken at render,
 * so the answer used to be "whatever was true when this callback was created",
 * and the file worked around it with thirteen `useRef` mirrors of individual
 * state fields, updated by hand on every render and, in several places,
 * inconsistently.
 *
 * `patch` writes the new state into `current` **synchronously** and only then
 * asks React to re-render. So `get()` is always the latest value, including in
 * the middle of an async flow, and two overlapping tasks cannot write back a
 * keyring that is missing the other's key. The mirrors are gone because there is
 * one read path.
 */
import { directory } from '../keys';
import { emptySpamState } from '../store/spamModelStore';
import { State } from './types';

export type Store = {
  /** The current state — never a render-time snapshot. */
  get(): State;
  /** Merge fields into state, visible to `get()` at once and to React next render. */
  patch(next: Partial<State>): void;
};

export function initialState(): State {
  return {
    booting: true,
    session: null,
    identity: null,
    recovery: { backedUpAt: null, fingerprint: null },
    publish: { status: 'unpublished', fingerprint: null, updatedAt: null },
    verifyLink: null,
    directoryName: directory.listedAt,
    discovering: [],
    undiscoverable: [],
    invites: {},
    keyring: {},
    searchIndex: {},
    drafts: {},
    scheduled: {},
    spam: emptySpamState(),
    messages: [],
    loadingInbox: false,
    error: null,
  };
}

export function createStore(initial: State, onChange: (next: State) => void): Store {
  let current = initial;
  return {
    get: () => current,
    patch(next) {
      current = { ...current, ...next };
      onChange(current);
    },
  };
}
