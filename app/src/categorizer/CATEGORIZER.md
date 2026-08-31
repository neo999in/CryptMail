# Email Categorizer Engine

On-device classification of mail into a Gmail-style "smart inbox" (Primary,
Purchases, Bills, Promotions, Spam). Because the provider only ever sees
ciphertext, this categorization cannot run server-side — it runs here, after
local decrypt, as the read-side sibling of the search index.

- **Engine:** [`src/categorizer/categorizer.ts`](./categorizer.ts)
- **Tests:** [`src/categorizer/__tests__/categorizer-test.ts`](./__tests__/categorizer-test.ts)
- **Consumers:** [`src/screens/InboxScreen.tsx`](../screens/InboxScreen.tsx), [`src/screens/CategoryDrawer.tsx`](../screens/CategoryDrawer.tsx), [`src/screens/MessageScreen.tsx`](../screens/MessageScreen.tsx), [`src/ui/inboxFilter.tsx`](../ui/inboxFilter.tsx)
- **Spam engine it delegates to:** [`src/spam/spam.ts`](../spam/spam.ts) (`headers.ts`, `content.ts`, `urls.ts`, `bayes.ts`, `tokenize.ts`, `unicode.ts`)

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

### The rule pipeline — `categorize(text, verdict?): Category`

A single pass over already-readable text, applied in strict precedence order.
**First match wins**; if nothing matches, the text is `primary`.

| Order | Check | Result | Rationale |
|-------|-------|--------|-----------|
| 1 | `checkIsSpam(text, verdict)` | `spam` | Checked first so a flagged message can never masquerade as a bill or an order. |
| 2 | contains any **bill** keyword | `bills` | A message that is both a bill and an ad is a bill first. |
| 3 | contains any **purchase** keyword | `purchases` | `"your order"` beats a `"sale"` mention in the same mail. |
| 4 | contains any **promotion** keyword | `promotions` | Lowest-priority commercial bucket. |
| 5 | *(no match)* | `primary` | Default. |

```ts
export function categorize(text: string, verdict?: SpamVerdict | null): Category {
  if (checkIsSpam(text, verdict)) return 'spam';

  const t = text.toLowerCase();
  if (includesAny(t, BILL_KEYWORDS)) return 'bills';
  if (includesAny(t, PURCHASE_KEYWORDS)) return 'purchases';
  if (includesAny(t, PROMOTION_KEYWORDS)) return 'promotions';
  return 'primary';
}
```

The optional second argument is a verdict a caller has **already** computed from
the whole message — headers, links and attachments included. Called with one
argument, as the older callers do, the text is scored on its content alone: still
a real classification, just working from less evidence.

The precedence ordering is intentional and covered by tests: an invoice that
also advertises a sale resolves to `bills`; an order that mentions a discount
resolves to `purchases`, not `promotions`.

### Keyword tables (heuristic)

All entries are lowercase substrings.

- **Bills** — `invoice`, `statement`, `bill`, `billing`, `payment due`, `past due`, `amount due`, `balance due`, `minimum payment`, `autopay`, `due date`, `e-bill`
- **Purchases** — `order confirmation`, `your order`, `order #`, `receipt`, `purchase`, `shipped`, `shipping`, `out for delivery`, `delivered`, `tracking number`, `tracking`
- **Promotions** — `% off`, `sale`, `discount`, `coupon`, `promo`, `special offer`, `limited time`, `save now`, `deal`, `newsletter`, `unsubscribe`

### Spam — `checkIsSpam(emailText, verdict?): boolean`

The decision is **not** made here. It comes from the weighted-symbol engine in
[`src/spam/`](../spam/), which scores headers, content, links, attachments and the
user's own corrections; this function only reduces that verdict to the boolean the
categorizer needs.

```ts
export function checkIsSpam(emailText: string, verdict?: SpamVerdict | null): boolean {
  if (verdict) return verdict.classification !== 'legitimate';
  const text = typeof emailText === 'string' ? emailText : '';
  if (text.trim() === '') return false;
  return classifyMessage({ body: text }).classification !== 'legitimate';
}
```

Two ways to call it:

- **With a verdict** — preferred, and what `categorizeMessage` does. Headers and
  links are where phishing actually shows, so a caller holding the whole message
  computes the verdict once and passes it in.
- **With text only** — the engine sees content alone. Its header and
  authentication rules simply do not fire, which is correct rather than degraded:
  absent evidence contributes nothing in either direction.

Both `spam` and `phishing-suspicious` return `true`. The bucket is one bucket; the
distinction between the two is surfaced by the message view, not by where the mail
is filed. Keyword tables are deliberately **not** consulted for spam — "the word
*invoice* appears" is a fine reason to file something under Bills and a terrible
reason to hide it.

---

## 2. Data structures: input vs. output

### Inputs

The engine has three exported entry points that take a message, and all three
respect the encryption boundary.

**`categorizeMessage(summary, encrypted, index, context?)`** — classifies one
inbox row:

