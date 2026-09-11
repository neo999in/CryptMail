/**
 * The newest value of something, readable from a callback that was built once.
 *
 * For the handlers a list hands to every row. A handler that closed over the
 * list's data would have to be rebuilt whenever that data changed, and a new
 * handler is a new prop on every row — so every row would re-render just to
 * receive it. Reading through this instead keeps the handler's identity for the
 * life of the list while it still acts on what is on screen now.
 *
 * Written after commit, not during render: a render React throws away must not
 * leave its value behind. Handlers run on input, which always comes after a
 * commit, so they never see the gap.
 *
 * Not for app state — that is `store.get()` (`state/store.ts`). This is for data
 * a screen derives for itself.
 */
import { useLayoutEffect, useRef } from 'react';

export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
