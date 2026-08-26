# Email Categorizer Engine

On-device classification of mail into a Gmail-style "smart inbox" (Primary,
Purchases, Bills, Promotions, Spam). Because the provider only ever sees
ciphertext, this categorization cannot run server-side — it runs here, after
local decrypt, as the read-side sibling of the search index.

- **Engine:** [`src/categorizer/categorizer.ts`](./categorizer.ts)
- **Tests:** [`src/categorizer/__tests__/categorizer-test.ts`](./__tests__/categorizer-test.ts)
- **Consumers:** [`src/screens/InboxScreen.tsx`](../screens/InboxScreen.tsx), [`src/screens/CategoryDrawer.tsx`](../screens/CategoryDrawer.tsx), [`src/ui/inboxFilter.tsx`](../ui/inboxFilter.tsx)

The module is **deliberately pure**: no React, no storage, no network. That is
what makes it directly unit-testable and safe to call during an inbox render.

---

## 1. Classification logic and rules

### Matching mechanism

There are **no regular expressions**. Classification is case-insensitive
**substring containment**: the text is lowercased once, then checked against
lowercase keyword tables with `String.prototype.includes`. Multi-word entries
match verbatim (e.g. `"payment due"` matches only that exact substring), and
`"order #"` matches the literal `#`.

```ts
const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));
```

### The rule pipeline — `categorize(text): Category`

A single pass over already-readable text, applied in strict precedence order.
**First match wins**; if nothing matches, the text is `primary`.

| Order | Check | Result | Rationale |
|-------|-------|--------|-----------|
| 1 | `checkIsSpam(text)` | `spam` | Checked first so a flagged message can never masquerade as a bill or an order. |
| 2 | contains any **bill** keyword | `bills` | A message that is both a bill and an ad is a bill first. |
| 3 | contains any **purchase** keyword | `purchases` | `"your order"` beats a `"sale"` mention in the same mail. |
| 4 | contains any **promotion** keyword | `promotions` | Lowest-priority commercial bucket. |
| 5 | *(no match)* | `primary` | Default. |

```ts
export function categorize(text: string): Category {
  if (checkIsSpam(text)) return 'spam';

  const t = text.toLowerCase();
  if (includesAny(t, BILL_KEYWORDS)) return 'bills';
  if (includesAny(t, PURCHASE_KEYWORDS)) return 'purchases';
  if (includesAny(t, PROMOTION_KEYWORDS)) return 'promotions';
  return 'primary';
}
```

The precedence ordering is intentional and covered by tests: an invoice that
also advertises a sale resolves to `bills`; an order that mentions a discount
resolves to `purchases`, not `promotions`.

### Keyword tables (heuristic)

All entries are lowercase substrings.

- **Bills** — `invoice`, `statement`, `bill`, `billing`, `payment due`, `past due`, `amount due`, `balance due`, `minimum payment`, `autopay`, `due date`, `e-bill`
- **Purchases** — `order confirmation`, `your order`, `order #`, `receipt`, `purchase`, `shipped`, `shipping`, `out for delivery`, `delivered`, `tracking number`, `tracking`
- **Promotions** — `% off`, `sale`, `discount`, `coupon`, `promo`, `special offer`, `limited time`, `save now`, `deal`, `newsletter`, `unsubscribe`

### Spam — `checkIsSpam(emailText): boolean`