| Param | Type | Meaning |
|-------|------|---------|
| `summary` | `MailSummary` | The inbox row (see below). |
| `encrypted` | `boolean` | Whether this row is encrypted (derived by the caller from `encryptionFor`). |
| `index` | `SearchIndex` | Map of message id → content decrypted **on this device**. |
| `context` | `SpamContext` | Optional. What the spam engine needs beyond the text. |

**`verdictFor(summary, encrypted, index, context?)`** → `SpamVerdict` — the full
verdict for one row, not just its bucket. Exported because the message view shows
*why* something was flagged, and recomputing it there from a different input would
risk the banner disagreeing with the bucket.

**`spamInputFor(summary, encrypted, index, context?)`** → `SpamInput` —
everything about a message that may legitimately be classified, and nothing that
may not. Split out of `verdictFor` because the same input is what the personal
model trains on when the user marks a message: scoring and learning reading the
same function is what guarantees they respect the same boundary.

`SpamContext` is entirely optional. With none of it, `categorizeMessage` behaves
exactly as it did before the spam engine existed, plus content scoring.

```ts
type SpamContext = {
  model?: SpamModel;                  // the personal Bayes model; absent or untrained → rules only
  marks?: Record<string, SpamMark>;   // the user's explicit marks, by id — a mark wins over any score
  selfAddress?: string;               // so a lookalike of the user's own domain is visible
  links?: SpamInput['links'];         // anchor pairs from an HTML part, when the message has been opened
};
```

`MailSummary` (from [`src/mail/types.ts`](../mail/types.ts)) — the fields the
categorizer reads:

```ts
type MailSummary = {
  id: string;        // key into SearchIndex
  subject: string;   // header subject (a placeholder for encrypted mail)
  snippet: string;   // provider preview; never trusted for encrypted mail
  from: { address: string; name?: string };
  to: string[];
  // Cleartext headers, all optional — absent is never treated as failure:
  replyTo?: string;
  authenticationResults?: string;
  listUnsubscribe?: string;
  returnPath?: string;
  messageId?: string;
  // …date, unread, starred, autocrypt
};
```

Those five header fields are cleartext for encrypted mail as much as for
plaintext, which is why header and authentication analysis works on a message
whose body this device has never decrypted.

`SearchIndex` (from [`src/search/search.ts`](../search/search.ts)) — the only
readable source for encrypted mail:

```ts
type DecryptedContent = { subject: string; body: string };
type SearchIndex = Record<string, DecryptedContent>; // keyed by message id
```

### The encryption boundary (the core rule)

`categorizeMessage` decides *what text* to feed to `categorize`, and
`spamInputFor` decides what the spam engine may see:

```ts
export function categorizeMessage(summary, encrypted, index, context = {}): Category {
  const verdict = verdictFor(summary, encrypted, index, context);
  if (encrypted) {
    const content = index[summary.id];
    // Nothing decrypted here. Header evidence still counts; there is no text to
    // keyword-match, so the non-spam categories cannot apply.
    if (!content) return verdict.classification !== 'legitimate' ? 'spam' : 'primary';
    return categorize(`${content.subject} ${content.body}`, verdict);
  }
  return categorize(`${summary.subject} ${summary.snippet}`, verdict);
}
```

- **Plaintext mail** → classified from `subject + snippet`, plus headers and links.
- **Encrypted mail, opened** (present in `index`) → classified from the decrypted `subject + body`, plus headers.
- **Encrypted mail, never opened** (absent from `index`) → `primary`, *unless the cleartext headers alone are damning enough to reach a verdict*, in which case `spam`. Its ciphertext placeholder subject and the provider's snippet are **never** inspected — `spamInputFor` passes `subject: undefined, body: undefined` for that case, so there is no text to score and none to learn from. This mirrors how `messageMatchesQuery` treats encrypted search.

That last point is the one change the spam engine made to this module's
behaviour: an unopened encrypted message used to be unconditionally `primary`.
A message that fails DMARC while claiming to be a bank is suspicious whether or
not its body has been opened, and refusing to say so would have made the filter
blind on exactly the mail the provider cannot scan either.

### Outputs

**`Category`** — a string union, plus ordering/label constants:

```ts
type Category = 'primary' | 'purchases' | 'bills' | 'promotions' | 'spam';

const CATEGORIES: Category[];                       // drawer display order
const CATEGORY_LABELS: Record<Category, string>;    // 'primary' → 'Primary', etc.
```

**`unreadCountsByCategory(items, index, context?): Record<Category, number>`** —
tallies **unread** messages per category for the drawer badges (read messages are
skipped, so each count is an "unread here" count):

```ts
unreadCountsByCategory(
  items: { summary: MailSummary; encrypted: boolean }[],
  index: SearchIndex,
  context?: SpamContext,
): Record<Category, number>
// → { primary: n, purchases: n, bills: n, promotions: n, spam: n }
```

---

## 3. Integration with the inbox

Four pieces wire the pure engine into the UI. The active category is **UI
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
- Badges come from `unreadCountsByCategory(items, searchIndex, {model, marks, selfAddress})`, memoised over `messages`, `searchIndex`, `spam` and the session address. It derives each row's `encrypted` flag from `encryptionFor(summary).kind === 'encrypted'`.
- Because it uses the same encryption-boundary logic, unopened encrypted mail counts under **Primary** until opened — unless its cleartext headers alone reach a spam verdict.
- Tapping a row calls `setCategory(cat)` (or `null` for All mail) and closes the drawer.

