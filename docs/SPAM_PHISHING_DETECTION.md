# Spam & phishing detection

CryptMail files unwanted mail into a **Spam** category and warns about messages
that look like impersonation, entirely **on this device**. There is no filtering
service, no model download, no URL lookup and no telemetry: the engine is a pure
TypeScript module that is handed the text this device can already read and returns
a score with its reasons.

This document is the permanent reference for that feature — what it does, how it
decides, what it stores, what it deliberately does not do, exactly how it was
tested, which bugs were found and fixed during verification, and what still needs
a human, a real device or a real Gmail account to confirm.

- **Engine** — [`app/src/spam/`](../app/src/spam/) (`spam.ts`, `headers.ts`,
  `content.ts`, `urls.ts`, `bayes.ts`, `tokenize.ts`, `unicode.ts`, `types.ts`)
- **Persistence** — [`app/src/store/spamModelStore.ts`](../app/src/store/spamModelStore.ts)
- **Integration seam** — [`app/src/categorizer/categorizer.ts`](../app/src/categorizer/categorizer.ts)
  (see [`CATEGORIZER.md`](../app/src/categorizer/CATEGORIZER.md))
- **Where junk comes from** — [`app/src/mail/gmail.ts`](../app/src/mail/gmail.ts)
  (the `spam` mailbox) and [`app/src/state/mailbox.ts`](../app/src/state/mailbox.ts)
  (`collectInbox`) — see §14.4
- **Corrections** — [`app/src/state/mailbox.ts`](../app/src/state/mailbox.ts)
- **UI** — [`app/src/screens/MessageScreen.tsx`](../app/src/screens/MessageScreen.tsx),
  [`app/src/screens/InboxScreen.tsx`](../app/src/screens/InboxScreen.tsx),
  [`app/src/screens/CategoryDrawer.tsx`](../app/src/screens/CategoryDrawer.tsx)
- **Tests** — `app/src/spam/__tests__/` (7 suites),
  `app/src/store/__tests__/spamModelStore-test.ts`,
  `app/src/categorizer/__tests__/categorizer-test.ts`,
  `app/src/state/__tests__/mailbox-test.ts`,
  `app/src/state/__tests__/junk-test.ts`,
  `app/src/mail/__tests__/gmail-test.ts`

> **Merge note (2026-08-31).** This document was written on a branch cut before
> `main` removed the demo mailbox and gained multi-account support. Two classes of
> statement in it are therefore stale, and are **not** yet rewritten:
>
> - Every reference to `mail/demoMail.ts`, its `demo-phish` / `demo-bulk` /
>   `demo-legit-security` fixtures, and "what the demo mailbox will show" —
>   that file no longer exists (see the capability table in `CLAUDE.md`). The
>   engine and its tests do not depend on it; the fixtures were only ever a way
>   to *see* the feature without a real account. Testing now needs a real
>   throwaway Gmail account — see [`running-it.md`](running-it.md).
> - `loadSpamState` / `saveSpamState` are now **account-scoped**: they take an
>   `AccountId` first, and `cryptmail.spam.v1` is registered in
>   `PER_ACCOUNT_STORE_KEYS`, so removing an account erases its model and marks
>   with it. §9's call traces still show the unscoped one-argument form.
>
> Everything about *how the engine scores a message* — §3 through §8, §10 — was
> unaffected by the merge and stands as written.

## 1. What this document covers

It is written for two readers at once.

A **user or reviewer** who never opens a source file can read §2, §11, §12, §13
and §15 and come away knowing what the feature does, what it stores, what it
refuses to do, and what the demo mailbox will show.

A **developer maintaining it later** can read §3 through §10 and know where every
decision lives, then §16 through §22 for what was verified, what was fixed, and
what has never been run against real mail.

Everything below was read out of the repository as it stands. Where the earlier
verification report and the current code disagree, the **code** is documented and
the difference is called out (see §18, bug 5). Nothing here is aspirational: if
something is not implemented, this document says so.

## 2. The feature, in plain language

**What it does.** Every message in the inbox is scored. A message that looks like
unwanted bulk mail is filed under **Spam** instead of Primary. A message that looks
like it is *pretending to be someone* gets a stronger warning when you open it,
telling you not to type a password or card number into anything it links to. You
can disagree with any of it: **Mark as spam** and **Not spam** are one tap, and the
engine learns from the correction.

**Where the mail in Spam comes from.** Two places, and both belong there:

- **your provider's own junk folder**, fetched with the inbox on every sync. Gmail
  moves what it filters *out* of the inbox, so this folder has to be asked for by
  name or the app never sees it — which is exactly the bug §14.4 describes and
  fixes. On plaintext mail the provider's verdict is deferred to, because it is
  reached from sending-domain reputation and complaint rates no client can see;
- **this device's own verdict** on everything the provider *delivered*, which is
  what the rest of this document is about, and the only filtering that ever reaches
  an encrypted message.

Encrypted mail is the deliberate exception in both directions: this device does not
score it (§13.4), and a provider junk verdict on it is ignored rather than obeyed
(§14.4). It stays visible in Primary and the reader is told the provider disagreed.

**Why it exists.** CryptMail signs into an existing Gmail or IMAP account. Gmail's
own filtering never sees the inside of an encrypted CryptMail message — the
provider stores ciphertext — so a message that arrived encrypted has been filtered
by nobody until this device decrypts it. The client is the only place the check can
happen at all.

**Why on-device.** Sending mail to a filtering service to be scored would undo the
point of the product. So the engine has no network access of any kind: it is given
strings, it returns a verdict, and it never fetches, resolves, expands or previews
anything (§13).

**What it detects.** Failed or missing sender authentication, a `Reply-To` that
points somewhere else, display names claiming a company that does not own the
sending domain, lookalike domains (`paypa1.com`, Cyrillic `pаypal.com`,
`paypal.account-verify.example`), pressure-tactic *combinations* in the wording,
links that lie about where they go, bare IP addresses and numeric hosts, punycode,
zero-width characters and mixed-alphabet words, attachment names built to display a
false file type, and — once you have corrected it enough times — whatever *you*
personally treat as unwanted.

**Spam versus phishing.** These are two different answers, not two severities.

| | Spam | Phishing-suspicious |
|---|---|---|
| What it means | Unwanted bulk mail | A message impersonating someone |
| Reached by | Every symbol's total ≥ `SPAM_THRESHOLD` 5.0 | Only the impersonation symbols ≥ `PHISHING_THRESHOLD` 4.0 |
| Typical evidence | Shouting, prize wording, a processing fee, `List-Unsubscribe` present | Failed DMARC, brand name on the wrong domain, a link whose text lies |
| Learned model can cause it | Yes | **No** — Bayes never contributes to the phishing score |
| UI copy | "This looks like spam." | "This message may be impersonating someone. Do not enter passwords or payment details from it." |

**What it does NOT do.**

- It is **not an antivirus or malware scanner.** Attachment *bytes* are never read.
  Only the filename and the declared content type are examined — and those rules are
  not currently reachable in the running app at all (§13.3).
- It never opens, fetches, crawls, resolves or navigates to a URL (§8).
- It never executes email JavaScript, renders email HTML, or loads a remote image.
- It does not block, delete, archive or move mail on the server. Marking a message
  as spam does not archive or delete it.
- It does not score mail it cannot read. An encrypted message this device has not
  opened is judged on cleartext headers alone (§13).
- There is no shared/global model, no reputation service, no blocklist download and
  no server-side component. Nothing is ever uploaded.
- It stores **no email bodies** (§12).

**Legitimate mail.** Nothing is shown. `SpamNotice` renders `null` for a
`legitimate` verdict and the row stays in Primary (or in Bills / Purchases /
Promotions, which the categoriser decides separately).

**Suspicious mail.** The row moves to the Spam category and the drawer badge counts
it. Opening it shows a warning banner plus up to three plain-language reasons —
`reasons(verdict, 3)` — drawn from the symbols that actually fired.

**Your correction wins.** A mark short-circuits scoring entirely: `classifyMessage`
returns immediately with `overridden: true` and one `USER_MARKED_SPAM` /
`USER_MARKED_HAM` symbol at weight 0. A human decision is not evidence to be
weighed against rules.

### High-level flow

```
message arrives
      │
      ▼
spamInputFor()  ── the encryption boundary gate ───────────────┐
      │   plaintext → subject + provider snippet               │
      │   encrypted → only what THIS device decrypted,         │
      │               otherwise no text at all                 │
      │   always    → cleartext headers the provider has anyway │
      ▼                                                        │
classifyMessage(input, { model, mark })                        │
      │                                                        │
      ├── mark present? ──▶ overrideVerdict() ──▶ done ────────┤
      │                                                        │
      ├── headerSymbols()      From / Reply-To / auth / lookalikes
      ├── contentSymbols()     intent-family combinations + form
      ├── urlSymbols()         where each link goes, locally
      ├── attachmentSymbols()  filename + declared type only (not wired, §13.3)
      └── bayes.classify()     only when ≥5 spam AND ≥5 ham trained
                   │
                   ▼
          score        = Σ all weights
          phishingScore = Σ phishing weights + counter-phishing credits
                   │
                   ▼
      phishingScore ≥ 4.0 → 'phishing-suspicious'
      score         ≥ 5.0 → 'spam'
      otherwise           → 'legitimate'
                   │
                   ▼
      InboxScreen row / drawer badge / MessageScreen banner
                   │
                   ▼
      user taps Mark as spam / Not spam
                   │
                   ▼
      applyMark(): unlearn(previous) → learn(new) → setMark()
                   │
                   ▼
      saveSpamState() ──▶ sealed storage (token counts + marks, no bodies)
```

## 3. Architecture

`app/src/spam/` is a **pure logic module** in the shape of `search/` and `threads/`,
not a sixth subsystem: no React, no storage, no network. It sits below the
categoriser and is called during a render; `state/mailbox.ts` calls its training
functions and persists the result.

```
screens/
  ├── InboxScreen ─── categorizeMessage(summary, encrypted, index, spamContext)
  │                        │
  ├── CategoryDrawer ─ unreadCountsByCategory ──▶ badge counts
  │                        │
  └── MessageScreen ── verdictFor(...) ──▶ SpamNotice + Mark as spam / Not spam
                           │                        │
                           ▼                        ▼
        categorizer/categorizer.ts        state/mailbox.ts · applyMark
                           │                        │
                    spamInputFor()          learn / unlearn / setMark
                           │                        │
                           ▼                        ▼
                 spam/spam.ts · classifyMessage    store/spamModelStore.ts
                           │                        │
     ┌────────────┬────────┴───────┬──────────┐     ▼
  headers.ts   content.ts       urls.ts    bayes.ts   secureJson (sealed)
     │            │                │          │
     └──── unicode.ts ─────────────┘     tokenize.ts
                  │                          │
              types.ts (shared vocabulary, thresholds)
```

### 3.1 Feature-owned files

| File | Why it exists | In | Out |
|---|---|---|---|
| [`spam/types.ts`](../app/src/spam/types.ts) | One shared vocabulary so the rule modules, the scorer and the state layer need not import each other. Declares `SpamClassification`, `SpamSymbol`, `SpamVerdict`, `SpamHeaders`, `AttachmentMeta`, `LinkPair`, `SpamInput`, `SpamMark`, and the two thresholds. Data only, no behaviour. | — | types + `SPAM_THRESHOLD` 5.0, `PHISHING_THRESHOLD` 4.0 |
| [`spam/spam.ts`](../app/src/spam/spam.ts) | The scorer and the module's public face. Normalises the input, short-circuits on a user mark, collects symbols from the four rule modules, appends the Bayes symbol, sums the two scores, picks the verdict, sorts the symbols, and wraps the whole analysis in `try/catch`. | `SpamInput`, `{ model?, mark? }` | `SpamVerdict` |
| [`spam/headers.ts`](../app/src/spam/headers.ts) | Everything that can be judged from the envelope: `Authentication-Results` parsing, `From` vs `Reply-To` vs `Return-Path` vs `Message-ID`, display-name spoofing, brand impersonation, lookalike and punycode domains, risky TLDs, the user's own address, `List-Unsubscribe` hygiene, recipient visibility. | `SpamInput` | `SpamSymbol[]`; also exports `parseAuthResults`, `domainOf` |
| [`spam/content.ts`](../app/src/spam/content.ts) | What the message says and how it says it — intent-family co-occurrence, saturation within a family, and form (caps, punctuation runs, emoji, decoration, generic salutation, low vocabulary, invisible characters, mixed scripts). Also the attachment-metadata rules. | `SpamInput` | `SpamSymbol[]` from `contentSymbols` and `attachmentSymbols` |
| [`spam/urls.ts`](../app/src/spam/urls.ts) | Where links actually go, decided from the characters of the URL alone. Also the bounded anchor extractor `extractLinks`, and `hasDeceptiveLink` for the UI copy. | `SpamInput` (`links`, `from`, `body`) | `SpamSymbol[]`, `LinkPair[]` |
| [`spam/bayes.ts`](../app/src/spam/bayes.ts) | The personal model: an empty-model constructor, `train`, `untrain`, `classify`, `bayesWeight`, `isSpamModel`, `trainedCount`, and the three overconfidence guards. Pure — every function returns a new model. | `SpamModel` + token counts | probability, weight, new models |
| [`spam/tokenize.ts`](../app/src/spam/tokenize.ts) | Turns a message into origin-namespaced tokens and counts them. The single tokenizer surface for scoring *and* training, which is what stops the two disagreeing. | `SpamInput` | `string[]` / `Map<string, number>` |
| [`spam/unicode.ts`](../app/src/spam/unicode.ts) | Comparison primitives: `stripInvisible`, `hasInvisibleCharacters`, `hasMixedScriptWord`, `skeleton`, `domainSkeleton`, `hasPunycodeLabel`, `registrableDomain`, `sameRegistrableDomain`, `editDistance`, `lookalikeBrand`, `brandsNamedIn`, `brandOwnsHost`, plus the brand table. | strings | booleans / folded strings / `LookalikeHit` |
| [`store/spamModelStore.ts`](../app/src/store/spamModelStore.ts) | Sealed persistence for the model and the marks, and the defensive `normaliseSpamState` that validates the two halves independently. `MAX_MARKS = 2_000`. | `SpamState` | `SpamState`, `SpamMark` records |

### 3.2 Integrating files

| File | What it contributes | Why the change was required |
|---|---|---|
| [`categorizer/categorizer.ts`](../app/src/categorizer/categorizer.ts) | `spamInputFor` (the encryption-boundary gate), `verdictFor`, `categorizeMessage`, `unreadCountsByCategory`, `linksFromText`, and `checkIsSpam` now backed by a real verdict. Adds the `'spam'` member to `Category`. | The only place a `MailSummary` + search index + spam context can be turned into a `SpamInput`. Both scoring and training read it, so they cannot disagree about what is readable. |
| [`state/mailbox.ts`](../app/src/state/mailbox.ts) | `markSpam` / `markNotSpam` → `applyMark`, which untrains the previous mark, trains the new one, patches state and persists in one record. `linksIn(html)`, and the anchor-pair extraction in `openMessage`. | Corrections and training are state transitions; the engine is pure and cannot own them. |
| [`store/index.ts`](../app/src/store/index.ts) | `SPAM_STORE_KEY` added to `SEALED_STORE_KEYS`; `initStorage()` sweeps it through `resealPlaintext`. | The model and marks are user data and must sit inside the seal, including on an install that predates the feature. |
| [`mail/gmail.ts`](../app/src/mail/gmail.ts) | Four header names added to the `metadata` request; `toSummary` maps them with `\|\| undefined`. | Live mode cannot analyse authentication it never asked Gmail for. |
| [`mail/types.ts`](../app/src/mail/types.ts) | `MailSummary` gains `replyTo`, `authenticationResults`, `listUnsubscribe`, `returnPath` — all optional. | The provider-agnostic contract had to carry the four fields, while a connector supplying none of them keeps its previous behaviour exactly. |
| [`mail/demoMail.ts`](../app/src/mail/demoMail.ts) | Three filter fixtures (`demo-phish`, `demo-bulk`, `demo-legit-security`), `withHeaders` to splice receiver-written headers in, `snippetOf` for provider-shaped previews, and the four new header fields on every row. | The feature is unreachable in demo mode without mail to filter, and the row shape had to match Gmail's or the demo would score less text than production. |
| [`screens/MessageScreen.tsx`](../app/src/screens/MessageScreen.tsx) | The `verdict` memo, `SpamNotice`, and the Mark as spam / Not spam toggle. | The verdict has to be visible and correctable. |
| [`screens/InboxScreen.tsx`](../app/src/screens/InboxScreen.tsx) | `spamContext` memo; the row filter calls `categorizeMessage` with it. | Rows must be filed using the same model and marks the message view uses. |
| [`screens/CategoryDrawer.tsx`](../app/src/screens/CategoryDrawer.tsx) | Reads `unreadCountsByCategory` for the Spam badge. | Badge counts must agree with the filed rows. |
| [`docs/features.md`](features.md) | The shipped-features row (line 51) and the Tier-1 "Built" entry. | `docs/` is the source of truth for behaviour. |
| [`app/src/categorizer/CATEGORIZER.md`](../app/src/categorizer/CATEGORIZER.md) | Documents the delegation to the spam engine. | Same reason. |

> This table is the original integration. Four of these files were changed again
> later — `mail/gmail.ts` and `mail/types.ts` gained a `spam` mailbox,
> `state/mailbox.ts` fetches it, and `categorizer.ts` reads the label it carries —
> because the Spam destination could not show the provider's own junk. That work is
> §14.4, and it is where those changes are described.

## 4. Complete data flow

Actual function names, in call order.

### 4.1 Scoring an inbox row

```
InboxScreen render
  └─ spamContext = useMemo(() => ({ model: spam.model, marks: spam.marks,
                                    selfAddress: session?.email }), [spam, session?.email])
  └─ categorizeMessage(summary, encrypted, searchIndex, spamContext)      categorizer.ts
       ├─ verdictFor(summary, encrypted, index, context)
       │    ├─ spamInputFor(summary, encrypted, index, context)   ← the boundary gate
       │    │     ├─ encrypted && index[summary.id]  → { subject, body } from the
       │    │     │                                     decrypted content
       │    │     ├─ encrypted && !index[summary.id] → { subject: undefined,
       │    │     │                                      body: undefined }
       │    │     └─ !encrypted                      → { subject: summary.subject,
       │    │                                            body: summary.snippet }
       │    │     plus from / to / selfAddress / links
       │    │     plus headers: { replyTo, authenticationResults,
       │    │                     listUnsubscribe, returnPath, messageId }
       │    └─ classifyMessage(input, { model: context.model,
       │                                mark: context.marks?.[summary.id] })
       └─ isUnwanted(verdict) ? 'spam' : categorize(text, verdict)
```

