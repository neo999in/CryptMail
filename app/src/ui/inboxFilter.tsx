/**
 * The active inbox category, shared as view-state between the drawer and the
 * inbox list.
 *
 * This is UI state, not a domain subsystem, so it deliberately lives here rather
 * than in `AppState`: the category filter never touches mail, keys, or the send
 * path — it only decides which already-loaded rows the inbox renders. `null`
 * means "All mail" (no category filter).
 */
import React, { createContext, useContext, useMemo, useState } from 'react';

import { Category } from '../categorizer/categorizer';

type CategoryFilter = {
  category: Category | null;
  setCategory: (category: Category | null) => void;
};

const CategoryFilterContext = createContext<CategoryFilter | null>(null);

export function CategoryFilterProvider({ children }: { children: React.ReactNode }) {
  const [category, setCategory] = useState<Category | null>(null);
  const value = useMemo(() => ({ category, setCategory }), [category]);
  return <CategoryFilterContext.Provider value={value}>{children}</CategoryFilterContext.Provider>;
}

export function useCategoryFilter(): CategoryFilter {
  const ctx = useContext(CategoryFilterContext);
  if (!ctx) throw new Error('useCategoryFilter must be used within a CategoryFilterProvider');
  return ctx;
}
