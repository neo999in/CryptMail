/**
 * The Primary / Encrypted split.
 *
 * The case that matters is spam: it belongs to neither tab, so a phishing
 * message can never arrive quietly in a list the user skims. The completeness
 * check guards the other direction — a category added to the categorizer later
 * must not silently vanish from the inbox.
 */
import { CATEGORIES } from '../../categorizer/categorizer';
import { INBOX_TABS, showsUnderTab } from '../inboxTabs';

describe('showsUnderTab', () => {
  it('shows every non-junk category under Primary, encrypted or not', () => {
    for (const category of CATEGORIES) {
      if (category === 'spam') continue;
      expect(showsUnderTab(category, false, 'primary')).toBe(true);
      expect(showsUnderTab(category, true, 'primary')).toBe(true);
    }
  });

  it('shows only protected mail under Encrypted', () => {
    expect(showsUnderTab('primary', true, 'encrypted')).toBe(true);
    expect(showsUnderTab('promotions', true, 'encrypted')).toBe(true);
    expect(showsUnderTab('primary', false, 'encrypted')).toBe(false);
    expect(showsUnderTab('bills', false, 'encrypted')).toBe(false);
  });

  it('keeps spam out of both tabs, however it arrived', () => {
    for (const encrypted of [true, false]) {
      expect(showsUnderTab('spam', encrypted, 'primary')).toBe(false);
      expect(showsUnderTab('spam', encrypted, 'encrypted')).toBe(false);
    }
  });

  /**
   * The tabs are a lens, not a partition — an encrypted message is meant to
   * appear under both. This pins that down so it cannot be "fixed" into a
   * partition later without the intent being reconsidered.
   */
  it('shows encrypted mail under both tabs', () => {
    const shown = INBOX_TABS.filter((t) => showsUnderTab('primary', true, t.key));
    expect(shown.map((t) => t.key)).toEqual(['primary', 'encrypted']);
  });

  it('leaves plaintext mail on Primary only', () => {
    const shown = INBOX_TABS.filter((t) => showsUnderTab('primary', false, t.key));
    expect(shown.map((t) => t.key)).toEqual(['primary']);
  });
});
