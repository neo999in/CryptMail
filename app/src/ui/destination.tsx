/**
 * What the home screen is showing — shared as view-state between the drawer and
 * the screen itself.
 *
 * Every row in the drawer is one of these, and **none of them is a navigation**.
 * Picking Sent is the same gesture as picking Bills: the home screen stays where
 * it is, its bar keeps the account avatar that opens the drawer, and only the
 * body under the bar changes. Sent and Archive are still their own provider
 * fetch and Drafts and Scheduled are still their own local stores — but that is
 * a fact about where rows come from, not a reason to push a screen, and pushing
 * one made half the drawer feel like a different app with a back button.
 * Contacts is here for the same reason: it holds people rather than mail, but it
 * is still a list the drawer reaches, and it should not be the one row that
 * arrives with a back arrow and a header of its own.
 *
 * This is UI state, not a domain subsystem, so it lives here rather than in
 * `AppState`: it never touches mail, keys or the send path — it only decides
 * which body the home screen renders. `'inbox'` is everything, unfiltered.
 */
import React, { createContext, useContext, useMemo, useState } from 'react';

import { Category } from '../categorizer/categorizer';
import { SecondaryBox } from '../state/types';

export type Destination = 'inbox' | Category | SecondaryBox | 'drafts' | 'scheduled' | 'contacts';

type DestinationState = {
  destination: Destination;
  setDestination: (destination: Destination) => void;
};

const DestinationContext = createContext<DestinationState | null>(null);

export function DestinationProvider({ children }: { children: React.ReactNode }) {
  const [destination, setDestination] = useState<Destination>('inbox');
  const value = useMemo(() => ({ destination, setDestination }), [destination]);
  return <DestinationContext.Provider value={value}>{children}</DestinationContext.Provider>;
}

export function useDestination(): DestinationState {
  const ctx = useContext(DestinationContext);
  if (!ctx) throw new Error('useDestination must be used within a DestinationProvider');
  return ctx;
}

const CATEGORIES: Destination[] = ['primary', 'purchases', 'bills', 'promotions', 'spam'];

/** The category a destination filters the inbox by, or `null` for all mail. */
export function categoryOf(destination: Destination): Category | null {
  return CATEGORIES.includes(destination) ? (destination as Category) : null;
}

/** Whether this destination is a filter over the inbox rather than its own list. */
export function isInboxDestination(destination: Destination): boolean {
  return destination === 'inbox' || categoryOf(destination) !== null;
}
