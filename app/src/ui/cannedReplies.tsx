/**
 * The live canned replies.
 *
 * Here and not in `state/` for the reason `ui/mailPrefs.tsx` is: a saved
 * snippet touches none of the five subsystems. It is text the writer keeps on
 * this device; inserting it is an edit to a body Compose already owns, and
 * sending that body still goes through `useApp()` like any other.
 *
 * Reading it: `useCannedReplies()`. Writes apply at once and persist behind,
 * but unlike a preference they are the user's writing, so a failed write is
 * rethrown for the editor to report rather than swallowed.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { initStorage } from '../store';
import {
  CannedReply,
  loadCannedReplies,
  removeCannedReply,
  saveCannedReplies,
  upsertCannedReply,
} from '../store/cannedRepliesStore';

type CannedRepliesState = {
  replies: CannedReply[];
  /** True until the stored list has been read. */
  loading: boolean;
  /** Add or replace one. Throws with a sentence when it cannot be saved. */
  saveReply: (reply: CannedReply) => Promise<void>;
  deleteReply: (id: string) => Promise<void>;
};

const CannedRepliesContext = createContext<CannedRepliesState | null>(null);

export function CannedRepliesProvider({ children }: { children: React.ReactNode }) {
  const [replies, setReplies] = useState<CannedReply[]>([]);
  const [loading, setLoading] = useState(true);
  // Writes read the current list from here, not a render-time snapshot, so two
  // saves in quick succession cannot each start from the list before the other.
  const current = useRef<CannedReply[]>([]);

  const apply = useCallback(async (next: CannedReply[]) => {
    current.current = next;
    setReplies(next);
    await saveCannedReplies(next);
  }, []);

  useEffect(() => {
    let live = true;
    // A sibling of `AppState`'s provider, so storage is not guaranteed ready —
    // see `ui/mailPrefs.tsx`. `initStorage()` is memoised.
    initStorage()
      .then(() => loadCannedReplies())
      .then((stored) => {
        if (!live) return;
        current.current = stored;
        setReplies(stored);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const saveReply = useCallback(
    (reply: CannedReply) => apply(upsertCannedReply(current.current, reply)),
    [apply],
  );
  const deleteReply = useCallback((id: string) => apply(removeCannedReply(current.current, id)), [apply]);

  const value = useMemo(
    () => ({ replies, loading, saveReply, deleteReply }),
    [deleteReply, loading, replies, saveReply],
  );
  return <CannedRepliesContext.Provider value={value}>{children}</CannedRepliesContext.Provider>;
}

export function useCannedReplies(): CannedRepliesState {
  const ctx = useContext(CannedRepliesContext);
  if (!ctx) throw new Error('useCannedReplies must be used within a CannedRepliesProvider');
  return ctx;
}
