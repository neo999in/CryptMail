/**
 * The Focused / Other split.
 *
 * The case that matters is spam: it belongs to neither tab, so a phishing
 * message can never arrive quietly in a list the user skims. The completeness
 * check guards the other direction — a category added to the categorizer later
 * must be given a tab deliberately, not default into one.
 */
import { CATEGORIES } from '../../categorizer/categorizer';
import { showsUnderTab, tabForCategory } from '../focusedSplit';

describe('tabForCategory', () => {
  it('puts mail you act on under Focused', () => {
    expect(tabForCategory('primary')).toBe('focused');
    expect(tabForCategory('bills')).toBe('focused');
  });

  it('puts receipts and marketing under Other', () => {
    expect(tabForCategory('purchases')).toBe('other');
    expect(tabForCategory('promotions')).toBe('other');
  });

  it('puts spam under neither tab', () => {
    expect(tabForCategory('spam')).toBeNull();
  });

  it('gives every category a decision', () => {
    for (const category of CATEGORIES) {
      expect(['focused', 'other', null]).toContain(tabForCategory(category));
    }
  });

  it('assigns each tabbed category to exactly one tab', () => {
    for (const category of CATEGORIES) {
      const shown = [showsUnderTab(category, 'focused'), showsUnderTab(category, 'other')].filter(Boolean);
      expect(shown.length).toBe(category === 'spam' ? 0 : 1);
    }
  });
});