### `InboxScreen.tsx` — the filtered list

- Reads `{ category, setCategory }` from `useCategoryFilter()`.
- Builds one memoised `spamContext` from `{model: spam.model, marks: spam.marks, selfAddress: session?.email}`, so every row in the pass is scored against the same model.
- Inside its `sections` `useMemo`, after the encryption/attention filters, it applies the category filter in one line:

  ```ts
  if (category !== null && categorizeMessage(summary, encrypted, searchIndex, spamContext) !== category) {
    return false;
  }
  ```

  Rows are classified live during the render pass — nothing is persisted.
- The header title shows `CATEGORY_LABELS[category]` (falling back to `"Inbox"`), and the total-unread count is shown **only** when `category === null`, so a number never reads as a per-category count.
- When a category is active, a close button clears it via `setCategory(null)`; the "Clear filters" empty-state action resets query, filter, and category together.

### `MessageScreen.tsx` — the notice on an open message

- Calls `verdictFor(...)` — the same function behind the row and the badge, so the
  notice cannot disagree with the bucket the message was filed under.
- Passes one thing the inbox row never had: `links: opened?.links`, the anchor
  `href`/label pairs from the opened message's HTML part. A link whose visible text
  lies about its destination is the strongest phishing signal there is, and it only
  exists once the message is open.
- Offers **Mark as spam** / **Mark as not spam**, which train the personal model
  through `AppState` (see §4).

### Data flow

```
messages + searchIndex + encryptionFor + spam   (from useApp / AppState)
        │
        ├── CategoryDrawer ── unreadCountsByCategory ──▶ badge counts
        │                                                     │
        │                                            user taps a row
        │                                                     ▼
        │                                   useCategoryFilter.setCategory(cat)
        │                                                     │
        ▼                                                     ▼
InboxScreen.sections ── categorizeMessage(summary, encrypted, searchIndex, spamContext) === category
        │
        ▼
   filtered rows rendered
        │
        │ user opens one
        ▼
MessageScreen ── verdictFor(…, {links}) ──▶ the notice, and Mark as spam / not spam
```

---

## 4. Where the spam decision actually comes from

This module owns the four commercial buckets. It does **not** own spam; it asks
[`src/spam/spam.ts`](../spam/spam.ts) and files the answer.

```
headers.ts  ─┐
content.ts  ─┼─▶ named symbols ─▶ score ─▶ classification ─▶ categorizer files it
urls.ts     ─┤                      ▲
bayes.ts    ─┘                      │
                            thresholds in spam/types.ts
```

- Every rule that fires contributes a **named symbol with a weight**, and the
  weights sum. `score >= SPAM_THRESHOLD` (5.0) is spam; `phishingScore >=
  PHISHING_THRESHOLD` (4.0) is `phishing-suspicious` and takes precedence. No
  single symbol is worth 5.0, so nothing classifies a message on its own.
- **Phishing is not "spam, but worse."** Only symbols marked `kind: 'phishing'`
  count towards `phishingScore` — broken authentication, a display name claiming a
  brand its domain does not own, a link whose text lies about its host. Bulk-mail
  symbols never contribute, so a loud newsletter cannot accumulate its way into a
  phishing warning.
- **A user mark short-circuits everything.** `marks[id]` of `'spam'` or `'ham'` is
  a human decision, not evidence to be weighed against rules: the engine returns
  immediately with a single `USER_MARKED_*` symbol and does not consult the model.
- **Corrections train a personal Naive Bayes model**, persisted in
  [`src/store/spamModelStore.ts`](../store/spamModelStore.ts) and applied on the
  next render. Reversing a mark *untrains* the first verdict rather than outvoting
  it. That path lives in [`src/state/mailbox.ts`](../state/mailbox.ts) (`markSpam`
  / `markNotSpam` → `applyMark`), which is also why it is `state/` and not this
  module that touches storage.
- **Nothing is fetched.** No URL is opened, resolved, expanded or previewed to
  classify a message; no markup or script is evaluated; attachments are read as
  metadata only.

---

## Design notes & current limitations

- **Encryption boundary is a safety invariant, not a nicety.** Only content
  decrypted on *this* device is ever classified or learned from; ciphertext
  placeholders and provider snippets of encrypted mail are never read. Tests
  assert that a keyword-stuffed snippet on an unopened encrypted message still
  lands in `primary`, and that marking such a message trains from its cleartext
  headers only.
- **Heuristic, English-only.** The four commercial buckets are hand-maintained
  substrings with no stemming, localization, or list-header signals. False
  positives/negatives are expected (e.g. `"bill"` matches the name "Bill"). The
  spam engine is not keyword-driven and does not share this limitation, but its
  content rules are also English-only.
- **Purely presentational.** Categorization changes only what the inbox
  *displays*; it never moves, labels, or mutates mail, and results are recomputed
  each render rather than stored. The one thing that *is* persisted is the user's
  own marks and the model they trained — a decision, not a cache.