Currently a **stub that always returns `false`** ("to be implemented by the spam
team"). Consequently the `spam` category is reachable in the type system and the
UI, but no message is routed there yet — the Spam drawer badge stays at zero.

---

## 2. Data structures: input vs. output

### Inputs

The engine has two entry points that respect the encryption boundary.

**`categorizeMessage(summary, encrypted, index)`** — classifies one inbox row:

| Param | Type | Meaning |
|-------|------|---------|
| `summary` | `MailSummary` | The inbox row (see below). |
| `encrypted` | `boolean` | Whether this row is encrypted (derived by the caller from `encryptionFor`). |
| `index` | `SearchIndex` | Map of message id → content decrypted **on this device**. |

`MailSummary` (from [`src/mail/types.ts`](../mail/types.ts)) — only three fields
are read by the categorizer:

```ts
type MailSummary = {
  id: string;        // key into SearchIndex
  subject: string;   // header subject (a placeholder for encrypted mail)
  snippet: string;   // provider preview; never trusted for encrypted mail
  // …from, to, date, unread, starred, autocrypt
};
```

`SearchIndex` (from [`src/search/search.ts`](../search/search.ts)) — the only
readable source for encrypted mail:

```ts
type DecryptedContent = { subject: string; body: string };
type SearchIndex = Record<string, DecryptedContent>; // keyed by message id
```

### The encryption boundary (the core rule)

`categorizeMessage` decides *what text* to feed to `categorize`:

```ts
export function categorizeMessage(summary, encrypted, index): Category {
  if (encrypted) {
    const content = index[summary.id];
    if (!content) return 'primary';                       // unopened → never inspect ciphertext
    return categorize(`${content.subject} ${content.body}`); // opened → decrypted content
  }
  return categorize(`${summary.subject} ${summary.snippet}`); // plaintext → header + snippet
}
```

- **Plaintext mail** → classified from `subject + snippet`.
- **Encrypted mail, opened** (present in `index`) → classified from the decrypted `subject + body`.
- **Encrypted mail, never opened** (absent from `index`) → forced to `primary`. Its ciphertext placeholder subject and provider snippet are **never** inspected. This mirrors how `messageMatchesQuery` treats encrypted search.

### Outputs

**`Category`** — a string union, plus ordering/label constants:

```ts
type Category = 'primary' | 'purchases' | 'bills' | 'promotions' | 'spam';

const CATEGORIES: Category[];                       // drawer display order
const CATEGORY_LABELS: Record<Category, string>;    // 'primary' → 'Primary', etc.
```

**`unreadCountsByCategory(items, index): Record<Category, number>`** — tallies
**unread** messages per category for the drawer badges (read messages are
skipped, so each count is an "unread here" count):

```ts
unreadCountsByCategory(
  items: { summary: MailSummary; encrypted: boolean }[],
  index: SearchIndex,
): Record<Category, number>
// → { primary: n, purchases: n, bills: n, promotions: n, spam: n }
```

---

## 3. Integration with the inbox

Three pieces wire the pure engine into the UI. The active category is **UI
view-state**, held outside `AppState` on purpose — it never touches mail, keys,
or the send path; it only decides which already-loaded rows render.

### `inboxFilter.tsx` — shared filter state

Exposes a small React context (`CategoryFilterProvider` / `useCategoryFilter`)
holding one value:

```ts
{ category: Category | null; setCategory: (c: Category | null) => void }
```

`null` means **"All mail"** (no category filter). Both the drawer and the inbox
list read and write this shared state.

### `CategoryDrawer.tsx` — the left navigation drawer

- Lists **All mail** plus every `CATEGORIES` entry, with an icon and an unread badge per row.
- Badges come from `unreadCountsByCategory(items, searchIndex)`, memoised over `messages` + `searchIndex`. It derives each row's `encrypted` flag from `encryptionFor(summary).kind === 'encrypted'`.
- Because it uses the same encryption-boundary logic, unopened encrypted mail counts under **Primary** until opened, and **Spam** stays at zero while `checkIsSpam` is a stub.
- Tapping a row calls `setCategory(cat)` (or `null` for All mail) and closes the drawer.

### `InboxScreen.tsx` — the filtered list

- Reads `{ category, setCategory }` from `useCategoryFilter()`.
- Inside its `sections` `useMemo`, after the encryption/attention filters, it applies the category filter in one line:

  ```ts
  if (category !== null && categorizeMessage(summary, encrypted, searchIndex) !== category) return false;
  ```

  Rows are classified live during the render pass — nothing is persisted.
- The header title shows `CATEGORY_LABELS[category]` (falling back to `"Inbox"`), and the total-unread count is shown **only** when `category === null`, so a number never reads as a per-category count.
- When a category is active, a close button clears it via `setCategory(null)`; the "Clear filters" empty-state action resets query, filter, and category together.

### Data flow

```
messages + searchIndex + encryptionFor   (from useApp / AppState)
        │
        ├── CategoryDrawer ── unreadCountsByCategory ──▶ badge counts
        │                                                     │
        │                                            user taps a row
        │                                                     ▼
        │                                   useCategoryFilter.setCategory(cat)
        │                                                     │
        ▼                                                     ▼
InboxScreen.sections ── categorizeMessage(summary, encrypted, searchIndex) === category
        │
        ▼
   filtered rows rendered
```

---

## Design notes & current limitations

- **Encryption boundary is a safety invariant, not a nicety.** Only content
  decrypted on *this* device is ever classified; ciphertext placeholders are
  never read. Tests assert that a keyword-stuffed snippet on an unopened
  encrypted message still lands in `primary`.
- **Heuristic, English-only.** Keyword tables are hand-maintained substrings with
  no stemming, localization, sender/list-header signals, or ML. False
  positives/negatives are expected (e.g. `"bill"` matches the name "Bill").
- **Spam is not implemented.** `checkIsSpam` is a stub returning `false`.
- **Purely presentational.** Categorization changes only what the inbox
  *displays*; it never moves, labels, or mutates mail, and results are recomputed
  each render rather than stored.