`classifyMessage` ([`spam.ts:146`](../app/src/spam/spam.ts#L146)) then:

```
classifyMessage(input, options)
  ├─ options.mark === 'spam' | 'ham'  →  overrideVerdict(mark)  →  RETURN
  ├─ try {
  │    safe = normalise(input)                    shape guarantee
  │    symbols = [ ...headerSymbols(safe),
  │                ...contentSymbols(safe),
  │                ...urlSymbols(safe),
  │                ...attachmentSymbols(safe) ]
  │    bayes  = classify(model ?? emptyModel(), tokenizeInputFor(safe))
  │    weight = bayesWeight(bayes)
  │    if (weight !== 0) symbols.push({ BAYES_SPAM | BAYES_HAM, weight,
  │                                     kind: spam | ham })
  │  } catch { return all-zero legitimate verdict }
  ├─ score         = Σ symbol.weight                                (rounded 2dp)
  ├─ phishingScore = Σ weight where kind === 'phishing'
  │                    || (kind === 'ham' && counterPhishing)       (rounded 2dp)
  └─ verdictFor(score, phishingScore) → classification
     symbols sorted by |weight| desc, then name
```

> **Two functions are called `verdictFor`.** The exported one in `categorizer.ts`
> takes a `MailSummary` and returns a `SpamVerdict`; the private one in
> [`spam.ts:225`](../app/src/spam/spam.ts#L225) takes the two numbers and returns a
> `SpamClassification`. They are different functions in different modules; the
> diagrams above name each in its own place.

Inside the rule modules:

```
headerSymbols(input)                                              headers.ts
  ├─ parseAuthResults(input.headers?.authenticationResults)
  │    → { spf, dkim, dmarc, malformed }  (null = "the header did not say")
  ├─ domainOf(from.address) / looksLikeAddress
  ├─ auth symbols, gated by  dmarcSpoke = dmarc === 'fail' || dmarc === 'pass'
  ├─ Reply-To / Return-Path / Message-ID consistency
  │    (the last two gated by  auth.dmarc !== 'pass')
  ├─ brandsNamedIn(from.name) × brandOwnsHost                       unicode.ts
  ├─ lookalikeBrand(fromDomain) / hasPunycodeLabel                  unicode.ts
  ├─ self-address checks against input.selfAddress
  └─ HAS_LIST_UNSUBSCRIBE / NO_VISIBLE_RECIPIENT / RECIPIENT_NOT_SELF

contentSymbols(input)                                             content.ts
  ├─ haystacks = [ raw ] or [ raw, skeleton(raw) ]                  unicode.ts
  ├─ familyHits(haystacks) → Map<Family, entryCount>
  ├─ strongest matched COMBINATION only            ← one symbol, not all pairs
  ├─ CONTENT_MANY_PRETEXTS when hits.size >= 4
  ├─ CONTENT_<FAMILY>_HEAVY when a family hit >= 6 distinct entries
  ├─ form: SUBJECT_ALL_CAPS / _PUNCTUATION_RUN / _DECORATED / _MANY_EMOJI /
  │        _LARGE_AMOUNT, BODY_ALL_CAPS / _PUNCTUATION_RUN /
  │        _GENERIC_SALUTATION / _LOW_VOCABULARY
  └─ CONTENT_INVISIBLE_CHARS / CONTENT_MIXED_SCRIPT

urlSymbols(input)                                                    urls.ts
  ├─ usableLinks(input) → { href, text, host } via hostOf()      lib/links.ts
  └─ per link, each finding firing at most once per message:
       isIpHost / isObfuscatedHost / SHORTENERS / hasPunycodeLabel /
       lookalikeBrand / userinfo `@` / hasInvisibleCharacters /
       embedded redirect / heavy percent-encoding /
       CREDENTIAL_PATH_WORDS (≥2, off the sender's domain) /
       deep subdomain / brand on FREE_PAGE_HOSTS /
       anchor-text host mismatch / anchor-text brand mismatch
     then aggregates: URL_ONLY_MESSAGE, URL_MANY_HOSTS

attachmentSymbols(input)                                          content.ts
  └─ filename + contentType only; `size` unused; bytes never read
     (not currently reachable — `spamInputFor` supplies no attachments, §13.3)

classify(model, tokenizeInput)                                      bayes.ts
  ├─ modelIsTrained(model)?  (≥ MIN_TRAINED_MESSAGES in BOTH classes)
  ├─ countTokens(tokenize(input))                                tokenize.ts
  ├─ tokenProbability per token (null below MIN_TOKEN_SIGHTINGS)
  ├─ sort by |p − 0.5| desc, take MAX_VOTING_TOKENS (20)
  ├─ Σ log(p / (1 − p)) → sigmoid → clamp by verdictCap(model)
  └─ { applies, probability, tokensUsed }   →  bayesWeight() → ±3.0
```

### 4.2 A user correction

```
MessageScreen  Mark as spam / Not spam
  └─ markSpam(id) | markNotSpam(id)                               mailbox.ts
       └─ applyMark(id, mark)
            ├─ previous = state.spam.marks[id]
            ├─ if (previous === mark) return              ← duplicate-tap guard
            ├─ input = spamInputFor(summary, encrypted, index, ctx)
            ├─ if (previous) model = unlearn(model, input, previous)
            ├─ model = learn(model, input, mark)
            │    └─ train(model, tokenizeInputFor(input), label)   bayes.ts
            ├─ store.patch({ spam: { model, marks: setMark(marks, id, mark) } })
            └─ await saveSpamState(spam)                    spamModelStore.ts
                 └─ secureJson.write(SPAM_STORE_KEY, …)     sealed storage
```

### 4.3 Boot

```
initStorage()                                                store/index.ts
  ├─ resealPlaintext(SEALED_STORE_KEYS)      SPAM_STORE_KEY included
  └─ loadSpamState()                                     spamModelStore.ts
       └─ normaliseSpamState(raw)
            ├─ model half invalid → emptyModel(), marks kept
            └─ marks half invalid → {}, model kept
```

## 5. Classification logic

### 5.1 The two scores

Every rule that fires returns a `SpamSymbol` — `{ name, weight, kind, counterPhishing?, detail? }`.
Weights sum. There is no chaining, no multiplication and no per-rule veto.

```ts
const score = round(symbols.reduce((total, symbol) => total + symbol.weight, 0));
const phishingScore = round(
  symbols.reduce(
    (total, symbol) =>
      total + (symbol.kind === 'phishing' || (symbol.kind === 'ham' && symbol.counterPhishing) ? symbol.weight : 0),
    0,
  ),
);
```

```ts
function verdictFor(score: number, phishingScore: number): SpamClassification {
  if (phishingScore >= PHISHING_THRESHOLD) return 'phishing-suspicious';
  if (score >= SPAM_THRESHOLD) return 'spam';
  return 'legitimate';
}
```

| Constant | Value | Where |
|---|---|---|
| `SPAM_THRESHOLD` | **5.0** | [`types.ts:158`](../app/src/spam/types.ts#L158) |
| `PHISHING_THRESHOLD` | **4.0** | [`types.ts:159`](../app/src/spam/types.ts#L159) |

Phishing is checked **first and independently**. A message can be
`phishing-suspicious` on a total below 5.0 — a well-written impersonation is not
spammy in the bulk-mail sense — which is why the two are separate numbers rather
than one scale with two marks on it.

### 5.2 What makes spam different from phishing

`phishingScore` is not a fraction of `score`; it is a **sum over a different set of
symbols**. Only `kind: 'phishing'` symbols contribute, plus `kind: 'ham'` symbols
that opt in with `counterPhishing: true`.

- Bulk-mail evidence (`SUBJECT_ALL_CAPS`, `SUBJECT_MANY_EMOJI`,
  `CONTENT_PRIZE_MONEY`, `URL_SHORTENER`, `ATTACH_ARCHIVE`) is `kind: 'spam'` and
  contributes **nothing** to `phishingScore`. A loud marketing email cannot become
  a phishing warning by accumulating spam points.
- **Bayes is never phishing.** The `BAYES_SPAM` / `BAYES_HAM` symbol is `kind:
  'spam'` or `'ham'` and `counterPhishing` is not set, so the learned model can
  never manufacture an impersonation verdict. Phishing stays grounded in
  structural evidence.
- Only two symbols currently set `counterPhishing: true` — `AUTH_DMARC_PASS`
  (−1.2) and `AUTH_SPF_DKIM_PASS` (−0.8). Both are cryptographic statements that
  the visible `From` domain really did send the message, which is precisely the
  claim `phishingScore` is about. `HAS_LIST_UNSUBSCRIBE` deliberately does **not**
  qualify: a phisher sets that header for free.

### 5.3 Positive signals and credits

Negative weights are evidence *for* legitimacy, and they are what keeps a shouty
but honest newsletter out of the Spam bucket.

| Symbol | Weight | `counterPhishing` | Meaning |
|---|---|---|---|
| `AUTH_DMARC_PASS` | −1.2 | yes | The `From` domain's own policy validates the message |
| `AUTH_SPF_DKIM_PASS` | −0.8 | yes | SPF and DKIM both pass |
| `HAS_LIST_UNSUBSCRIBE` | −0.7 | no | Bulk-mail hygiene — a real mailing list |
| `BAYES_HAM` | down to −3.0 | no | Resembles mail this user marked not-spam |

### 5.4 How weak signals are prevented from becoming a verdict

Five separate mechanisms, each answering a measured failure:

1. **No symbol reaches a threshold alone.** The heaviest in the engine are
   `ATTACH_DOUBLE_EXTENSION` 4.0, `URL_LOOKALIKE_DOMAIN` 4.0 (confusable) and
   `FROM_LOOKALIKE_DOMAIN` 4.0 (confusable) — equal to the phishing bar but below
   the spam bar, and reaching `phishing-suspicious` still needs the sum to be
   ≥ 4.0 after any counter-phishing credit has been subtracted.
2. **One fact, one charge.** Two suppression gates in `headers.ts` stop the same
   evidence being counted more than once (§6.5).
3. **One content combination per message.** Only the *heaviest* matched pairing
   scores, because three intent families produce three pairings and four produce
   six — quadratic in the evidence (§7.3).
4. **Each URL finding fires once per message**, not once per link, so a newsletter
   with forty shortened links is one shortener finding.
5. **Bayes is capped twice and has a dead zone** — `confidenceCap` per token,
   `verdictCap` on the combined probability, and a 0.35–0.65 band where it
   contributes exactly 0 (§10.6).

### 5.5 The full symbol inventory

Every symbol the engine can emit, with its real weight from the source.

**Authentication and envelope** — [`headers.ts`](../app/src/spam/headers.ts)

| Symbol | Weight | Kind | Condition |
|---|---|---|---|
| `AUTH_DMARC_FAIL` | 3.5 | phishing | `dmarc === 'fail'` |
| `AUTH_DMARC_PASS` | −1.2 | ham · counter | `dmarc === 'pass'` |
| `AUTH_SPF_FAIL` | 1.6 | phishing | `spf === 'fail'` and DMARC said nothing |
| `AUTH_SPF_SOFTFAIL` | 0.6 | spam | `spf === 'softfail'` and DMARC said nothing |
| `AUTH_DKIM_FAIL` | 1.4 | phishing | `dkim === 'fail'` and DMARC said nothing |
| `AUTH_SPF_DKIM_PASS` | −0.8 | ham · counter | `spf === 'pass' && dkim === 'pass' && dmarc !== 'fail'` |
| `AUTH_RESULTS_MALFORMED` | 0.3 | spam | header present, non-empty, none of the three readable |
| `FROM_MALFORMED` | 1.5 | spam | `From` is present but not a usable address |
| `REPLY_TO_FREEMAIL_MISMATCH` | 2.6 | phishing | `Reply-To` on a different registrable domain **and** freemail |
| `REPLY_TO_MISMATCH` | 1.4 | phishing | `Reply-To` on a different registrable domain |
| `RETURN_PATH_MISMATCH` | 0.5 | spam | different domain, **and** DMARC did not pass |
| `MESSAGE_ID_MISMATCH` | 0.4 | spam | different domain, **and** DMARC did not pass |
| `DISPLAY_NAME_SPOOFS_ADDRESS` | 3.0 | phishing | display name is itself an address on another domain |
| `BRAND_NAME_FROM_FREEMAIL` | 3.4 | phishing | display name names a brand, sent from freemail |
| `BRAND_NAME_WRONG_DOMAIN` | 2.8 | phishing | display name names a brand the domain does not own |
| `FROM_LOOKALIKE_DOMAIN` | 4.0 / 3.2 / 2.6 | phishing | `lookalikeBrand` reason confusable / near-miss / embedded |
| `FROM_PUNYCODE_DOMAIN` | 1.8 | phishing | any `xn--` label in the sending domain |
| `FROM_RISKY_TLD` | 0.9 | spam | TLD in `RISKY_TLDS` (47 entries) |
| `FROM_DOMAIN_MANY_PARTS` | 0.8 | spam | ≥ 4 hyphenated parts in the registrable label |
| `FROM_DOMAIN_RANDOM` | 0.8 | spam | label ≥ 12 chars with no vowel in its first 8 letters |
| `FROM_SELF_UNAUTHENTICATED` | 2.2 | phishing | `From` equals `selfAddress` and DMARC did not pass |
| `FROM_LOOKALIKE_OF_SELF` | 3.4 | phishing | folded sending domain equals the user's own, but is not it |
| `HAS_LIST_UNSUBSCRIBE` | −0.7 | ham | header present |
| `NO_VISIBLE_RECIPIENT` | 0.4 | spam | `to` supplied as an array **and** empty after filtering |
| `RECIPIENT_NOT_SELF` | 0.5 | spam | exactly one recipient, a valid address, and it is not the user |

**Content** — [`content.ts`](../app/src/spam/content.ts)

| Symbol | Weight | Kind | Pairing / condition |
|---|---|---|---|
| `CONTENT_THREAT_CREDENTIAL` | 3.6 | phishing | threat + credential |
| `CONTENT_URGENT_CREDENTIAL` | 3.4 | phishing | urgency + credential |
| `CONTENT_SECRET_MONEY` | 3.4 | phishing | secrecy + money |
| `CONTENT_PRIZE_MONEY` | 3.2 | spam | prize + money |
| `CONTENT_CHANNEL_MONEY` | 3.0 | phishing | channel + money |
| `CONTENT_THREAT_MONEY` | 2.8 | spam | threat + money |
| `CONTENT_CHANNEL_CREDENTIAL` | 2.8 | phishing | channel + credential |
| `CONTENT_PRIZE_URGENT` | 2.6 | spam | prize + urgency |
| `CONTENT_URGENT_MONEY` | 2.4 | spam | urgency + money |
| `CONTENT_SECRET_URGENT` | 2.4 | phishing | secrecy + urgency |
| `CONTENT_URGENT_THREAT` | 2.0 | phishing | urgency + threat |
| `CONTENT_MANY_PRETEXTS` | 1.6 | spam | **four or more** distinct families |
| `CONTENT_<FAMILY>_HEAVY` | 1.4 | phishing for credential/secrecy/channel, else spam | ≥ 6 distinct entries in one family |
| `CONTENT_INVISIBLE_CHARS` | 2.0 | phishing | invisible characters that change what the words are |
| `CONTENT_MIXED_SCRIPT` | 1.8 | phishing | a word mixing alphabets |
| `SUBJECT_ALL_CAPS` | 1.2 | spam | > 70 % capitals, ≥ 8 letters |
| `SUBJECT_PUNCTUATION_RUN` | 1.0 | spam | `[!?]{3,}` |
| `SUBJECT_DECORATED` | 0.8 | spam | leading `**` or `[URGENT`-style bracket |
| `SUBJECT_LARGE_AMOUNT` | 0.8 | spam | a currency figure of 4+ digits |
| `SUBJECT_MANY_EMOJI` | 0.7 | spam | ≥ 3 pictographs |
| `BODY_ALL_CAPS` | 1.0 | spam | > 60 % capitals, ≥ 200 letters |
| `BODY_LOW_VOCABULARY` | 1.0 | spam | < 25 % unique words over ≥ 40 words |
| `BODY_PUNCTUATION_RUN` | 0.7 | spam | `[!]{4,}` |
| `BODY_GENERIC_SALUTATION` | 0.6 | spam | "Dear Customer" and friends |

**Attachment metadata** — [`content.ts`](../app/src/spam/content.ts)

| Symbol | Weight | Kind | Condition |
|---|---|---|---|
| `ATTACH_DOUBLE_EXTENSION` | 4.0 | phishing | `invoice.pdf.exe` — executable behind a harmless-looking extension |
| `ATTACH_NAME_REVERSED` | 3.6 | phishing | a bidirectional override in the filename |
| `ATTACH_EXECUTABLE` | 2.6 | phishing | extension in `EXECUTABLE_EXTENSIONS` |
| `ATTACH_HTML_PAGE` | 2.2 | phishing | `.html` / `.htm` / `.shtml` / `.xhtml` |
| `ATTACH_TYPE_MISMATCH` | 1.4 | phishing | declares `application/pdf`, is not named `.pdf` |
| `ATTACH_MACRO_DOCUMENT` | 1.2 | spam | `.docm` / `.xlsm` / … |
| `ATTACH_ARCHIVE` | 0.5 | spam | `.zip` / `.rar` / … |

**Links** — [`urls.ts`](../app/src/spam/urls.ts)

| Symbol | Weight | Kind | Condition |
|---|---|---|---|
| `URL_LOOKALIKE_DOMAIN` | 4.0 / 3.2 / 2.4 | phishing | confusable / near-miss / embedded |
| `URL_TEXT_HOST_MISMATCH` | 3.2 | phishing | anchor text is a host, destination is another |
| `URL_OBFUSCATED_HOST` | 3.0 | phishing | `0x7f000001`, `2130706433`, `017700000001` |
| `URL_USERINFO` | 2.8 | phishing | `@` in the authority |
| `URL_IP_ADDRESS` | 2.6 | phishing | bare IPv4/IPv6 literal |
| `URL_BRAND_ON_FREE_HOST` | 2.6 | phishing | a brand name in the site part of free hosting |
| `URL_INVISIBLE_CHARS` | 2.4 | phishing | hidden characters in the href |
| `URL_TEXT_BRAND_MISMATCH` | 2.4 | phishing | anchor names a brand, destination is not it |
| `URL_EMBEDDED_REDIRECT` | 2.2 | phishing | `?url=`/`?next=`… to another registrable domain |
| `URL_PUNYCODE_HOST` | 2.0 | phishing | any `xn--` label |
| `URL_CREDENTIAL_PATH` | 1.8 | phishing | ≥ 2 credential words in the path, off the sender's domain |
| `URL_HEAVILY_ENCODED` | 1.6 | phishing | ≥ 8 percent-escapes including structural ones |
| `URL_DEEP_SUBDOMAIN` | 1.0 | spam | ≥ 5 labels |
| `URL_SHORTENER` | 0.8 | spam | registrable domain in `SHORTENERS` (46 entries) |
| `URL_ONLY_MESSAGE` | 0.6 | spam | one link, body under 200 characters |
| `URL_MANY_HOSTS` | 0.5 | spam | ≥ 8 distinct registrable domains |

**Model and override** — [`spam.ts`](../app/src/spam/spam.ts)

| Symbol | Weight | Kind | Condition |
|---|---|---|---|
| `BAYES_SPAM` | up to +3.0 | spam | probability > 0.65, model trained |
| `BAYES_HAM` | down to −3.0 | ham | probability < 0.35, model trained |
| `USER_MARKED_SPAM` | 0 | spam | the user marked it; `score` set to 5.0 |
| `USER_MARKED_HAM` | 0 | ham | the user marked it; `score` set to 0 |

## 6. Header and authentication analysis

[`app/src/spam/headers.ts`](../app/src/spam/headers.ts) — 417 lines, 23 distinct
symbol names (21 written literally, plus `REPLY_TO_FREEMAIL_MISMATCH` /
`REPLY_TO_MISMATCH` and `BRAND_NAME_FROM_FREEMAIL` / `BRAND_NAME_WRONG_DOMAIN`,
which are chosen at the point of use).

### 6.1 Parsing `Authentication-Results`

RFC 8601 allows comments, quoted strings, `header.d=` properties and multiple
`authserv-id` sections, and real headers use all of it. `parseAuthResults` does
**not** implement the grammar; it strips parenthesised comments first (they can
themselves contain `=`) and then scans for `method=result` tokens:

```ts
const stripped = text.replace(/\([^)]*\)/g, ' ').toLowerCase();

const read = (method: string): AuthResult | null => {
  const match = stripped.match(new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`));
  if (!match) return null;
  const value = match[1];
  return (KNOWN_RESULTS as string[]).includes(value) ? (value as AuthResult) : 'unknown';
};
```

It cannot throw on input it does not understand, which is the requirement — the
header is remote text.

| Header state | `spf` / `dkim` / `dmarc` | `malformed` | Symbols |
|---|---|---|---|
| Absent (`undefined`) | `null`, `null`, `null` | `false` | none |
| Empty or whitespace | `null`, `null`, `null` | `false` | none |
| Not a string at all | `null`, `null`, `null` | `false` | none |
| Present, unreadable | `null`, `null`, `null` | **`true`** | `AUTH_RESULTS_MALFORMED` 0.3 |
| `spf=pass; dkim=pass; dmarc=pass` | `'pass'` ×3 | `false` | `AUTH_DMARC_PASS` −1.2, `AUTH_SPF_DKIM_PASS` −0.8 |
| `dmarc=fail` | `dmarc: 'fail'` | `false` | `AUTH_DMARC_FAIL` 3.5 |
| `spf=softfail` only | `spf: 'softfail'` | `false` | `AUTH_SPF_SOFTFAIL` 0.6 |
| `spf=none` | `spf: 'none'` | `false` | none — an explicit "no policy" |
| `dmarc=weird` | `dmarc: 'unknown'` | `false` | none |

`AuthResult` is `'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' |
'permerror' | 'unknown'`. Anything unrecognised becomes `'unknown'`, which no rule
scores.

### 6.2 "Missing is not failing" — the central rule

`null` means **"the header did not say"**, which is not `'none'` (the header said a
policy was checked and not found), and neither of them is `'fail'`.

Every message in CryptMail's demo mode has no `Authentication-Results`. So does
mail that arrived by a path that does not stamp one, and mail from providers that
do not. Treating absence as failure would classify a large fraction of ordinary
mail as suspicious. Absence therefore contributes **exactly nothing**: no symbol,
no weight.

The same rule is applied outside authentication:

- `Reply-To` absent → nothing. `Reply-To` on another registrable domain → a symbol.
- `Return-Path` / `Message-ID` absent → nothing.
- `to` absent → nothing. `to` **supplied and empty** → `NO_VISIBLE_RECIPIENT` 0.4.
  The distinction is explicit: `const supplied = Array.isArray(input.to)`.
- `List-Unsubscribe` absent → nothing (its presence is a *credit*, so absence is
  simply the default, never a penalty).

### 6.3 From versus Reply-To, Return-Path and Message-ID

All three comparisons use `sameRegistrableDomain`, so `mail.shop.example` and
`shop.example` are the same sender while `a.github.io` and `b.github.io` are not.

`Reply-To` may be a list; the first address is the one a reply reaches:

```ts
const replyTo = parseAddress(headers.replyTo.split(',')[0] ?? '').address;
```

A reply target on **freemail** for a non-freemail sender is the specific
business-email-compromise pattern — the mail looks like it came from the company,
the reply goes to the attacker's mailbox — so it is 2.6 rather than 1.4.

### 6.4 Sender / domain relationships and lookalikes

| Check | Symbol | Notes |
|---|---|---|
| Display name is itself an address on another domain | `DISPLAY_NAME_SPOOFS_ADDRESS` 3.0 | `"billing@paypal.com" <random@mailer.example>` renders as PayPal in every list view |
| Display name names a brand its domain does not own | `BRAND_NAME_WRONG_DOMAIN` 2.8 / `BRAND_NAME_FROM_FREEMAIL` 3.4 | `brandOwnsHost` is what keeps real PayPal mail clear; `break` after the first hit so a name claiming two brands is charged once |
| The sending domain itself imitates a brand | `FROM_LOOKALIKE_DOMAIN` 4.0 / 3.2 / 2.6 | by `lookalikeBrand` reason (§9) |
| Any `xn--` label | `FROM_PUNYCODE_DOMAIN` 1.8 | presence, not decoding |
| Risky TLD | `FROM_RISKY_TLD` 0.9 | deliberately weak — real businesses use `.xyz` |
| ≥ 4 hyphenated parts | `FROM_DOMAIN_MANY_PARTS` 0.8 | `secure-account-verify-login.example` |
| Long consonant-only label | `FROM_DOMAIN_RANDOM` 0.8 | throwaway domains |
| `From` is the user's own address, DMARC did not pass | `FROM_SELF_UNAUTHENTICATED` 2.2 | notes-to-self are legitimate, so authentication is the discriminator |
| Sending domain folds to the user's own domain but is not it | `FROM_LOOKALIKE_OF_SELF` 3.4 | colleague impersonation; skipped when the user's own domain is freemail |

### 6.5 How related authentication evidence is not double-counted

Two gates, and they are the fix for bugs 1, 2 and 5 (§18).

**Gate 1 — SPF and DKIM are only scored when DMARC did not speak.**

```ts
const dmarcSpoke = auth.dmarc === 'fail' || auth.dmarc === 'pass';

if (!dmarcSpoke) {
  if (auth.spf === 'fail') { /* AUTH_SPF_FAIL 1.6 */ }
  else if (auth.spf === 'softfail') { /* AUTH_SPF_SOFTFAIL 0.6 */ }
  if (auth.dkim === 'fail') { /* AUTH_DKIM_FAIL 1.4 */ }
}
```

DMARC **is** the alignment check over SPF and DKIM. `dmarc=fail` already reports
that neither mechanism aligned, so adding their weights charges one fact three
times: 3.5 + 1.6 + 1.4 = 6.5, past the 4.0 phishing bar on a broken signature
alone. That lands on mailing-list traffic first, which breaks all three routinely
(the list's servers break SPF, its footer breaks DKIM, DMARC therefore fails).

`dmarc=pass` is the mirror image: alignment held through whichever mechanism
passed, so the other one failing is the ordinary signature of forwarded mail.

Only when the domain publishes no policy — DMARC absent, `none`, or unreadable —
are SPF and DKIM the best evidence available, and only then are they scored.

**Gate 2 — `Return-Path` and `Message-ID` are only scored when DMARC did not pass.**

```ts
if (auth.dmarc !== 'pass') {
  if (headers.returnPath) { /* RETURN_PATH_MISMATCH 0.5 */ }
  if (headers.messageId)  { /* MESSAGE_ID_MISMATCH  0.4 */ }
}
```

Both are weak *proxies* for "did this domain really send the message". When DMARC
has answered that directly, the proxies add nothing — and every message sent
through an ESP (most legitimate bulk and transactional mail there is) bounces to
the ESP and stamps its `Message-ID` there while aligning through DKIM. Scoring
that would put a standing 0.9 on the largest single class of ordinary mail.

> **Difference from the earlier verification report.** That report described this
> fix as "`MESSAGE_ID_MISMATCH` suppressed when `RETURN_PATH_MISMATCH` has fired
> for the same host". The code implements the single `auth.dmarc !== 'pass'` gate
> above, wrapping **both** checks — when DMARC passes, neither symbol is charged at
> all. The code as quoted is authoritative.

**The `Received` chain is accepted and deliberately not scored.** `SpamHeaders`
carries a `received` field so that a caller holding the raw message can pass it
without error, but no rule reads it. Two reasons, from
[`types.ts:97-109`](../app/src/spam/types.ts#L97-L109): everything in the chain below the
receiving server is sender-controlled text, and what a client could soundly
conclude from it is exactly what `Authentication-Results` already states, having
been checked by the one hop that could check it.

## 7. Content analysis

[`app/src/spam/content.ts`](../app/src/spam/content.ts) — 488 lines.

### 7.1 No single word ever scores

The specification is explicit that a message must not be classified because it
contains *account*, *verify*, *payment*, *login*, *password* or *security*. Those
words are in every password reset, every bank statement, every receipt and every
legitimate security notice. **No individual word or phrase produces a symbol in
this module.** Evidence is built two ways instead.

**(1) Co-occurrence across intent families.** Words and phrases are grouped by
*purpose*. One family firing is worth nothing at all.

| Family | Meaning | Example entries | Entries |
|---|---|---|---|
| `urgency` | "Do this now or lose something" | `urgent`, `within 24 hours`, `final notice`, `today only` | 27 |
| `threat` | "Something bad happens if you don't" | `suspended`, `will be locked`, `unusual activity`, `legal action` | 32 |
| `credential` | "Give me your credentials" | `verify your account`, `enter your password`, `otp code`, `seed phrase` | 43 |
| `money` | "Move money" | `wire transfer`, `gift card`, `processing fee`, `tax refund` | 42 |
| `prize` | "You have won" | `you have won`, `lucky winner`, `claim your prize`, `free iphone` | 26 |
| `secrecy` | "Do not tell anyone" | `strictly confidential`, `keep it between`, `discreet` | 12 |
| `channel` | "Reply outside your normal channel" | `text me at`, `my new email`, `send me your` | 13 |

`credential` **alone** — which is exactly what a real password-reset mail looks
like — earns nothing. Adding a synonym to a family never makes a message score
higher, because within a family the entries are alternatives.

**(2) Form rather than vocabulary.** Shouting, exclamation runs, emoji density,
subject decoration, generic salutations, low vocabulary, invisible characters and
mixed scripts are properties of *how* a message is written. They survive
paraphrase, and a legitimate sender's use of them is genuinely unusual.

Every family match is tested against the **skeleton** as well as the raw text, so
inserting a zero-width space buys nothing:

```ts
const raw = `${subject}\n${body}`.toLowerCase();
const folded = skeleton(`${subject}\n${body}`);
const haystacks = folded === raw ? [raw] : [raw, folded];
```

Subject and body are one haystack for family matching — a pretext split across the
two is the same pretext — but the *form* checks treat them separately, because a
shouted subject and a shouted body are different behaviours.

### 7.2 How legitimate mail full of the watched words is protected

Five things, together:

1. **A single family scores zero.** A password-expiry notice is `credential` plus
   perhaps `urgency`; a receipt is `money` alone; a bank statement is `money`
   alone. None of those reaches a combination that means anything on its own.
2. **Only the heaviest combination scores** (§7.3), so breadth cannot compound.
3. **`CONTENT_MANY_PRETEXTS` requires four families**, not three (§7.3).
4. **Even the heaviest pairing is below both thresholds.** `CONTENT_THREAT_CREDENTIAL`
   at 3.6 needs more evidence from the headers, the links or the model to reach a
   verdict.
5. **The authentication credits subtract.** A bank's own fraud alert — written, of
   necessity, in the language of the attack it warns about — passes DMARC, and
   `AUTH_DMARC_PASS` −1.2 plus `AUTH_SPF_DKIM_PASS` −0.8 comes off both scores.

`demo-legit-security` in the demo mailbox is the standing regression test for this:
it says *password*, *verify*, *sign in* and *account*, and it measures
**`legitimate`, score −2** (§15).

### 7.3 Protection against over-scoring combinations

Eleven pairings are defined, drawn from the same family-hit map. Three families
therefore produce three pairings and four produce six — the score would grow
**quadratically in the evidence** rather than linearly. So:

```ts
const matched = COMBINATIONS.filter(({ pair }) => hits.has(pair[0]) && hits.has(pair[1]));
const strongest = matched.reduce(
  (best, candidate) => (best === null || candidate.weight > best.weight ? candidate : best),
  null,
);
if (strongest) out.push({ name: strongest.name, weight: strongest.weight, ... });
```

**One combination symbol per message: the heaviest that fired.** Urgency + threat
+ credential is *one* observation — "your access is at risk, act now, confirm your
details" — and charging it 3.6 + 3.4 + 2.0 = 9.0 puts it past the phishing bar on
wording alone. That was bug 3 (§18), and it landed on legitimate mail first.

Breadth is reported *separately* and only beyond what the pairing already charged:

```ts
if (hits.size >= 4) {
  out.push({ name: 'CONTENT_MANY_PRETEXTS', weight: 1.6, kind: 'spam', ... });
}
```

Four, not three: the strongest pairing already accounts for two families, so three
families is that pairing plus one — the ordinary shape of a genuine security
notice. 3.6 + 1.6 would land a bank's fraud alert on the spam threshold with
nothing from the headers or the links involved.

Saturation *within* one family is the third and last content aggregate — six or
more distinct entries from one family is an advance-fee letter, not a mail that
happens to mention a payment:

```ts
for (const [family, count] of hits) {
  if (count >= 6) out.push({ name: `CONTENT_${family.toUpperCase()}_HEAVY`, weight: 1.4, ... });
}
```

### 7.4 Bounds

`MAX_SCAN_CHARS = 20_000` for the body (matching the tokenizer's cap), 1000
characters for the subject. `contentSymbols` returns immediately when both are
empty, which is the unopened-encrypted-message case.

## 8. URL analysis

[`app/src/spam/urls.ts`](../app/src/spam/urls.ts) — 425 lines.

### 8.1 The engine never opens a link

**Nothing in this module touches the network.** No URL is fetched, resolved,
expanded, previewed or HEAD-requested — not even to "just check" where a shortener
points. Every judgement comes from the characters of the URL itself.

This is a correctness requirement, not caution. A classifier that fetched links
would announce to the sender that the message had been read, hand a tracking URL
its confirmation, and — in the phishing case it exists to catch — fetch
attacker-controlled content on the user's network.

The rule is **asserted in the tests**, not just documented:
`urls-test.ts` installs spies over the network entry points and asserts they are
never called across the whole suite (its first describe block is literally *"no
network access, ever"*).

The engine also never renders or evaluates the HTML it is given. `extractLinks` is
a bounded read-only scan (§8.4).

### 8.2 What each URL shape produces

| Shape | Symbol | Weight |
|---|---|---|
| Ordinary `https://shop.example/order/12` | *none* | — |
| Bare IPv4/IPv6 literal | `URL_IP_ADDRESS` | 2.6 |
| `0x7f000001`, `2130706433`, `017700000001` | `URL_OBFUSCATED_HOST` | 3.0 |
| Shortener (`bit.ly`, `t.co`, … 46 hosts) | `URL_SHORTENER` | **0.8** |
| Any `xn--` label | `URL_PUNYCODE_HOST` | 2.0 |
| Lookalike of a known brand | `URL_LOOKALIKE_DOMAIN` | 4.0 / 3.2 / 2.4 |
| `@` in the authority (userinfo) | `URL_USERINFO` | 2.8 |
| Invisible characters in the href | `URL_INVISIBLE_CHARS` | 2.4 |
| `?url=`/`?next=`/… pointing off-domain | `URL_EMBEDDED_REDIRECT` | 2.2 |
| ≥ 8 percent-escapes including structural ones | `URL_HEAVILY_ENCODED` | 1.6 |
| ≥ 2 credential words in the path, off the sender's domain | `URL_CREDENTIAL_PATH` | 1.8 |
| ≥ 5 host labels | `URL_DEEP_SUBDOMAIN` | 1.0 |
| A brand name in the site part of free hosting | `URL_BRAND_ON_FREE_HOST` | 2.6 |
| Anchor text is a host, destination is another | `URL_TEXT_HOST_MISMATCH` | 3.2 |
| Anchor text names a brand, destination is not it | `URL_TEXT_BRAND_MISMATCH` | 2.4 |
| One link, body under 200 chars | `URL_ONLY_MESSAGE` | 0.6 |
| ≥ 8 distinct registrable domains | `URL_MANY_HOSTS` | 0.5 |

**A shortener is not a verdict.** Every newsletter platform on earth wraps its
links, so `bit.ly` is worth 0.8 — a sixth of the spam threshold. What is worth real
weight is a shortener next to credential language, or an anchor that lies.

**`URL_CREDENTIAL_PATH` needs two words and a foreign domain.** One is ordinary —
every service has a `/login`. Two on a stranger's domain is a harvesting page:

```ts
if (words.length >= 2 && (!fromDomain || !sameRegistrableDomain(host, fromDomain))) { … }
```

**`URL_EMBEDDED_REDIRECT` only fires cross-domain**, because ordinary login flows
legitimately carry a same-site `?next=`. A malformed percent-escape in the embedded
value is caught and the raw value used instead — not a crash.

**`URL_BRAND_ON_FREE_HOST` looks for the brand only in the labels the page's author
chose**, never in the provider's suffix, or `sites.google.com` would report itself
as impersonating Google.

### 8.3 Degenerate and hostile input

| Input | Behaviour |
|---|---|
| `links` absent / `null` / not an array | `Array.isArray(input.links) ? … : []` — no symbols, no throw |
| A link entry that is `null`, or `href` not a string | skipped |
| `href` empty after trimming | skipped |
| `href` whose host cannot be read (`hostOf` → null) | skipped |
| Missing anchor text | host-based symbols still fire; the text-vs-destination checks are skipped (`if (!label) continue`) |
| `javascript:`, `data:`, `file:`, `mailto:` | **dropped by `readHref`** — never recorded, never tokenized |
| Many links exhibiting one finding | that finding fires **once**; a 40-link newsletter is one shortener finding |

Per-finding deduplication is explicit:

```ts
const fired = new Set<string>();
const push = (symbol: SpamSymbol) => {
  if (fired.has(symbol.name)) return;
  fired.add(symbol.name);
  out.push(symbol);
};
```

A per-link tally would let link *count* alone push any bulk mail over the
threshold.

### 8.4 Reuse of the existing URL parser

Host and path extraction are **not** reimplemented here. `urls.ts` imports
`hostOf` and `pathOf` from [`app/src/lib/links.ts`](../app/src/lib/links.ts) — the
same module the rest of the app uses — so there is one parser and no chance of the
filter and the UI disagreeing about where a link goes. `categorizer.ts` reuses
`linkify` from the same module for its prose-URL fallback.

What *is* new is `extractLinks`, and only because the pairing it produces is
information `plainBody.ts`'s `htmlToText` deliberately discards: `htmlToText`
produces readable text, and an `href`-to-anchor-text pairing is not text. It is the
evidence for the strongest link symbol, so it gets its own pass. That pass is a
bounded scan, not an HTML parser, with three properties that are requirements
rather than niceties because it runs on remote input:

- it only ever **reads** — no markup is executed, no resource loaded, and
  `javascript:` / `data:` hrefs are dropped rather than recorded;
- the regex has **no nested quantifier that can backtrack**, so hostile markup
  cannot make it hang;
- input and output are **both capped** — `MAX_HTML_CHARS = 400_000`,
  `MAX_LINKS = 200`, anchor text 2000 chars matched and 300 kept, href 2000 —
  so a 5 MB page of anchors cannot exhaust memory.

Unclosed anchors get a second pass: malformed markup or a truncated body still
yields the href, with empty text.

## 9. Unicode, brand impersonation and lookalike security

[`app/src/spam/unicode.ts`](../app/src/spam/unicode.ts) — 396 lines. Everything
here is a *comparison primitive*: it answers "are these two strings the same to a
human?", and the rule modules decide what to do with the answer.

### 9.1 Invisible characters

`INVISIBLE` covers the soft hyphen, the Mongolian vowel separator, the zero-width
space / non-joiner / joiner, the Arabic letter mark, the bidirectional embedding
and override controls, the word joiner, the invisible operators, the interlinear
annotation controls and the BOM.

```ts
export function hasInvisibleCharacters(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  return new RegExp(INVISIBLE.source).test(text);
}
```

A fresh `RegExp` per call, deliberately: a module-level `/g` regex carries
`lastIndex` between calls, so the same string would answer differently the second
time. There is a test that asserts exactly that (*"is not stateful"*).

`stripInvisible` removes them. The bidirectional overrides matter beyond padding —
`invoice<RLO>fdp.exe` *displays* as `invoicexpe.pdf`, which is why
`ATTACH_NAME_REVERSED` (3.6) exists in the content module.

### 9.2 Mixed scripts

`hasMixedScriptWord` is per-token, and that is the whole design: real multilingual
writing switches script **at word boundaries**, so `Привет — meeting at three` and
`請查看 the attached invoice` are not flagged, while `pаypal` (one Cyrillic `а`) is.
Tokens shorter than three characters are skipped, and fullwidth characters are
excluded from the confusable count because a fullwidth word is a stylistic choice,
not a substitution.

### 9.3 Two folding levels, and why they are separate

| Function | Folds | Safe for |
|---|---|---|
| `skeleton` | invisibles, cross-script confusables, NFKC, lowercase | **prose and display names** |
| `domainSkeleton` | all of the above **plus** ASCII lookalikes (`0→o`, `1→l`, `@→a`, …) **plus** stripping `[-_.]` | **domains only** |

The split is a correctness requirement. Folding `1→l` inside body text would make
`l1` and `ll` the same word and corrupt every prose comparison in the engine —
there is a test pinning `skeleton('paypa1') === 'paypa1'`. For a *domain* it is
exactly right: the eye cannot tell `paypa1.com` from `paypal.com`, and
`pay-pal.com` from `paypal.com`.

**Punycode is noticed, not decoded.** `hasPunycodeLabel` tests for an `xn--` label.
A decoder would be a dependency, and the presence of an encoded label in mail
claiming to be a household brand is already the signal worth having. This is a
documented limitation: the engine cannot tell *which* name an `xn--` label decodes
to, so `URL_PUNYCODE_HOST` is 2.0 rather than a lookalike weight.

### 9.4 The registrable-domain unit

`registrableDomain` is what every domain comparison in the engine runs on.
Comparing whole hosts would call `mail.google.com` and `google.com` different
senders — flagging the mail of every large organisation. Comparing only the last
two labels would call every `github.io` page the same sender, which is precisely
the free-hosting phishing case.

`MULTI_LABEL_SUFFIXES` is a 71-entry set — country-code suffixes (`co.uk`,
`com.au`, `co.jp`, …) plus the free-hosting and cloud suffixes that change a
verdict (`github.io`, `vercel.app`, `pages.dev`, `sharepoint.com`,
`s3.amazonaws.com`, `ngrok-free.app`, …). It is **not** the Public Suffix List;
that is a 15 000-line data file needing updates. This is a documented limitation:
a country-code suffix outside the set is read as two labels.

`editDistance` is capped (default limit 3, band-limited) — it answers "is this
within N edits" and gives up rather than computing a large distance.

### 9.5 Brand detection

`BRANDS` is a 34-entry table of brand name → domains the brand actually owns:
`paypal`, `apple`, `microsoft`, `google`, `amazon`, `netflix`, `facebook`,
`instagram`, `whatsapp`, `linkedin`, `dropbox`, `docusign`, `coinbase`, `binance`,
`chase`, `wellsfargo`, `hsbc`, `barclays`, `santander`, `natwest`, `citibank`,
`americanexpress`, `fedex`, `dhl`, `ups`, `usps`, `steam`, `spotify`, `adobe`,
`stripe`, `wise`, `revolut`, `hmrc`, `irs`.

**The owned-domains column is the point of the table.** `lookalikeBrand` checks it
*first* and returns `null` for anything inside a brand's own registrable domain —
otherwise a warning banner would appear on real PayPal receipts. Then, in
decreasing order of certainty:

| Reason | Test | Weight when used by `headers.ts` / `urls.ts` |
|---|---|---|
| `confusable` | folded domain skeleton equals the brand's own — `pаypal.com`, `paypa1.com` | 4.0 / 4.0 |
| `near-miss` | 1–2 edits from the brand name — `paypall.com`, `micosoft.example` | 3.2 / 3.2 |
| `embedded` | the brand is a label but the registrable domain is someone else's — `paypal.account-verify.example`, `paypal-security.example` | 2.6 / 2.4 |

**Near-miss requires five characters on both sides**, and ≤ 2 edits only for brands
of 8+ characters (else ≤ 1):

```ts
if (stem.length < 5 || brand.name.length < 5) continue;
const distance = editDistance(stem, brand.name, 2);
if (distance > 0 && distance <= (brand.name.length >= 8 ? 2 : 1)) { … }
```

One edit from `ups`, `irs`, `dhl` or `wise` is not evidence of anything —
`ups2.example`, `wisely.example`, `irish.example` are all one edit from a brand and
none is imitating one — and at 3.2 points a false hit there would be the single
largest unjustified weight the engine can produce.

### 9.6 `brandsNamedIn` — the substring false-positive problem and its fix

**What was wrong.** The original implementation folded the display name to
`[a-z0-9]` and asked `includes()`. That reads brand names out of ordinary English,
because brand names *are* ordinary letter sequences.

**Measured false positives**, each worth `BRAND_NAME_WRONG_DOMAIN` 2.8 phishing
points — 3.4 from a freemail address — on a message that claimed nothing:

| Display name | Read as | Where |
|---|---|---|
| `Rewards Team` | `steam` | across the word break — rew**ards Team** |
| `First National Bank` | `irs` | f-**irs**-t |
| `Purchase Support` | `chase` | pur-**chase** |
| `Groups Digest` | `ups` | gro-**ups** |
| `Startups Weekly` | `ups` | start-**ups** |
| `Otherwise Studio` | `wise` | other-**wise** |
| `Wise Owl Books` | `wise` | genuine word (still matches — §9.7) |
| `Firstly Design` | `irs` | f-**irs**-tly |

A bookshop's newsletter arrived most of the way to a phishing verdict on its
display name alone. The first attempted fix was insufficient — a probe then caught
`Chasewater Angling`, `Steamboat Springs News`, `Appleton Dental`, `Stripes and
Checks`, `Upstate Records` — and was replaced within the same phase.

**The shipped fix.** Split the text into words *on the skeleton* (which is what
keeps `Pay-Pal`, `Pay<ZWSP>Pal` and Cyrillic `PаyPal` matching) and accept only two
shapes:

```ts
function namesBrand(words: string[], brand: string): boolean {
  for (let i = 0; i < words.length; i += 1) {
    // The brand plus a role word or a number, run together as one word.
    if (words[i].length > brand.length && words[i].startsWith(brand)) {
      const rest = words[i].slice(brand.length);
      if (/^[0-9]+$/.test(rest) || BRAND_ROLE_WORDS.includes(rest)) return true;
    }
    // The brand spelled by one word, or by consecutive words: `Pay Pal`.
    let run = '';
    for (let j = i; j < words.length && run.length < brand.length; j += 1) run += words[j];
    if (run === brand) return true;
  }
  return false;
}
```

`BRAND_ROLE_WORDS` is a **closed** 37-entry list (`support`, `security`, `service`,
`billing`, `team`, `account`, `alert`, `verify`, `tracking`, `express`, `refund`,
`id`, …). "Anything after the brand" is the open version that produced the
false positives.

**Worked examples, all asserted in `unicode-test.ts`:**

| Input | Result | Why |
|---|---|---|
| `PayPal Service` | `['paypal']` | consecutive words spell the brand |
| `Pay-Pal Security` | `['paypal']` | separators are word boundaries on the skeleton |
| `Pay<ZWSP>Pal` | `['paypal']` | invisibles stripped by `skeleton` |
| `PаyPal` (Cyrillic `а`) | `['paypal']` | confusable folded |
| `microsoft365 billing` | `['microsoft']` | brand + digits |
| `PayPalSupport` | `['paypal']` | brand + role word |
| `AmazonSecurity` | `['amazon']` | brand + role word |
| `UPS Tracking` | `['ups']` | short brand as its own word — the real impersonation |
| `IRS Refund Dept` | `['irs']` | as above |
| `DHL Express` | `['dhl']` | as above |
| `Rewards Team` | `[]` | not a word run |
| `First National Bank` | `[]` | brand inside a longer word |
| `Priya Raman` | `[]` | claims nothing |

### 9.7 Accepted limitations

These are **documented, deliberate** trade-offs, not defects.

1. **`SecurePayPal` → `[]`.** A brand as the tail or the middle of a longer word is
   not matched. Accepting the miss is much cheaper than re-admitting the substring
   class, and the spaced and hyphenated forms — which is what phishers actually
   send, because the display name has to read as the brand to a human — are caught.
   *(Verified still present in the current code.)*
2. **A brand whose name is an ordinary word still matches as that word.** `Wise Owl
   Books` reports `wise`; `Chase Bennett` reports `chase`. Separating those needs
   meaning, not spelling. The consequence is bounded — one 2.8-point symbol, below
   both thresholds alone — and `brandOwnsHost` keeps the real brand's mail clear.
3. **Confusables are a working subset**, not the full Unicode confusables data
   (tens of thousands of entries, which would be a data file rather than a rule):
   Cyrillic, Greek, Armenian/Cherokee singles, and fullwidth forms.
4. **Punycode is not decoded** (§9.3).
5. **`MULTI_LABEL_SUFFIXES` is not the Public Suffix List** (§9.4).
6. **34 brands.** A brand outside the table gets no impersonation protection; an
   unknown-brand lookalike is invisible to `lookalikeBrand`.

## 10. The Naive Bayes model

[`app/src/spam/bayes.ts`](../app/src/spam/bayes.ts) (333 lines) and
[`app/src/spam/tokenize.ts`](../app/src/spam/tokenize.ts) (193 lines).

### 10.1 What it does and why it is personal

The rules encode what spam looks like *in general*. They cannot know that this
particular user reads three cryptocurrency newsletters on purpose, or that their
accountant really does send "URGENT: invoice attached" every month. Only
corrections can teach that, and Bayes is the classical way to turn corrections into
a score — Paul Graham's *A Plan for Spam* is the origin, SpamAssassin's `BAYES_*`
symbols are the same idea in production.

**The model is trained only by this user, on this device, and is never shared.**
There is no seed corpus, no download and no upload.

### 10.2 Tokens

`tokenize` produces a **multiset** of namespaced tokens. The namespace matters:
"invoice" in a subject is different evidence from the same word in a body.

| Prefix | Source | Example |
|---|---|---|
| `s:` | subject words | `s:invoice` |
| `sp:` | subject phrases | `sp:verify_your_account` |
| `b:` | body words | `b:bitcoin` |
| `bp:` | body phrases | `bp:wire_transfer` |
| `f:` | full sender address | `f:billing@shop.example` |
| `d:` | sender domain, and its registrable form | `d:mail.shop.example`, `d:shop.example` |
| `n:` | sender display-name words | `n:paypal` |
| `u:` | link **hosts** and their registrable form | `u:bit.ly` |
| `h:` | header **facts** | `h:has_list_unsubscribe`, `h:dmarc_fail` |

Bounds and filters: body capped at `MAX_BODY_CHARS = 20_000`, subject at 1000;
words 2–24 characters; a 39-entry `STOP_WORDS` set; bare digit runs dropped; case
folded. 56 `PHRASES` give bigrams their own tokens — which is where the "do not
classify on the word *account*" requirement is answered in the learning half: the
model learns `verify your account` as a unit.

**What is deliberately *not* tokenized:**

- **Whole URLs** — only hosts. A URL carries a per-recipient tracking id, so
  training on it would fill the model with tokens that can never recur.
- **Header values** — only facts. Whether a message carried unsubscribe hygiene is
  learnable; the mailing-list id inside the header is not.
- **`returnPath` and `messageId`** — `tokenizeInputFor` in `spam.ts` omits them.
- **Form** (all-caps, emoji, punctuation runs) — that is a rules-side signal,
  because otherwise every caps-locked legitimate mail poisons the model with a
  token nobody can un-learn.

### 10.3 The model's shape

```ts
export type SpamModel = {
  version: number;
  spam: Record<string, number>;   // token → messages marked spam that contained it
  ham: Record<string, number>;
  spamMessages: number;           // messages trained, not tokens
  hamMessages: number;
  updatedAt: number | null;       // diagnostic only
};
```

Two count tables and two message counts. That is the whole model. **It holds counts
of tokens, never the messages they came from** — no order, no punctuation, no
addressee, no full URL, no body. A trained model cannot be read back as mail.

`MAX_VOCABULARY = 12_000`. Beyond it, `prune` drops tokens seen exactly once — the
ones carrying least evidence, and the ones a re-encounter would re-learn anyway.
Unbounded growth would otherwise put megabytes through the seal on every save.

### 10.4 Minimum training — the exact requirement

```ts
export const MIN_TRAINED_MESSAGES = 5;

export const modelIsTrained = (model: SpamModel): boolean =>
  model.spamMessages >= MIN_TRAINED_MESSAGES && model.hamMessages >= MIN_TRAINED_MESSAGES;
```

**Five in each class, not five in total** — `&&`, not `||`. Below that, `classify`
returns `{ applies: false, probability: 0.5, tokensUsed: 0 }` and contributes
nothing, so a new install behaves exactly as it did before the model existed. That
is also the required "empty model" behaviour: an empty model is simply an untrained
one, and needs no special case.

`applies: false` is also returned when the model **is** trained but the message
produced no token the model recognises. Both are genuinely "no opinion", and
reporting 0.5 as though it were a measurement would let a neutral result drag a
rules-based verdict around.

### 10.5 Per-token probability

```ts
function tokenProbability(model: SpamModel, token: string, cap: number): number | null {
  const spamHits = model.spam[token] ?? 0;
  const hamHits = model.ham[token] ?? 0;
  if (spamHits + hamHits < MIN_TOKEN_SIGHTINGS) return null;      // MIN_TOKEN_SIGHTINGS = 2

  const spamRate = spamHits / Math.max(1, model.spamMessages);
  const hamRate = (2 * hamHits) / Math.max(1, model.hamMessages);  // ham weighted ×2
  const raw = (spamRate + SMOOTHING / Math.max(1, model.spamMessages + model.hamMessages))
    / (spamRate + hamRate + (2 * SMOOTHING) / Math.max(1, model.spamMessages + model.hamMessages));

  return Math.min(cap, Math.max(1 - cap, raw));
}
```

Three properties, each load-bearing:

- **Rate-normalised.** Dividing each raw count by its class's message total makes a
  user who marked 200 spam and 20 ham comparable to one who did the reverse.
  Without it the model would simply learn whichever button was pressed more.
- **Ham weighted ×2**, as in *A Plan for Spam*: a false positive costs the user a
  real message, a false negative costs them a delete.
- **Laplace smoothing** (`SMOOTHING = 1`, scaled by the corpus size) so an unseen
  token gets presence rather than zero.
- **`MIN_TOKEN_SIGHTINGS = 2`** — a token seen once has not earned a vote.

### 10.6 Combination

```ts
scored.sort((a, b) => b.interest - a.interest || a.token.localeCompare(b.token));
const voting = scored.slice(0, MAX_VOTING_TOKENS);          // MAX_VOTING_TOKENS = 20

let logOdds = 0;
for (const { probability } of voting) logOdds += Math.log(probability / (1 - probability));
const combined = 1 / (1 + Math.exp(-logOdds));
```

`interest` is `Math.abs(probability - 0.5)`, so the **20 most decisive** tokens
vote and the rest are discarded. Graham's insight: a long message otherwise drowns
its own signal in hundreds of neutral tokens, and the neutral tokens are precisely
where a small corpus is least trustworthy. The tie-break on token name makes the
selection deterministic.

Combination is a **sum of log-odds**, not Graham's product of probabilities. It is
the same function, but a 20-term product of values near 0.01 underflows float64 to
zero and takes the verdict with it. Log-odds is computed in a range the hardware
can represent.

### 10.7 Overconfidence protection — three guards

A classifier trained on four messages will happily report probability 0.999, and a
filter that believes it will hide the user's mail.

**Guard 1 — the minimum training gate** (§10.4).

**Guard 2 — `confidenceCap`, per token.**

```ts
function growthFactor(model: SpamModel): number {
  const examples = Math.min(model.spamMessages, model.hamMessages);
  return Math.min(1, Math.max(0, (examples - MIN_TRAINED_MESSAGES) / (50 - MIN_TRAINED_MESSAGES)));
}

function confidenceCap(model: SpamModel): number { return 0.85 + growthFactor(model) * 0.14; }
```

0.85 at 5 examples of each class, relaxing to 0.99 at 50. Applied symmetrically
(`1 - cap` at the bottom), so a token cannot be overwhelming evidence of *ham* on
thin data either. This is what stops one lucky word in one training message from
deciding every future verdict.

**Guard 3 — `verdictCap`, on the combined result.** This is the one that actually
holds the line:

```ts
function verdictCap(model: SpamModel): number { return 0.9 + growthFactor(model) * 0.099; }
```

`confidenceCap` bounds one token; it does not bound twenty. Twenty tokens at 0.85
each sum to a log-odds near 35, which is 1.0 in float64 — a five-message corpus
would report certainty even though no individual token was allowed to. So the
combined probability is clamped to 0.90 at the minimum training size, relaxing to
0.999 at 50 examples of each class.

**0.90 is not arbitrary**: it is the probability at which `bayesWeight` returns
2.14 — short of its own ±3.0 ceiling, and well short of the 5.0 spam threshold. A
model trained on ten messages therefore contributes real evidence and cannot come
close to deciding a verdict by itself.

### 10.8 Score contribution and the dead zone

```ts
export function bayesWeight(result: BayesResult): number {
  if (!result.applies) return 0;
  const p = result.probability;
  if (p >= 0.65) return Math.min(3.0, ((p - 0.65) / 0.35) * 3.0);
  if (p <= 0.35) return Math.max(-3.0, -((0.35 - p) / 0.35) * 3.0);
  return 0;
}
```

| Probability | Weight | Symbol emitted by `spam.ts` |
|---|---|---|
| not applied | 0 | none |
| 0.35 – 0.65 | **0** — the dead zone | none (weight 0 is dropped) |
| 0.80 | +1.29 | `BAYES_SPAM`, kind `spam` |
| 0.90 | +2.14 | `BAYES_SPAM` |
| 0.999 | +3.00 (capped) | `BAYES_SPAM` |
| 0.10 | −2.14 | `BAYES_HAM`, kind `ham` |

**The dead zone is implemented** (0.35–0.65 → exactly 0): a model that is unsure
should be silent rather than nudging.

±3.0 against a spam threshold of 5.0 is "no single signal decides" applied to the
learned half of the engine. **`BAYES_SPAM` is `kind: 'spam'`, never `'phishing'`,
and is not `counterPhishing`** — the model learns what this user does not want,
which is not the same as evidence of impersonation, so Bayes can neither create nor
cancel a phishing verdict on its own.

### 10.9 Training, untraining and duplicate prevention

`train` and `untrain` are **pure** — the input model is never mutated, which lets
the caller treat a failed save as "training did not happen" rather than leaving
state and storage disagreeing. `learn`/`unlearn` in `spam.ts` are the thin wrappers
the state layer calls.

```ts
const tokens = Object.keys(countTokens(tokenize(input)));   // note: Object.keys
```

**Token counts within a message are collapsed to one increment per token** —
"bitcoin" eleven times still trains once — because otherwise a single long message
would outweigh dozens of short ones. Repetition is evidence at scoring time and
distortion at training time.

`untrain` returns the model unchanged when that class's message count is already
zero, and counts floor at zero (`if (next > 0) … else delete table[token]`), so a
double-untrain cannot corrupt the model. A message with no tokens at all trains
nothing (`if (tokens.length === 0) return model`).

**Duplicate training is prevented one level up**, in `applyMark`
([`app/src/state/mailbox.ts:210`](../app/src/state/mailbox.ts#L210)):

```ts
const previous = state.spam.marks[id];
let model = state.spam.model;
if (previous === mark) return;
if (previous) model = unlearn(model, input, previous);
model = learn(model, input, mark);
```

Marking the same message spam twice is a no-op. Marking it spam then not-spam
untrains the first example before training the second, so the model never holds
both — without that, the filter would learn that the message's vocabulary means
nothing in particular.

### 10.10 Versioning and corrupted models

```ts
export const SPAM_MODEL_VERSION = 1;
```

`isSpamModel` validates a loaded value structurally: exact version match, both
count tables must be non-array objects of finite non-negative numbers, both message
counts must be finite non-negative, `updatedAt` must be `null` or such a number.
Anything else is rejected.

**A version mismatch is treated as "no model"** — never as an error to surface, and
never as a reason to guess. The same for a truncated write or a hand-edited value.
Losing a training corpus is recoverable by marking a few more messages; a half-read
one misfiles mail silently, which is worse. See §12.3 for the load path.

## 11. User corrections

Two actions, exposed on `useApp()` and implemented as one function:

```ts
markSpam:    (id) => applyMark(id, 'spam'),
markNotSpam: (id) => applyMark(id, 'ham'),
```

### 11.1 What happens on a tap

1. The message is looked up in current state (`store.get()`, not a render
   snapshot). **If it is not in the mailbox, nothing happens.**
2. `isEncrypted(summary)` is computed from the placeholder-subject test, and
   `spamInputFor` builds the training input, so an unopened encrypted message
   trains on its cleartext headers and nothing else (§13.4). Note the asymmetry
   this leaves: encrypted mail is never *scored* (§13.4), but the user may still
   mark one, and that mark trains the model. Deliberate — the user chose to file
   it, and what they teach the filter carries over to plaintext mail.
3. `if (previous === mark) return;` — the duplicate guard.
4. The previous mark, if any, is untrained; the new one is trained.
5. `store.patch({ spam })` updates state **synchronously**, so the UI re-renders
   with the new verdict immediately.
6. `await saveSpamState(spam)` seals mark and model **together in one record**, so
   a restart cannot restore a mark whose training was lost, or vice versa.

**Marking spam does not archive or delete the message.** The mark moves it to the
Spam category, which is a filing decision the user can reverse. Removing it from
the mailbox is a different action with a different button.

### 11.2 How the override works, and why it has priority

The mark short-circuits the whole engine — it is the *first* thing
`classifyMessage` checks:

```ts
export function classifyMessage(input: SpamInput, options: ClassifyOptions = {}): SpamVerdict {
  if (options.mark === 'spam' || options.mark === 'ham') return overrideVerdict(options.mark);
  …
}
```

`overrideVerdict` returns a verdict with one zero-weight symbol
(`USER_MARKED_SPAM` / `USER_MARKED_HAM`), `score` = `SPAM_THRESHOLD` for spam or
`0` for ham, `phishingScore: 0`, `bayesApplied: false`, and **`overridden: true`**
so the UI can say *you marked this* rather than presenting a computed reason.

No amount of rule or model evidence can move a marked message. **The user is the
ground truth for their own mailbox** — a filter that argued with an explicit
correction would be worse than no filter, and the correction is also the training
signal, so overriding it would mean disagreeing with what the model was just
taught.

### 11.3 Effect on future classification

Two separate effects, and the distinction matters:

- **This message** is filed by its mark, forever (or until the mark is changed or
  trimmed — §12.4).
- **Similar future messages** are affected only through the model, and only once
  both classes reach five examples. Before that the correction is recorded and
  learned but changes no other message's verdict. This is deliberate: it is the
  same "not overconfident on thin data" rule as §10.7, seen from the user's side.

### 11.4 Double taps and repeated corrections

| Sequence | Result |
|---|---|
| Spam, Spam | Second tap returns immediately. One training example, one mark. |
| Spam, Not-spam | `unlearn(spam)` then `learn(ham)`. One net example, mark now `ham`. |
| Spam, Not-spam, Spam | Net one spam example. Counts cannot drift. |
| Mark on a message no longer in the mailbox | No-op. |

The `previous === mark` guard is only sound because `store.patch()` is synchronous
and there are no `useRef` mirrors of state fields — a second tap reads the mark the
first one wrote.

## 12. Persistence

[`app/src/store/spamModelStore.ts`](../app/src/store/spamModelStore.ts) — 132 lines.

### 12.1 What is stored

One record under one key:

```ts
export const SPAM_STORE_KEY = 'cryptmail.spam.v1';

export type SpamState = {
  model: SpamModel;                    // token counts + message counts + version
  marks: Record<string, SpamMark>;     // message id → 'spam' | 'ham'
};
```

One record rather than two stores, because the marks and the model are written
together on every correction — splitting them would allow a state where a message
is marked spam but the model never learned it.

### 12.2 What is **not** stored

> **Email bodies are not persisted by the spam model.** Neither are subjects,
> recipients, full URLs, header values, or anything that could be read back as
> mail.

What is stored instead is **token counts**: how often each word, phrase, sender
domain, link *host* or header *fact* appeared in a message the user marked. There
is no order, no punctuation, no addressee, no full URL and no body, so the model
cannot be reconstructed into a message.

The marks are an id and a one-word verdict — no content at all.

This is a data-minimisation decision, not an accident of the algorithm. The one
store in the app that *does* hold decrypted subjects and bodies is
[`app/src/store/searchIndex.ts`](../app/src/store/searchIndex.ts), which exists so
encrypted mail is searchable, and it remains the only one.

### 12.3 Sealing, restore and corrupt state

The record goes through
[`app/src/store/secureJson.ts`](../app/src/store/secureJson.ts) like every other
store, so it is **encrypted at rest** under the device DEK (XChaCha20-Poly1305, DEK
in `expo-secure-store`). `SPAM_STORE_KEY` is registered in `SEALED_STORE_KEYS`
([`app/src/store/index.ts:32`](../app/src/store/index.ts#L32)), so an install that
predates the feature gets swept into the seal by the boot-time
`resealPlaintext` pass.

`loadJson` already guards a missing key and unparseable JSON. What it cannot know
is whether the parsed object is *this* shape, so the load path validates:

```ts
export function normaliseSpamState(value: unknown): SpamState {
  if (typeof value !== 'object' || value === null) return emptySpamState();
  const record = value as Record<string, unknown>;
  return {
    model: isSpamModel(record.model) ? (record.model as SpamModel) : emptyModel(),
    marks: readMarks(record.marks),
  };
}
```

**The two halves are validated independently**, and that is deliberate: a corrupted
model with intact marks keeps the marks, because the user's own decisions are the
part that cannot be regenerated. `readMarks` copies through only entries whose
value is exactly `'spam'` or `'ham'` with a non-empty id, dropping everything else
rather than rejecting the whole table.

| On disk | Loaded as |
|---|---|
| key absent | empty model, no marks |
| unparseable JSON | empty model, no marks |
| not an object (`42`, `"x"`, `null`) | empty model, no marks |
| an array | empty model, no marks |
| `{ model: <valid>, marks: <garbage> }` | the model, no marks |
| `{ model: <garbage>, marks: <valid> }` | **empty model, marks kept** |
| `{ model: { version: 2, … } }` | empty model (version mismatch) |
| a count table containing `-1`, `NaN`, `"3"` or a nested object | empty model |

`normaliseSpamState` is exported specifically so the tests can assert this
recovery behaviour directly, without staging a corrupted value through
AsyncStorage.

### 12.4 Maximum mark count

```ts
const MAX_MARKS = 2_000;
```

`trimMarks` runs on **save**, keeping the last 2000 in insertion order. `Record`
preserves insertion order for string keys, which is what makes "oldest" meaningful
without storing a timestamp per mark — and `setMark` deletes before re-inserting so
a re-touched id moves to the end.

Trimming is **lossless for training**: the model already learned from every mark. A
mark's only remaining job is to override the score for a message still in the
mailbox, so dropping the oldest merely means a very old message would be re-scored
by rules if it were opened again.

## 13. Privacy and security properties

### 13.1 What the engine never does

| Property | How it is guaranteed |
|---|---|
| **No network access, ever** | No `fetch`, no `XMLHttpRequest`, no `import` of any network module anywhere in `app/src/spam/`. `urls-test.ts`'s first block spies on the network entry points and asserts they are never called. |
| **No URL is opened, fetched, crawled, resolved, expanded, previewed or HEAD-requested** | §8.1. Every URL judgement comes from the characters of the URL. |
| **No email JavaScript is executed** | `extractLinks` is a bounded read-only regex scan (§8.4); `readHref` drops `javascript:`, `data:`, `file:` and `mailto:` outright. Nothing is passed to an evaluator. |
| **No HTML is rendered or evaluated** | as above — the scan reads characters and produces strings. |
| **No remote resource is downloaded** | no network. |
| **No attachment is executed or its bytes read** | §13.3. |
| **No command is run from email content** | no process API is imported. |
| **Sender-supplied content is never trusted** | every field is type-checked at the boundary (`normalise` in `spam.ts`, `Array.isArray` guards, `typeof x === 'string'` guards) and every rule module is written to be total. |
| **Malformed input cannot crash the inbox** | §13.5. |
| **Email bodies are never persisted by the model** | §12.2. |

**No dependency was added for this feature.** No TensorFlow, no Python, no
Node-only spam library, no ClamAV, no SpamAssassin, no rspamd, no pretrained model,
no ML framework, no Public Suffix List data file, no punycode decoder, no Unicode
confusables data file. The engine imports only from within the app
(`lib/links`, `spam/*`) and uses no runtime that is not already present.
`app/package.json` is unchanged by this feature.

### 13.2 This is not an antivirus or malware scanner

**The spam and phishing engine is not an antivirus, not a malware scanner, and not
a content-security product.** It does not detect malware, it cannot tell whether an
attachment is malicious, and it will not stop a user from opening one. It reads
*envelope and text evidence* and reports a likelihood that a message is unwanted or
impersonating someone.

Malware scanning is listed as still-open work in
[`docs/features.md`](features.md); nothing here closes it.

### 13.3 Attachment handling — metadata only

`AttachmentMeta` in [`app/src/spam/types.ts:117`](../app/src/spam/types.ts#L117) is
`{ filename?: string; contentType?: string; size?: number }`, and its comment states
the rule: *"Attachment metadata only — name, type, size. The bytes are never read,
never decoded and never executed."*

`attachmentSymbols` in
[`app/src/spam/content.ts:411`](../app/src/spam/content.ts#L411) reads **two** of
those three — `filename` and `contentType`. (`size` is part of the type but no rule
currently uses it.) Every symbol is a statement about the *name and the declared
type*:

| Symbol | Weight | Kind | What it observes |
|---|---|---|---|
| `ATTACH_DOUBLE_EXTENSION` | 4.0 | phishing | `invoice.pdf.exe` — an executable extension behind a short harmless one |
| `ATTACH_NAME_REVERSED` | 3.6 | phishing | a bidirectional override in the filename, which reverses how the extension *displays* |
| `ATTACH_EXECUTABLE` | 2.6 | phishing | an executable extension with nothing disguising it (34 extensions) |
| `ATTACH_HTML_PAGE` | 2.2 | phishing | `.html`/`.htm`/`.shtml`/`.xhtml` — a local sign-in page with no address bar to check |
| `ATTACH_TYPE_MISMATCH` | 1.4 | phishing | declares `application/pdf` but is not named `.pdf` |
| `ATTACH_MACRO_DOCUMENT` | 1.2 | spam | a macro-enabled Office format — ordinary in business mail, so the weight is small |
| `ATTACH_ARCHIVE` | 0.5 | spam | an archive — deliberately near-zero, since archives are ordinary |

An `Array.isArray` guard, a `typeof meta === 'object'` filter and a per-name `fired`
set mean a malformed list, a null entry and a 40-attachment message all behave
sanely.

> **Not currently wired.** `spamInputFor` — the only integration path that builds a
> `SpamInput` in the app — does **not** populate `attachments`, because `MailSummary`
> carries no attachment metadata. These rules are implemented and covered by
> `content-test.ts`, but in the running app **no attachment is scored today**. They
> take effect the moment a caller supplies the field; nothing else has to change.

### 13.4 The encryption boundary

This is the property that makes an on-device filter honest, and it is enforced in
**one** place: `spamInputFor` in
[`app/src/categorizer/categorizer.ts`](../app/src/categorizer/categorizer.ts).

```ts
const content = encrypted ? index[summary.id] : undefined;
const readable = encrypted
  ? content
    ? { subject: content.subject, body: content.body }
    : { subject: undefined, body: undefined }
  : { subject: summary.subject, body: summary.snippet };
```

| Message | Subject / body the engine sees |
|---|---|
| Plaintext | header `Subject` + provider `snippet` |
| Encrypted, opened on this device | the decrypted subject and body from `searchIndex` |
| Encrypted, never opened | **nothing** — `undefined` for both |

That is what `spamInputFor` *would* pass on. But the gate above it is blunter:

> **Encrypted mail is not classified at all.** `verdictFor` returns `UNSCORED` —
> no content rules, no header rules, no Bayes — and `categorizeMessage` leaves the
> message in Primary.

Cleartext headers are readable on an encrypted message, and the engine could act
on them; earlier versions did, filing a DMARC-failing lookalike as spam whether or
not the body had been opened. That is no longer done. A verdict is a statement
about a message, and this app does not reach statements about mail it was trusted
to keep sealed — the cost of being wrong is a message the user needed, hidden by
the client that was supposed to be the one thing on their side. Encrypted mail
stays visible, in Primary, and the user decides.

Three things follow, and all of them are deliberate:

- **The ciphertext placeholder subject and the provider's snippet are never
  inspected as text.** They are ciphertext artefacts, not content. Neither is the
  *decrypted* text: opening a message to read it is not permission to file it.
- **The provider's junk verdict does not count either.** Gmail may well file an
  encrypted message as spam — unusual structure, an opaque body, no readable text —
  and that is a verdict about ciphertext. It is not obeyed: the row stays in
  Primary and the reader is told the provider disagreed (§14.4).
- **The user's own mark still counts.** A `spam` mark short-circuits to an
  override (§11.2), so "mark as spam" works on encrypted mail. A human filing a
  message is not the app classifying it — that distinction is the whole rule.

**Where headers are still fair game: plaintext mail.** The provider already has
them; they are how the message was routed. Reading them locally reveals nothing
new to anyone and is where the strongest phishing evidence lives. `spamInputFor`
keeps its encryption boundary unchanged because **training** still uses it — a
user who marks an opened encrypted message learns from its decrypted content and
nothing else.

### 13.5 Defensive parsing

`normalise` coerces every field at the boundary, and `classifyMessage` wraps the
whole rule pass:

```ts
} catch {
  // A rule threw on hostile input. The message is not evidence of anything, and
  // an inbox that renders is worth more than a verdict — so: no symbols, no
  // classification, and the mail stays visible.
  return { classification: 'legitimate', score: 0, phishingScore: 0, symbols: [],
           bayesApplied: false, bayesProbability: null, overridden: false };
}
```

**Failing open, not closed.** A bug in a rule must not hide the user's mail, and it
must not blank the inbox. Every bound in the engine exists for the same reason:
`MAX_SCAN_CHARS = 20_000`, `MAX_BODY_CHARS = 20_000`, subject 1000,
`MAX_HTML_CHARS = 400_000`, `MAX_LINKS = 200`, an anchor body matched non-greedily to
2000 characters with the `href` sliced to 2000 and the anchor text to 300,
`MAX_VOTING_TOKENS = 20`,
`MAX_VOCABULARY = 12_000`, `MAX_MARKS = 2_000`, a capped `editDistance`, and no
regex in the engine with a nested quantifier that can backtrack.

## 14. Gmail integration

### 14.1 The additional metadata headers

[`app/src/mail/gmail.ts:60`](../app/src/mail/gmail.ts#L60) requests four more
headers than it did before the feature:

```
metadataHeaders=Reply-To
metadataHeaders=Authentication-Results
metadataHeaders=List-Unsubscribe
metadataHeaders=Return-Path
```

(`Message-ID` was already requested, for threading.)

**Why these four.** They are where client-side phishing evidence actually lives:
whether the message authenticated, whether a reply would leave the sender's domain,
and whether it carries unsubscribe hygiene. None of it is in the body.

**They are free.** The list call is already `format=metadata`, which returns
headers only, so asking for more of them adds **no body bytes and no extra round
trip**. No new scope is needed — the existing `gmail.readonly`/`gmail.modify`
scopes cover it.

### 14.2 Mapping into `MailSummary`

[`app/src/mail/gmail.ts:132-135`](../app/src/mail/gmail.ts#L132-L135):

```ts
replyTo: header('Reply-To') || undefined,
authenticationResults: header('Authentication-Results') || undefined,
listUnsubscribe: header('List-Unsubscribe') || undefined,
returnPath: header('Return-Path') || undefined,
```

`header()` returns `''` for a header the message did not carry, and `|| undefined`
turns that into absence rather than an empty string — which matters, because
`AUTH_RESULTS_MALFORMED` fires on a *present but unreadable* header and must not
fire on a missing one.

All four fields are **optional** on `MailSummary`
([`app/src/mail/types.ts:48-51`](../app/src/mail/types.ts#L48-L51)) and stay
optional. The type's own comment states the rule: *"absence is never treated as
failure — a message with no `Authentication-Results` is the ordinary case, not a
suspicious one. A connector that supplies none of them yields exactly the behaviour
that existed before these fields did."*

`demoMail.ts`'s `toStored` carries the same four the same way, from
`parseRfc822` headers, so the demo and live paths present identical shapes.

### 14.3 Verification limitation

> **Live Gmail was not exercised.** The automated environment has no `app/.env`, no
> OAuth Web client id and no native crypto core, so the app runs in demo mode and
> **no real `Authentication-Results` header from Google has ever been passed through
> this code.** The header parser is tested against 63 cases in `headers-test.ts`,
> including real-world header shapes with comments, multiple `authserv-id`
> sections and property parameters — but that is a test corpus, not a live mailbox.
>
> This is a verification limitation, not a known defect. See §21 and §22.

### 14.4 The provider's own junk folder

This is the one part of the feature that was **broken in the running app**, and the
symptom was the feature appearing not to exist: an account with two messages in
Gmail's Spam folder showed an empty Spam destination in CryptMail.

**Why.** Three facts compounding.

1. Gmail does not leave a message it filters in the inbox — it removes `INBOX` and
   adds `SPAM`.
2. `messages.list` omits SPAM and TRASH from every result unless `includeSpamTrash`
   is set.
3. The Spam destination is a *filter over the list the inbox loaded*
   ([`ui/destination.tsx`](../app/src/ui/destination.tsx)), not a fetch of its own.

So the only mail that could ever appear under Spam was mail Gmail had **delivered**
and this device had then scored ≥ 5.0 — and on an account where the provider filter
works, that is close to nothing. The engine was never at fault; nothing was being
handed to it.

**What it does now.**

| Step | Where |
|---|---|
| A `spam` mailbox, asked for with `labelIds=SPAM` **and** `includeSpamTrash=true` | [`mail/gmail.ts`](../app/src/mail/gmail.ts) · `selector` |
| Fetched on every sync beside the inbox, merged into one newest-first list, its own paging cursor, ten rows per page rather than twenty | [`state/mailbox.ts`](../app/src/state/mailbox.ts) · `collectInbox` |
| A junk fetch that fails leaves the inbox intact and reports nothing | same |
| Plaintext mail carrying the label is filed under Spam — **above** the Bills and Purchases keywords | [`categorizer.ts`](../app/src/categorizer/categorizer.ts) · `providerFiledAsJunk` |
| Encrypted mail carrying the label stays visible in Primary | same |
| The reader is told when the provider's verdict is why they are looking at this | [`MessageScreen.tsx`](../app/src/screens/MessageScreen.tsx) · `SpamNotice` |
| No key is harvested from plaintext junk | [`state/mailbox.ts`](../app/src/state/mailbox.ts) · `harvestFrom` |

Spam is fetched into `messages` rather than becoming a screen of its own precisely
because junk is a *category* here: one list is what lets a message the provider
flagged sit beside one this device flagged, be counted by one badge, and be reversed
by the one **Not spam** button — which looks the message up in `messages` and would
silently do nothing on a row that lived somewhere else.

<!-- 14.4 continues -->

**Precedence, and why it is that way round.**

```
user's own mark        ─▶ wins outright, either direction        (§11.2)
this device's verdict  ─▶ spam / phishing-suspicious            (§5.1)
the provider's label   ─▶ Spam, on plaintext mail only          (here)
keywords               ─▶ Bills · Purchases · Promotions        (CATEGORIZER.md)
```

The provider sits **above the keywords** because its junk folder is full of mail
written to read like an order update — the two messages in the report that started
this were both "Refund on order 408-…" — and filing those under Purchases would put
a friendly bucket in front of the provider's warning.

It sits **below a user mark** because a filter that argued with an explicit
correction would be worse than no filter. Without that ordering, *Not spam* on a
provider-flagged message would appear to do nothing, and the row could never be
rescued. The button now offers *Not spam* whenever the message is filed under Spam
for any reason, rather than only when the user's own mark put it there.

**Encrypted mail is un-filed, not filed.** A `multipart/encrypted` message is
unusual structure with a placeholder subject and no readable text: mild spam signals,
every one of them an artefact of the encryption rather than anything about the
message. A junk verdict on that is a verdict about ciphertext, so it is not acted
on — the row stays in Primary, and the notice says the provider disagreed. This is
the sweep [`gmail-api-adoption.md`](gmail-api-adoption.md) §1.6 proposed: it un-files
what the *provider* categorised rather than categorising anything here, and it is
something this client can do that the provider's own app cannot. The failure it
avoids is the expensive one — a message the user needed, hidden by the client that
was meant to be the one thing on their side.

**Nothing is pushed back to the server.** A mark still files the row locally only
(§11.1). A message rescued from junk in CryptMail is still in Gmail's Spam folder,
and Gmail still deletes it after 30 days; pushing the correction back needs
`messages.modify` with `SPAM`, which is an open probe rather than a decision.

**Tests.** [`app/src/mail/__tests__/gmail-test.ts`](../app/src/mail/__tests__/gmail-test.ts)
pins the query per mailbox — including that no other list carries `includeSpamTrash`.
[`app/src/state/__tests__/junk-test.ts`](../app/src/state/__tests__/junk-test.ts)
pins the sync, the two cursors, the failure tolerance and the harvest guard. The
filing rules and their precedence are in
[`categorizer-test.ts`](../app/src/categorizer/__tests__/categorizer-test.ts).

## 15. Demo mode fixtures

[`app/src/mail/demoMail.ts`](../app/src/mail/demoMail.ts). Every URL in the
fixtures is on a `.example` or `.invalid` domain — RFC 2606 / RFC 6761 reserved and
permanently unresolvable — so even a mistaken fetch could reach nothing. Nothing is
ever fetched in any case.

### 15.1 The three filter fixtures

These exist for the spam engine rather than for the crypto, and they are served in
**both** demo shapes (with and without demo ciphertext).

**`demo-phish` — a phishing attempt.**

| | |
|---|---|
| From | `PayPal Service <security@paypa1-verify.example>` |
| Subject | `Urgent: your account will be suspended within 24 hours` |
| Headers | `Reply-To: paypal.support.recovery@gmail.com`, `Return-Path: <bounce@mailer-9931.example>`, `spf=fail dkim=none dmarc=fail` |
| Body | account-suspension pretext, `http://198.51.100.24/paypal/login/verify?session=8f21` |
| **Purpose** | no single signal decides it — a lookalike domain, a brand claim, a freemail reply target, a failing DMARC and an IP-address credential link *together* are the shape |

**Measured:** `classification: 'phishing-suspicious'`, `score` **20.6**,
`phishingScore` **19.5**, category **spam**.

Symbols: `CONTENT_THREAT_CREDENTIAL` 3.6 · `AUTH_DMARC_FAIL` 3.5 ·
`BRAND_NAME_WRONG_DOMAIN` 2.8 · `FROM_LOOKALIKE_DOMAIN` **2.6** ·
`REPLY_TO_FREEMAIL_MISMATCH` 2.6 · `URL_IP_ADDRESS` 2.6 · `URL_CREDENTIAL_PATH` 1.8 ·
`BODY_GENERIC_SALUTATION` 0.6 · `RETURN_PATH_MISMATCH` 0.5.

Note `FROM_LOOKALIKE_DOMAIN` fires at **2.6**, the `embedded` weight — `paypa1-verify`
is the brand hyphenated into someone else's registrable label, not a full
`confusable` match, so it is not the 4.0 tier.

**`demo-bulk` — unwanted, but not a lie.**

| | |
|---|---|
| From | `Rewards Team <winners@prize-drop.example>` |
| Subject | `🎉🎁🏆 CONGRATULATIONS YOU HAVE WON A FREE IPHONE!!!` |
| Headers | `List-Unsubscribe: <mailto:stop@prize-drop.example>`, `spf=pass dkim=pass` |
| Body | prize wording plus a `$25` processing fee, `http://bit.ly/3xqZp1a` |
| **Purpose** | it authenticates and carries unsubscribe hygiene, so the engine must reach *spam* on content alone — **and must not call it phishing**, because nothing in it claims to be anyone |

**Measured:** `classification: 'spam'`, `score` **6.6**, `phishingScore` **−0.8**,
category **spam**.

Symbols: `CONTENT_PRIZE_MONEY` 3.2 · `CONTENT_PRIZE_HEAVY` 1.4 ·
`SUBJECT_ALL_CAPS` 1.2 · `SUBJECT_PUNCTUATION_RUN` 1.0 · `AUTH_SPF_DKIM_PASS` −0.8 ·
`HAS_LIST_UNSUBSCRIBE` −0.7 · `SUBJECT_MANY_EMOJI` 0.7 · `BODY_GENERIC_SALUTATION` 0.6.

The **negative** phishing score is the real spam-vs-phishing distinction working:
not one phishing-kind symbol fired, and the authentication credit pushed the
identity score below zero. Also note `Rewards Team` produces **no** brand symbol —
that is the `brandsNamedIn` fix (§9.6) holding; before it, this fixture was charged
2.8 phishing points for `steam`.

**`demo-legit-security` — the hardest case in the mailbox.**

| | |
|---|---|
| From | `Northgate Bank <no-reply@northgate-bank.example>` |
| Subject | `Your password was changed` |
| Headers | `spf=pass dkim=pass dmarc=pass`, `Return-Path: <no-reply@northgate-bank.example>` |
| Body | says *password*, *verify*, *sign in* and *account*; links to `https://www.northgate-bank.example/security/activity` |
| **Purpose** | this is the shape of mail a keyword filter ruins. **If it ever appears under Spam, the engine has regressed to keyword matching** — the failure mode that matters most |

**Measured:** `classification: 'legitimate'`, `score` **−2**, `phishingScore`
**−2**, category **primary**.

Symbols: `AUTH_DMARC_PASS` −1.2 · `AUTH_SPF_DKIM_PASS` −0.8. **Nothing positive
fired at all** — one content family is not a combination, the link is on the
sender's own domain, and the DMARC-pass gate (§6.5) keeps `RETURN_PATH_MISMATCH`
silent.

### 15.2 The other fixtures

| ID | Encrypted | Category | Classification | Score / phishing | Symbols |
|---|---|---|---|---|---|
| `demo-3` — plaintext newsletter | no | primary | **legitimate** | 0 / 0 | *(none)* |
| `demo-1` — Anya, Q3 board deck | yes | primary | **legitimate** | 0.4 / 0 | `MESSAGE_ID_MISMATCH` 0.4 |
| `demo-2` — Jordan, `Re: contract redlines` | yes | primary | **legitimate** | 0.4 / 0 | `MESSAGE_ID_MISMATCH` 0.4 |
| `demo-2a` — Jordan, `contract redlines` | yes | primary | **legitimate** | 0.4 / 0 | `MESSAGE_ID_MISMATCH` 0.4 |
| `demo-note` — "Demo mail, real encryption" | no | primary | *(served only when the real core is loaded)* | | |

The three encrypted fixtures are the encryption boundary in practice: their
placeholder subject and ciphertext snippet are never scored, so all the engine has
is headers — a single 0.4 symbol, an eighth of the phishing threshold. They stay in
Primary as they must.

`demo-1`/`demo-2`/`demo-2a` are served **only when the demo core is loaded**
(`includeDemoCiphertext = core.kind === 'demo'`). With a real native core the
mailbox serves `demo-note` explaining why instead — a real core correctly refuses
to read demo-core ciphertext.

### 15.3 Expected UI behaviour

- `demo-phish` appears under **Spam** in the category drawer, and its message view
  shows a phishing-level warning naming the top reasons.
- `demo-bulk` appears under **Spam** with a spam-level (not phishing) presentation.
- `demo-legit-security`, `demo-3` and the encrypted fixtures appear under
  **Primary** with no spam UI at all.
- **Mark not spam** on `demo-phish` moves it to Primary immediately and trains one
  ham example; **Mark spam** on `demo-3` moves it to Spam and trains one spam
  example. Neither changes any *other* row's verdict until both classes reach five
  examples (§11.3).

> These verdicts were measured against the current implementation by running the
> real `categorizeMessage` / `verdictFor` path over the fixtures. The three filter
> fixtures' categories and classifications are additionally **pinned by assertions**
> in [`app/src/mail/__tests__/demoMail-test.ts`](../app/src/mail/__tests__/demoMail-test.ts),
> which computes the row exactly as `InboxScreen` and the drawer badges do. The UI
> behaviour in §15.3 follows from those verdicts but has **not** been verified by
> hand on a device — see §22.

## 16. How the feature was tested

Every command below was run from `app/`, and **every number in this section is the
output of running it, not a figure carried from an earlier report.**

### 16.1 The CI gate

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs exactly two
commands. Both pass.

```bash
cd app
npx tsc --noEmit          # exit 0 — no type errors
npm test -- --ci
```

```
Test Suites: 41 passed, 41 total
Tests:       751 passed, 751 total
Snapshots:   0 total
Ran all test suites.
```

(The `Time:` line is omitted deliberately — it is the one figure that changes on
every run. Observed range on this machine: roughly 11–30 s.)

**41 suites · 751 tests · 751 passed · 0 failed · 0 skipped.** A repository-wide
grep for `it.skip`, `test.skip`, `.only`, `.todo`, `xit(` and `xdescribe(` returns
nothing, so no test is disabled anywhere in the app.

There is **no lint step** in this repository — `tsc --noEmit` is the whole static
analysis, and `package.json` has no `lint` script. That is pre-existing and was not
changed.

### 16.2 Focused runs

| Scope | Command | Result |
|---|---|---|
| Engine + integration seam | `npx jest src/spam src/categorizer` | **8 suites · 344 passed** |
| …plus persistence + demo fixtures | `npx jest src/spam src/categorizer src/store/__tests__/spamModelStore-test.ts src/mail/__tests__/demoMail-test.ts` | **10 suites · 369 passed** |
| Mail layer | `npx jest src/mail` | **4 suites · 67 passed** |

### 16.3 Per-suite counts

| Suite | Tests |
|---|---:|
| [`src/spam/__tests__/headers-test.ts`](../app/src/spam/__tests__/headers-test.ts) | 63 |
| [`src/spam/__tests__/unicode-test.ts`](../app/src/spam/__tests__/unicode-test.ts) | 56 |
| [`src/spam/__tests__/content-test.ts`](../app/src/spam/__tests__/content-test.ts) | 53 |
| [`src/spam/__tests__/urls-test.ts`](../app/src/spam/__tests__/urls-test.ts) | 52 |
| [`src/spam/__tests__/spam-test.ts`](../app/src/spam/__tests__/spam-test.ts) | 38 |
| [`src/spam/__tests__/bayes-test.ts`](../app/src/spam/__tests__/bayes-test.ts) | 31 |
| [`src/spam/__tests__/tokenize-test.ts`](../app/src/spam/__tests__/tokenize-test.ts) | 20 |
| **`src/spam/` total** | **313** |
| [`src/store/__tests__/spamModelStore-test.ts`](../app/src/store/__tests__/spamModelStore-test.ts) | 17 |
| **Feature-owned total** | **330** |
| [`src/categorizer/__tests__/categorizer-test.ts`](../app/src/categorizer/__tests__/categorizer-test.ts) | 31 |
| [`src/mail/__tests__/demoMail-test.ts`](../app/src/mail/__tests__/demoMail-test.ts) | 8 |

330 is the figure quoted in [`docs/features.md`](features.md) line 51; the
`categorizer` and `demoMail` suites pre-date the feature and were extended by it
rather than created for it, which is why they sit outside that total.

### 16.4 How to reproduce any of it

```bash
cd app
npm install
npx tsc --noEmit
npm test -- --ci

npx jest src/spam                              # the engine only
npx jest src/spam/__tests__/bayes-test.ts      # one suite
npx jest -t "never fires on a brand"           # one case, by name
```

## 17. What the tests actually cover

### 17.1 Suite by suite

**[`headers-test.ts`](../app/src/spam/__tests__/headers-test.ts) — 63 tests.**
Ten blocks: `parseAuthResults` · **the "missing is not failing" rule** ·
authentication symbols · address consistency · impersonation · sender-domain shape ·
the user's own address · hygiene signals · defensive parsing · `domainOf`. The
second block is the one that matters most: it pins that a `null` method is not
`'none'`, that a message with no `Authentication-Results` at all produces no
authentication symbol in either direction, and that `NO_VISIBLE_RECIPIENT` fires
only when `to` was supplied *and* empty.

**[`unicode-test.ts`](../app/src/spam/__tests__/unicode-test.ts) — 56 tests.**
Eleven blocks covering invisible characters, mixed-script words, `skeleton`,
`domainSkeleton`, `hasPunycodeLabel`, `registrableDomain`, `sameRegistrableDomain`,
`editDistance`, `lookalikeBrand`, `brandsNamedIn`, `brandOwnsHost`. The file's own
header states the priority: the *must-nots* matter more than the musts. It asserts
that `skeleton` does **not** fold ASCII lookalikes (which would make `l1` and `ll`
the same word in prose), that `mail.google.com` and `google.com` are the same
sender, that `lookalikeBrand` returns `null` for seven of the brands' own domains,
and — from the bug-6 fix — that ten ordinary English phrases name no brand while
`PayPalSupport`, `microsoft365 billing`, `UPS Tracking`, `IRS Refund Dept` and
`DHL Express` still do.

**[`content-test.ts`](../app/src/spam/__tests__/content-test.ts) — 53 tests.**
Six blocks: **one intent family alone scores nothing** · combinations · form rather
than vocabulary · unicode disguises · bounds and defensive handling · attachment
metadata. The first block is the false-positive guard: a message that says
*password*, or *verify*, or *account*, or *payment*, and nothing else, produces no
content symbol at all.

**[`urls-test.ts`](../app/src/spam/__tests__/urls-test.ts) — 52 tests.**
Nine blocks, opening with **`describe('no network access, ever')`** — spies on the
network entry points and asserts they are never called while every URL rule runs.
Then `isIpHost`, `isObfuscatedHost`, where a link points, anchor-versus-href,
aggregates, defensive input handling, `extractLinks`, `hasDeceptiveLink`.

**[`spam-test.ts`](../app/src/spam/__tests__/spam-test.ts) — 38 tests.**
The end-to-end verdicts: legitimate mail *including the mail that talks like
phishing* · spam · **phishing, which is a different answer** · the user's decision
outranks the engine · learning from corrections · **never throws, whatever
arrives** · reasons shown to the reader.

**[`bayes-test.ts`](../app/src/spam/__tests__/bayes-test.ts) — 31 tests.**
Eight blocks: the empty model · training · untraining · **the minimum-training
guard** · classification · `bayesWeight` · `isSpamModel` · `trainedCount`. Covers
`applies: false` below five in either class, `probability: 0.5` when nothing is
recognised, the dead zone returning exactly `0`, the `confidenceCap`/`verdictCap`
ceilings, `untrain` floored at zero, and `isSpamModel` rejecting every malformed
shape.

**[`tokenize-test.ts`](../app/src/spam/__tests__/tokenize-test.ts) — 20 tests.**
`words` · `tokenize` · `countTokens`. Namespacing, stop-word removal, length
bounds, host-only link tokens, header **facts** only, and the body cap.

**[`spamModelStore-test.ts`](../app/src/store/__tests__/spamModelStore-test.ts) — 17 tests.**
`normaliseSpamState` · `emptySpamState` · `setMark`. Corrupt state, wrong version,
non-object input, junk mark values, and `setMark`'s delete-then-reinsert so a
re-marked id moves to the end of the trim order.

**[`categorizer-test.ts`](../app/src/categorizer/__tests__/categorizer-test.ts) — 31 tests.**
`categorize` · `checkIsSpam` · `categorizeMessage` · **`spamInputFor`** ·
`unreadCountsByCategory`. The `spamInputFor` block is the encryption-boundary test:
an encrypted message not in the index yields `subject: undefined, body: undefined`.

**[`demoMail-test.ts`](../app/src/mail/__tests__/demoMail-test.ts) — 8 tests.**
Core-gating for the encrypted fixtures, plus four assertions added by this feature
that pin `demo-phish` → `phishing-suspicious`, `demo-bulk` → `spam` (and *not*
phishing), `demo-legit-security` → `primary`/`legitimate`, and `demo-3` →
`primary` — computed through the real `categorizeMessage`/`verdictFor` path, exactly
as `InboxScreen` and the drawer badges compute it.

### 17.2 The enumerated edge cases, and where each is covered

| Edge case | Covered in |
|---|---|
| Malformed / hostile input, never throws | `spam-test.ts` "never throws, whatever arrives"; `headers-test.ts` "defensive parsing"; `urls-test.ts` "defensive input handling"; `content-test.ts` "bounds and defensive handling" |
| Missing headers entirely | `headers-test.ts` "the 'missing is not failing' rule" |
| Authentication **failures** (SPF/DKIM/DMARC fail, softfail) | `headers-test.ts` "authentication symbols" |
| Authentication **passes** crediting the message | same block, plus `spam-test.ts` legitimate cases |
| Empty / malformed `Authentication-Results` | `headers-test.ts` `parseAuthResults` + "defensive parsing" |
| From vs Reply-To vs Return-Path vs Message-ID | `headers-test.ts` "address consistency" |
| URL attacks — IP hosts, shorteners, anchor mismatch, lookalikes, punycode | `urls-test.ts` "where a link points" + "what a link claims versus where it goes" |
| **Userinfo** URLs (`https://paypal.com@evil.example`) | `urls-test.ts` "where a link points" |
| Missing href / missing anchor text / unusual schemes | `urls-test.ts` "defensive input handling" + `extractLinks` |
| Unicode attacks — homoglyphs, zero-width, mixed scripts, IDN | `unicode-test.ts` blocks 1–5; `content-test.ts` "unicode disguises" |
| Bayes minimum training not met | `bayes-test.ts` "the minimum-training guard" |
| Bayes overconfidence ceilings and the dead zone | `bayes-test.ts` "classification" + `bayesWeight` |
| Persistence round-trip | `spamModelStore-test.ts` |
| **Corrupt** stored model | `spamModelStore-test.ts` `normaliseSpamState` |
| **Wrong model version** | `spamModelStore-test.ts` (via `isSpamModel`) and `bayes-test.ts` `isSpamModel` |
| Duplicate training / double-tap | `spam-test.ts` "learning from corrections"; the `previous === mark` guard in `applyMark` |
| User corrections outranking the engine | `spam-test.ts` "the user's decision outranks the engine" |
| Encrypted messages | `categorizer-test.ts` `spamInputFor`; `demoMail-test.ts` |
| **No network, ever** | `urls-test.ts` `describe('no network access, ever')` |

## 18. Bugs found and fixed during final verification

Seven defects were found *after* the implementation phase, by adversarial review of
the scoring arithmetic rather than by a failing test. **Five of the seven are the
same defect class**: the same fact charged more than once, so a score crossed a
threshold without any new evidence behind it. Every one of them made the engine
*more* aggressive, and every one landed on legitimate mail first.

All seven are fixed, all seven have regression tests, and every figure below was
measured.

### 18.1 Authentication failure charged three times

**What was wrong.** `AUTH_DMARC_FAIL` (3.5), `AUTH_SPF_FAIL` (1.6) and
`AUTH_DKIM_FAIL` (1.4) could all fire on one message: **6.5** phishing points
against a 4.0 threshold.

**Why it was wrong.** DMARC *is* the alignment check over SPF and DKIM.
`dmarc=fail` already reports that neither mechanism aligned — the other two symbols
restate it. Broken authentication became a phishing verdict all by itself, which is
exactly what the weights are chosen to prevent.

**Incorrect behaviour observed.** An ordinary mailing-list message came out
`phishing-suspicious`. Discussion lists break all three as a matter of routine: the
list's servers break SPF, its footer breaks DKIM, and DMARC therefore fails.

**Fix.** [`headers.ts:205`](../app/src/spam/headers.ts#L205) — a `dmarcSpoke` gate.
SPF and DKIM are scored **only when DMARC stated no verdict** (absent, `none`, or
unreadable), where they are the best evidence available.

**Result.** The mailing-list message is now `legitimate` at **3.3**. A
`spf=fail; dkim=fail; dmarc=fail` message yields exactly `['AUTH_DMARC_FAIL']`.

**Regression test.** `headers-test.ts` — *"charges a DMARC failure once, not three
times over SPF and DKIM as well"*, which also asserts the whole authentication story
sums below `PHISHING_THRESHOLD`.

### 18.2 Forwarded mail charged for an SPF failure DMARC had excused

**What was wrong.** With `spf=fail; dkim=pass; dmarc=pass`, `AUTH_SPF_FAIL` still
added 1.6 phishing points.

**Why it was wrong.** That combination *is* forwarded mail. A forwarder relays from
its own servers, so SPF fails for the original domain while the signature survives
and DMARC aligns through DKIM. Charging it penalises every forwarded message.

**Fix.** The same `dmarcSpoke` gate — `dmarc === 'pass'` is a verdict, so the
underlying mechanisms are not scored.

**Result.** `spf=fail; dkim=pass; dmarc=pass` now yields exactly
`['AUTH_DMARC_PASS']`, and every symbol present has a negative weight.

**Regression test.** `headers-test.ts` — *"says nothing about a broken SPF once DMARC
has passed — that is forwarded mail"*, plus `spam-test.ts` — *"passes forwarded mail,
where SPF fails while DMARC aligns through DKIM"*. A third test pins the *other*
direction so the fix cannot become a blanket suppression: *"still scores SPF and DKIM
when the domain publishes no DMARC policy"*.

### 18.3 Content combinations grew quadratically

**What was wrong.** Every matching pairing in `COMBINATIONS` pushed its own symbol.
The pairings are drawn from the same family hits, so three families produce three
pairings and four produce six — the score grew **quadratically in the evidence**
rather than linearly. Urgency + threat + credential charged
**3.6 + 3.4 + 2.0 = 9.0**.

**Why it was wrong.** "Your access is at risk, act now, confirm your details" is
*one* observation, not three. 9.0 clears the phishing bar on wording alone — the
single thing this module exists not to do.

**Incorrect behaviour observed.** A corporate password-expiry notice and a bank's
own fraud alert were both classified `phishing-suspicious` on content alone, with
nothing from the headers or links involved.

**Fix.** [`content.ts:261-268`](../app/src/spam/content.ts#L261-L268) — only the
**heaviest** matching pairing scores. Breadth is reported separately by
`CONTENT_MANY_PRETEXTS`, and in the same pass that symbol's threshold was raised
from three families to **four**, because the heaviest pairing already accounts for
two families on its own; charging three would charge the same wording twice
(3.6 + 1.6 reaches the spam threshold on wording alone).

**Result.** Both messages are now `legitimate` at **3.6**.

**Regression tests.** `content-test.ts` — *"charges one combination — the heaviest —
however many pairings match"* (asserts exactly one combination symbol, and that it
is `CONTENT_THREAT_CREDENTIAL`), *"keeps a genuine security notice below the spam
threshold on wording alone"*, and *"does not charge breadth for three families, which
the pairing already covers"*.

### 18.4 A passing DMARC did not count against the phishing score

**What was wrong.** `AUTH_DMARC_PASS` was `kind: 'ham'`, so it reduced the spam
score but **not** `phishingScore` — which sums only `kind === 'phishing'` symbols.

**Why it was wrong.** A passing DMARC is a cryptographic statement that the visible
`From` domain really sent the message. That is the one signal that positively rules
out impersonation, and it was not being allowed to.

**Incorrect behaviour observed.** A bank's own fraud alert — written, of necessity,
in the language of the attack it warns about — could reach the phishing threshold
despite authenticating perfectly.

**Fix.** A new `counterPhishing?: true` flag on `SpamSymbol`, set on
`AUTH_DMARC_PASS` and `AUTH_SPF_DKIM_PASS`, plus the reducer term in
[`spam.ts:202`](../app/src/spam/spam.ts#L202):

```ts
total + (symbol.kind === 'phishing' || (symbol.kind === 'ham' && symbol.counterPhishing) ? symbol.weight : 0),
```

**Deliberately narrow.** `HAS_LIST_UNSUBSCRIBE` does *not* get the flag: a phisher
sets that header for free, so it says nothing about identity.

**Result.** `demo-legit-security` now scores `phishingScore` **−2**.

**Regression tests.** `headers-test.ts` — *"counts the authentication credits against
the phishing score, not only the total"* and *"does not lend the unsubscribe credit
to the phishing score"*.

### 18.5 `Return-Path` and `Message-ID` charged on authenticated mail

**What was wrong.** `RETURN_PATH_MISMATCH` (0.5) and `MESSAGE_ID_MISMATCH` (0.4)
fired on ESP-routed mail that had already passed DMARC — a standing **0.9** on the
largest single class of legitimate mail there is.

**Why it was wrong.** Both are weak *proxies* for "did this domain really send the
message". When DMARC has answered that question directly, the proxies add nothing.
Every message sent through an email service provider bounces to the ESP and stamps
its `Message-ID` there while aligning through DKIM.

**Fix.** [`headers.ts:269`](../app/src/spam/headers.ts#L269) — a single
`if (auth.dmarc !== 'pass')` gate wrapping **both** checks.

> **Difference from the earlier verification report.** That report described this fix
> as *"`MESSAGE_ID_MISMATCH` suppressed when `RETURN_PATH_MISMATCH` has fired for the
> same host"*. **The code does not do that** — it implements the single DMARC gate
> above, which is broader and simpler. The code is authoritative; this document
> describes the code. (Also noted in §6.5.)

**Result.** `demo-legit-security` (DMARC pass, `Return-Path` on its own domain) fires
neither symbol. The three encrypted demo fixtures — which carry no
`Authentication-Results` at all, so DMARC never passed — still fire
`MESSAGE_ID_MISMATCH` at 0.4, which is correct: nothing authenticated them.

**Regression tests.** `headers-test.ts` — *"flags a Return-Path and Message-ID on
other domains, but only just"*, *"does not flag a Return-Path or Message-ID on the
sender's own domain"*, and the DMARC-pass suppression case; plus `spam-test.ts` —
*"passes an authenticated notice sent through an ESP, which is most transactional
mail"*.

### 18.6 `brandsNamedIn` matched substrings, not words

**What was wrong.** The function folded a display name to `[a-z0-9]` and called
`includes()`. That reads brand names out of ordinary English — and each hit is worth
**2.8** phishing points, or **3.4** from a freemail address.

**Incorrect behaviour observed — eight measured false positives:**

| Display name | Brand falsely found | Where |
|---|---|---|
| `Rewards Team` | `steam` | across the word break — rewar**ds Team** |
| `First National Bank` | `irs` | f-**irs**-t |
| `Purchase Support` | `chase` | pur-**chase** |
| `Wise Owl Books` | `wise` | as a substring rather than a word — *still matches today, as a word; see below* |
| `Startups Weekly` | `ups` | start-**ups** |
| `Firstly Design` | `irs` | f-**irs**-tly |
| `Groups Digest` | `ups` | gro-**ups** |
| `Otherwise Studio` | `wise` | other-**wise** |

`Rewards Team` is `demo-bulk`'s own sender, so the demo mailbox was charging its
bulk-mail fixture 2.8 phishing points for a brand that is not mentioned anywhere in
it.

**A first fix was insufficient and was replaced within the same phase.** A probe over
more display names caught five more: `Chasewater Angling`, `Steamboat Springs News`,
`Appleton Dental`, `Stripes and Checks`, `Upstate Records`.

**Shipped fix.** `brandsNamedIn` now matches a brand only as an **exact run of
consecutive words**, or as **brand + digits**, or as **brand + a `BRAND_ROLE_WORDS`
entry** (37 role words — `support`, `security`, `service`, `billing`, `team`, …).
Those last two are the forms a phisher writes when a space would break the spoof.

**Result.** Twelve of the thirteen phrases now return `[]`, while the real
impersonations still match: `PayPalSupport` → `['paypal']`, `microsoft365 billing` →
`['microsoft']`, `AmazonSecurity` → `['amazon']`, `UPS Tracking` → `['ups']`,
`IRS Refund Dept` → `['irs']`, `DHL Express` → `['dhl']`.

The thirteenth, `Wise Owl Books`, still returns `['wise']` — **not** as a substring
now, but because `wise` genuinely is one of its words and `wise` genuinely is a brand
in the table. Separating those needs meaning rather than spelling; it is the accepted
limitation in §9.7.2, and it is bounded at one 2.8-point symbol, below both
thresholds on its own.

**Accepted, documented miss:** `SecurePayPal` → `[]`. A brand preceded by an
arbitrary word run together is not matched. Accepting that miss is the price of not
flagging `Purchase Support` — see §9.7.

**Regression tests.** Five tests added to `unicode-test.ts`'s `brandsNamedIn` block:
*"does not read a brand out of an ordinary phrase spanning a word break"*, *"does not
read a brand out of the inside of a longer word"* (ten phrases), *"still finds a
brand run together with a role word or a number"*, and *"still finds a short brand
written as its own word"*.

### 18.7 The demo bulk fixture was classified on four words

**What was wrong.** `demoMail.ts`'s `toStored` set `snippet` to the first non-blank
line of the body. For `demo-bulk`, that line is `Dear valued customer,`.

**Why it was wrong.** Gmail's own `snippet` is a **flattened ~200-character prefix**
of the message, and everything above `MailClient` treats `summary.snippet` as the
readable preview a plaintext row is displayed from, searched by, **and categorised
on**. The demo was therefore scoring plaintext mail on materially less text than the
live mailbox would.

**Incorrect behaviour observed.** `demo-bulk` — the fixture that exists to prove the
engine catches bulk mail — sat in **Primary**, scored `legitimate` **2 / −0.8** as a
row, while its full body scored `spam` **6.6**. The prize and payment wording is on
lines two and four, so the row was categorised as though the message said nothing at
all. Nothing asserted the fixture's placement, which is how it went unnoticed.

**Fix.** `snippetOf` in
[`demoMail.ts:340`](../app/src/mail/demoMail.ts#L340) — `body.replace(/\s+/g, ' ').trim().slice(0, 200)`,
the same shape Gmail returns.

**Result.** `demo-bulk` is `spam` **6.6 / −0.8** as a row, matching its full-body
score.

**Regression tests.** Four tests added to `demoMail-test.ts`, asserting the **row**
exactly as `InboxScreen` and the drawer badges compute it — through
`categorizeMessage` and `verdictFor`, not a hand-built input, because that is the
path the mistake was on: `demo-phish` → spam/phishing-suspicious, `demo-bulk` →
spam/**not** phishing, `demo-legit-security` → primary/legitimate, `demo-3` →
primary.

## 19. Regression protection

### 19.1 What was verified

| Claim | Evidence |
|---|---|
| All pre-existing tests pass | 41 suites / 751 tests / 751 passed (§16.1) |
| No test is skipped or disabled | repo-wide grep for `.skip`, `.only`, `.todo`, `xit(`, `xdescribe(` returns nothing |
| No assertion was weakened | see §19.2 — exactly one existing test was changed, and it gained a sibling rather than losing coverage |
| No dependency changed | `app/package.json` and `package-lock.json` untouched; the engine imports nothing new |
| No unrelated refactor | the modified-file list (§20.2) is 18 files — 14 source, 2 test, 2 docs — each with a stated reason |
| The send path is untouched | `state/send.ts`, `core/`, `keys/`, `auth/` are not modified by this feature; `send-test.ts` passes unchanged |
| Encryption behaviour is unchanged | no file under `core/` was modified; the engine only *reads* already-decrypted content via `spamInputFor` |
| Typecheck is clean | `npx tsc --noEmit` → exit 0 |

### 19.2 The one existing test that was changed, and why

`categorizer-test.ts` › `checkIsSpam` › *"a combination of pretexts does classify"*
was **asserting the quadratic scoring that was bug 18.3**. Three families reaching a
verdict on content alone was the defect, so the test had to change with the fix — it
was pinning the bug, not the behaviour.

**No assertion was weakened.** The classifying case now uses a **four**-family text,
and a **new sibling test pins the three-family content-only case as `false`**, with
the reasoning in a comment. The file went from **30 to 31 tests**.

> This is the only pre-existing assertion modified anywhere in the effort. Every
> other test change in the feature was an addition.

### 19.3 Rules from `CLAUDE.md` that constrain the feature

- **No plaintext downgrade** — the engine never touches the send path. It reads;
  it does not send, queue, hold or release anything.
- **The demo core is not crypto** — `kind: 'demo'` reporting and the UI banners are
  untouched. The demo fixtures are demo *mail*, not a claim about the crypto.
- **Nothing crosses the core boundary but strings** — the engine does not call the
  core at all. It reads `searchIndex`, which the state layer already populated.
- **Screens don't call providers or the core directly** — `MessageScreen`,
  `InboxScreen` and `CategoryDrawer` call `categorizeMessage`/`verdictFor`
  (pure functions) and `markSpam`/`markNotSpam` on `useApp()`. No screen imports
  the engine's state or the store.

## 20. Files created and modified

### 20.1 Created

| File | Purpose | Why required |
|---|---|---|
| `app/src/spam/types.ts` | Shared vocabulary and the two thresholds | The rule modules must agree on a symbol shape without importing each other |
| `app/src/spam/spam.ts` | The scorer, `classifyMessage`, `learn`/`unlearn`, `reasons`, `isUnwanted` | The public face of the engine |
| `app/src/spam/headers.ts` | Envelope and authentication rules | Where the strongest phishing evidence lives |
| `app/src/spam/content.ts` | Intent families, form signals, attachment metadata | What the message says and how |
| `app/src/spam/urls.ts` | URL shape rules, `extractLinks`, `hasDeceptiveLink` | Link deception, decided offline |
| `app/src/spam/bayes.ts` | The personal Naive Bayes model | Per-user adaptation the fixed rules cannot provide |
| `app/src/spam/tokenize.ts` | Namespaced tokenization | One tokenizer for scoring *and* training |
| `app/src/spam/unicode.ts` | Confusables, skeletons, registrable domains, brand table | Two strings that render identically are not the same string |
| `app/src/store/spamModelStore.ts` | Sealed persistence + `normaliseSpamState` | The model is user data and must survive a restart and a corrupt read |
| `app/src/spam/__tests__/{spam,headers,content,urls,bayes,tokenize,unicode}-test.ts` | 313 tests | Coverage |
| `app/src/store/__tests__/spamModelStore-test.ts` | 17 tests | Coverage |
| `docs/SPAM_PHISHING_DETECTION.md` | This document | The permanent reference |

### 20.2 Modified

| File | Purpose of the change | Why genuinely required |
|---|---|---|
| `app/src/categorizer/categorizer.ts` | `spamInputFor`, `verdictFor`, `linksFromText`, `SpamContext`; `categorizeMessage`/`unreadCountsByCategory` take the context; `checkIsSpam` backed by a real verdict; `'spam'` added to `Category` | Without it nothing turns a `MailSummary` into a `SpamInput`, and `checkIsSpam` was a stub returning `false` |
| `app/src/state/mailbox.ts` | `markSpam`/`markNotSpam` → `applyMark`; `linksIn`; anchor pairs in `openMessage` | Corrections are state transitions; the engine is pure and cannot own them |
| `app/src/state/types.ts` | `spam: SpamState` on the app state; the two action signatures | The model has to live somewhere the screens can read |
| `app/src/state/store.ts` | `spam: emptySpamState()` in the initial state | An empty model must exist before the first load |
| `app/src/state/session.ts` | `spam: await loadSpamState()` at boot | A learned model that does not survive a restart is not learning |
| `app/src/state/contracts.ts` + `AppState.tsx` | `markSpam`/`markNotSpam` on the mailbox contract and the `useApp()` object | Rule 5: screens go through `AppState` |
| `app/src/store/index.ts` | `SPAM_STORE_KEY` added to `SEALED_STORE_KEYS` | The model and marks are user data and must sit inside the seal, including on an install predating the feature |
| `app/src/mail/gmail.ts` | Four header names on the `format=metadata` request; four fields in `toSummary` | Live mode cannot analyse authentication it never asked for |
| `app/src/mail/types.ts` | Four optional `MailSummary` fields | The provider-agnostic contract had to carry them, optionally |
| `app/src/mail/demoMail.ts` | Three filter fixtures, `withHeaders`, `snippetOf`, the four header fields in `toStored` | The feature is unreachable in demo mode without mail to filter, and the row shape had to match Gmail's |
| `app/src/screens/MessageScreen.tsx` | `verdict` memo, `SpamNotice`, the Mark as spam / Not spam toggle | The verdict has to be visible and correctable |
| `app/src/screens/InboxScreen.tsx` | `spamContext` memo, passed to `categorizeMessage` | Rows must be filed using the same model and marks the message view uses |
| `app/src/screens/CategoryDrawer.tsx` | `unreadCountsByCategory` with the context | Badge counts must agree with the filed rows |
| `app/src/categorizer/__tests__/categorizer-test.ts` | `spamInputFor` block; the bug-18.3 test corrected and a sibling added (30 → 31) | See §19.2 |
| `app/src/mail/__tests__/demoMail-test.ts` | Four fixture-placement assertions (4 → 8) | Bug 18.7 went unnoticed because nothing asserted the rows |
| `docs/features.md` | Feature row; test count `322` → `330` at line 51 | `docs/` is the source of truth |
| `app/src/categorizer/CATEGORIZER.md` | Documents the delegation to the spam engine | Same reason |

> **A true `git diff` audit was not possible.** The verification environment is
> **not a Git repository** — `git status` returns *"fatal: not a git repository"* — so
> this list was assembled by reading the files and their tests, not from version
> control. `find -newermt` was tried and is useless here: it returns essentially the
> whole tree. **Treat the table as carefully-assembled but not machine-verified**, and
> confirm it against `git diff --stat` in a real checkout.

## 21. Known limitations of the verification, not of the feature

These are things this environment **could not test**. None of them is a known
defect; each is a gap in the evidence.

| # | Limitation | Why |
|---|---|---|
| 1 | **No real Gmail OAuth** | no `app/.env`, no `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` |
| 2 | **No live mailbox** | follows from 1 — the app runs in demo mode |
| 3 | **No real `Authentication-Results` from Google** | follows from 1. The parser is tested against 63 cases including real-world header shapes, but never against Google's own output |
| 4 | **No native Rust crypto core** | M1/M2 do not exist yet, so `getNativeCore()` returns null and `demoCore` is loaded |
| 5 | **No physical Android device** | none attached |
| 6 | **No Android SDK / toolchain** | so no `npm run android`, no dev build |
| 7 | **No debug build** | follows from 6 |
| 8 | **No release build, no AAB** | follows from 6 |
| 9 | **No Play Internal Testing** | needs 8 plus Play Console access |
| 10 | **No manual UI testing on hardware** | follows from 5 |
| 11 | **No false-positive rate against real mail** | needs 2. Every false-positive claim in this document is against a **test corpus**, not a real mailbox |
| 12 | **No lint step exists** | the repository has no `lint` script; `tsc --noEmit` is the whole static analysis. Pre-existing, unchanged |
| 13 | **No `git diff` audit** | not a Git checkout (§20.2) |

Two further honest notes:

- **The attachment rules are implemented but not currently reachable** in the running
  app, because `spamInputFor` does not populate `attachments` (§13.3). They are
  covered by tests; they are not exercised end to end.
- **The Bayes model has never been trained by a real user.** Its behaviour below and
  above `MIN_TRAINED_MESSAGES` is asserted by tests with synthetic corpora. How well
  it performs on one person's actual mail is unknown and cannot be known here.

## 22. Manual testing status

**Nothing in this table has been tested by hand.** No item is claimed as passed.

| Scenario | Status | Note |
|---|---|---|
| Demo phishing message shows a phishing warning | ⬜ **Not manually tested** | verdict `phishing-suspicious` is asserted by `demoMail-test.ts`; the banner rendering is not |
| Demo spam message shows a spam (not phishing) presentation | ⬜ **Not manually tested** | verdict `spam` asserted; presentation not |
| Legitimate security email stays in Primary with no warning | ⬜ **Not manually tested** | verdict `legitimate`/`primary` asserted; absence of UI not |
| **Mark spam** files the message and trains | ⬜ **Not manually tested** | `applyMark` covered by `spam-test.ts`; the tap is not |
| **Mark not spam** un-files and untrains | ⬜ **Not manually tested** | same |
| Double-tap does not train twice | ⬜ **Not manually tested** | the `previous === mark` guard is covered by unit tests; the gesture is not |
| Model persists across an app reload | ⬜ **Not manually tested** | `saveSpamState`/`loadSpamState` round-trip is unit-tested; a real relaunch is not |
| Real Gmail account | ⬜ **Not tested** | limitation 1 |
| Real Android device | ⬜ **Not tested** | limitation 5 |
| Release build | ⬜ **Not tested** | limitation 8 |
| Play Internal Testing | ⬜ **Not tested** | limitation 9 |

**What *is* verified in this environment:** the typecheck, all 751 automated tests,
the demo fixture verdicts measured through the real `categorizeMessage`/`verdictFor`
path, and the absence of network calls asserted by a spy. That is a strong static and
unit-level result and **not** a claim that the feature has been used.

**Overall status: ready for manual testing.** Not "fully verified", not "production
ready", not "100% working".

## 23. Future testing checklist

Run these before merging any change that touches the engine.

**Always:**

```bash
cd app
npx tsc --noEmit                                  # must exit 0
npx jest src/spam src/categorizer                 # 8 suites, 344 tests
npm test -- --ci                                  # 41 suites, 751 tests
```

**When a weight, threshold or gate changes** — re-measure the demo fixtures, since
they are the only end-to-end verdicts that exist:

```bash
npx jest src/mail/__tests__/demoMail-test.ts
```

Ask specifically: **did anything move `demo-legit-security` out of Primary?** That
fixture is the false-positive canary; if it moves, the change is wrong until proven
otherwise.

**When adding a rule** — add both directions. A test that the rule fires, and a test
that it does *not* fire on the legitimate mail that most resembles it. Every one of
the seven bugs in §18 would have been caught by the second kind.

**When the mail layer changes** — `npx jest src/mail`, and re-check that
`toSummary` still maps the four optional headers with `|| undefined` (an empty string
would make `AUTH_RESULTS_MALFORMED` fire on a message that simply had no header).

**Adversarial / security review** — confirm the invariants have not eroded: no
`fetch` anywhere under `src/spam/`, `urls-test.ts`'s network spy still present and
still asserting, `spamInputFor` still the only path to a `SpamInput`, and no email
body reachable from `saveSpamState`.

**On real hardware, when available** — the eleven items in §22, in that order.

**With a real Gmail account, when available** — the header path end to end: confirm
Google's `Authentication-Results` parses, that a normal mailbox produces very few
spam verdicts, and that mailing lists and ESP-routed transactional mail land in
Primary. That last check is the live-mail version of bugs 18.1, 18.2 and 18.5.

Also confirm the junk fetch (§14.4), which is the half of the feature only a live
mailbox can prove: open Spam and check that what Gmail has in Spam is there, that
opening a row says why it is, that **Not spam** moves it to Primary and keeps it
there across a sync, and that the Inbox list and badge did not gain any of it.

## 24. Reading this document

It is written to be read in three ways, and none of them requires opening a source
file:

- **To understand what the feature does** — §2, then §11 and §15. Plain language, no
  code.
- **To maintain the engine** — §3 (what each file owns), §4 (the call order), §5 (the
  real formulas), then the rule-module section you need: §6 headers, §7 content,
  §8 URLs, §9 Unicode, §10 Bayes.
- **To review a change** — §18 (the seven mistakes already made and why), §19
  (what regression protection exists), §23 (what to run).

Every weight, threshold, count and constant in this document was read out of the
source or measured by running it. Where the code differs from the earlier
verification report, the code is documented and the difference is called out
explicitly (§6.5, §18.5). Where something is **not** implemented, or implemented but
**not reachable**, it says so (§13.3, §21).

There are no Mermaid diagrams here, because there are none anywhere in `docs/` — the
house style is ASCII call graphs, which is what §3 and §4 use.

## 25. Accuracy

This document was written against the repository, not from memory. Specifically:

- Every source file listed in §3.1 and §3.2 was read.
- Every weight and threshold in §5–§10 was read out of the module that defines it.
- Every test count in §16 and §17 is the output of the command shown, run for this
  document.
- Every demo verdict in §15 was measured through the real
  `categorizeMessage`/`verdictFor` path.
- Every bug in §18 was checked against the fix as it currently stands in the code.

Two figures deserve a note, because they were **wrong** in the earlier verification
report and are corrected here rather than copied:

1. `demo-phish`'s `FROM_LOOKALIKE_DOMAIN` fires at **2.6** (the `embedded` weight),
   not 4.0 — `paypa1-verify` is a brand hyphenated into someone else's registrable
   label, not a full confusable match.
2. Bug 18.5's fix is a single `if (auth.dmarc !== 'pass')` gate over both checks, not
   the cross-symbol suppression the report described.

## 26. Summary

| | |
|---|---|
| **Engine** | 8 files, 2,729 lines, pure TypeScript, no dependencies |
| **Persistence** | 1 file, 132 lines, sealed via the existing `secureJson` store |
| **Tests** | 330 feature-owned in 8 suites (2,932 lines), inside 751 passing repo-wide |
| **Thresholds** | `SPAM_THRESHOLD` 5.0 · `PHISHING_THRESHOLD` 4.0 |
| **Network calls** | zero, asserted by a spy |
| **Email bodies persisted** | none |
| **Bugs found and fixed after implementation** | 7, plus one found in real use: the provider's junk folder was never fetched, so the Spam destination was empty on a working mailbox (§14.4) |
| **Status** | engine verified by tests; §14.4 fixed after a real account reported an empty Spam view; the fetch itself is still unconfirmed against a live mailbox |
