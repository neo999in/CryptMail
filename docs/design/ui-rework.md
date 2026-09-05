# UI rework — plan

Branch: `feat/ui-rework`. Reference: the five Outlook-for-Android screenshots in
`Ui rework/` (inbox with and without a header image, the account-rail drawer,
Settings, Display & Appearance).

The goal is Outlook's **information design** — flat dark bars on black, a blue
accent, avatar-led rows grouped by date, a rail of accounts beside a folder
list, a real Settings tree — carried onto CryptMail's content. What is *not*
copied: the header photo (see "Deliberate divergences"), Copilot, Calendar, and
anything that implies a plaintext mailbox.

The security rules in [CLAUDE.md](../../CLAUDE.md) are untouched by this work.
No screen gains a way to send unencrypted, the demo-core banners stay on every
screen that shows crypto state, and screens keep going through `useApp()`.

## What changes, in order

Six steps, each one shippable and typechecking on its own.

### 1. Theme: flat surfaces, runtime accent

[app/src/theme.ts](../../app/src/theme.ts) today is a brass/glass palette ported
from [system-design.html](system-design.html). It becomes an Outlook-shaped one:

- **Surfaces.** `ground` stays `#000000`. Bars and the drawer become a flat
  `#1F1F1F`-class grey (`surface`), rows sit directly on the ground with a
  hairline between them, and `glass.*` shrinks to the one place blur still earns
  itself (the modal sheet scrim). New tokens: `surface`, `surfaceRaised`,
  `segment`, `segmentActive`, `rowPress`.
- **Accent.** `color.brass` stops being the accent. The accent becomes a
  *runtime* value, exposed as `useAccent()` from a new
  `app/src/ui/appearance.tsx`; components read the live one from the hook rather
  than baking a constant into a module-scope `StyleSheet`.
  It is not chosen on its own. This shipped first as six standalone swatches
  (blue, purple, pink, orange, red, green) beside a separate aurora-band picker,
  and the pair read as one setting that half the app ignored — nothing explained
  why the band stayed cyan when the accent went red. **One** preference now
  decides both: an `AURORA_PALETTES` id, whose `accent` is what `useAccent()`
  returns. `theme.ts` holds the palettes; the six standalone accents are gone.
  Anything that is semantically a state, not a brand (mint = verified, coral =
  blocked/warn), stays a fixed token and does **not** follow it — trust colour
  must not be user-configurable.
- **Type.** Manrope becomes the whole UI voice at Outlook's weights and sizes
  (sender 15/semibold, subject 15/semibold, snippet 14/regular, date 13). Space
  Grotesk drops out of rows and headers. JetBrains Mono is kept for exactly what
  the token comment already reserves it for: fingerprints, safety numbers,
  raw addresses in the key screens. New roles: `row`, `rowSub`, `date`,
  `settingsRow`, `settingsValue`.
- **Density.** `space` gains a scale factor so the Density tab is real:
  `compact | cosy | roomy` change row height and vertical padding only, never
  font size.

`docs/design/system-design.html` is a mockup of the *old* look. Rather than
rewrite it, it gets a header note saying the app has moved on and that this file
plus the screenshots are the reference — CLAUDE.md's "keep the names aligned"
line is updated to point here.

### 2. Appearance state and its store

New `app/src/store/prefsStore.ts` — global, not per-account (appearance is a
property of the device, like `accountsStore`), sealed through `secureJson` like
every other store, key `cryptmail.prefs.v1`. Shape:

```ts
type Prefs = { theme: 'light' | 'dark' | 'system'; density: Density; auroraPalette: string };
```

Loaded once at boot alongside the other stores and exposed through a small
provider, `app/src/ui/appearance.tsx`, wrapping the navigation container. It is
UI-only, so it stays out of `state/` — `AppState` is the seam to the *five
subsystems*, and appearance is none of them. Tests:
`app/src/store/__tests__/prefsStore-test.ts` (defaults, round-trip, an unknown
palette id falls back to borealis, and an `accent` written by an older build is
dropped rather than carried).

`theme` is stored and honoured for `dark`/`system`; **`light` ships as a stored
preference that currently resolves to dark**, with the picker showing it
disabled and saying why — a light palette is a separate piece of work and
half-converting the screens is worse than not offering it. If that is not
acceptable, cut the Light radio instead of shipping a lying one.

### 3. Inbox

[app/src/screens/InboxScreen.tsx](../../app/src/screens/InboxScreen.tsx) (903
lines) is the biggest change. Target, matching shot 2:

- **Top bar**: flat grey, avatar-button on the left (opens the drawer), title,
  search icon on the right. No account subtitle under the title, on this bar or
  in the drawer's panel head: which mailbox is active is the drawer rail's job,
  where the one in front is ringed in the accent even while the inbox is merged,
  and the bar's leading avatar wears that account's face. Spelling the address
  out in words as well put a line that appears and vanishes — moving the list
  under it — under a fact that changes about once a session.
- **Segmented control**: two tabs on the left, `Filter` pill on the right. This
  replaces the current `All / Encrypted / Attention` filter pills — those move
  *into* the Filter sheet, which is the reference's own pattern, so nothing is
  lost. Spam stays out of the tabs entirely, reachable from the drawer as its own
  destination.

  This shipped as `Focused | Other`, fed by the categorizer (Focused = primary
  + bills, Other = promotions + purchases) — a partition, as in the reference.
  It is now **`Primary | Encrypted`**: Primary is the whole non-junk list and
  Encrypted narrows it to mail that arrived protected, so the pair is a *lens*
  rather than a partition and a protected message appears under both. Encrypted
  left the Filter sheet in the same change, so it is offered in one place only.
  See [app/src/ui/inboxTabs.ts](../../app/src/ui/inboxTabs.ts).
- **Rows**: circular tinted avatar with an initial, sender on line one with the
  date right-aligned in the accent, subject semibold on line two, snippet dim on
  line three; encryption badge stays but shrinks to a small lock glyph beside
  the date, since it is per-row furniture and must not out-shout the subject.
- **Grouping**: date-bucket section headers ("Last week", "This month") — the
  existing `dayBucket` already does this and keeps its shape.
- **FAB**: filled accent circle with a compose glyph, bottom right; loses the
  brass glass.

`MailRow`, `FilterPill`, `SkeletonRow` and `AccountSheet` are rewritten in
place. `AccountSheet` mostly *dissolves*: account switching moves to the drawer
rail, and Drafts/Scheduled/Keys/Sign out move to Settings. What remains is the
Filter sheet.

### 4. Drawer

[app/src/screens/CategoryDrawer.tsx](../../app/src/screens/CategoryDrawer.tsx)
becomes the two-column drawer of shot 3:

- **Left rail (72pt)**: one circular avatar per connected account with the
  active one ringed in the accent, then a `+` to add another. Tapping switches
  the active account through the existing `services.accounts` action — the
  "exactly one account is active" rule is unchanged, and the rail is just a
  faster way to exercise it. The unified-inbox toggle becomes the "All Accounts"
  title row at the top of the panel.
- **Right panel**: Inbox (with the unread count badge in the accent), Sent,
  Archive, Trash, Drafts, Scheduled, Spam. Sent, Archive and Trash are real
  destinations — `screens/MailboxScreen.tsx`, fetched from the provider and paged
  on their own cursors. **None of these rows is a navigation**: every one of them
  sets a `Destination` (`ui/destination.tsx`) on the single screen behind the
  drawer (`screens/HomeScreen.tsx`), so choosing Sent is the same gesture as
  choosing Bills — literally the same aurora bar of `ui/mailBar.tsx`, mounted
  once by that screen and never remounted as the body under it swaps (a bar per
  body restarts the band and blinks), same account avatar
  opening the drawer, same ✕ back to all mail, and for the ones that show mail
  the same rows, day headings, search, Primary/Encrypted lens and
  open-into-the-message transition from `ui/mailList.tsx`. Drafts and Scheduled
  keep their own rows but wear that same bar at the same height, searchable like
  the rest. Where the rows come
  from — a provider fetch, a local store, a filter — is not something the top of
  the app changes shape over. Settings is the one drawer row that still pushes — Contacts joined the
  destinations, so the address book wears the same bar (its All/Verified/Unverified
  control in place of the mail lens) rather than arriving as its own screen. The reference also lists Snoozed; **it
  has no destination in CryptMail today**, so it is not drawn as a dead row —
  the panel lists what exists. The categories (Primary, Purchases, Bills,
  Promotions) stay below under a "Categories" heading, which is what this
  drawer is otherwise for. Snooze and trash remain 0.19 in
  [features.md](../features.md).
- A Settings row pinned to the bottom.

### 5. Settings and Display & Appearance (new screens)

`app/src/screens/SettingsScreen.tsx` — shot 5: a search field (matching both
label and value line), then **Quick Settings** (Display & Appearance with its
`Dark / Blue / Roomy` value subtitle, Drafts, Scheduled) and **General**
(Accounts, Keys and fingerprints, Key recovery, Sign out). Rows with no feature
behind them are not invented, so the reference's Signatures, Notifications,
Copilot, Calendar, Contacts, Language and Accessibility rows are all absent —
this screen lists only destinations that exist. It is where the old account
sheet's scattered entries landed.

`app/src/screens/AppearanceScreen.tsx` — shot 4: `Theme | Density` segment, a
live preview card built from the same row primitives so it cannot drift from the
real inbox, Light/Dark/System radios, the colour palettes, and no image
strip. Both screens are stack pushes; `navigation.ts` gains `Settings` and
`Appearance`.

### 6. Detail screens

Message, Conversation, Compose, Keys, Drafts, Scheduled get the new surfaces:
flat headers, accent buttons, row hairlines, and the sans type scale. This is
mostly token-swap plus removing `Glass`/`Glow` wrappers. Compose is the one with
real layout change, and its send-gating logic is not touched.

Compose has since gone further, to the shape every mail client the user already
has: it draws its own top bar (`headerShown: false` on the route) carrying the
account face, the From address under the title with a chevron when more than one
mailbox is connected, a paperclip, an overflow, and **the send arrow — the
screen's only send control**. The fields below it are hairline-separated rows on
the ground rather than bordered `Field` cards, and the rule under a row is what
carries its state: the accent while the caret is in it, `color.coral` when a
recipient on it blocks the send. What was the send bar is now a status bar: the
sentence saying what will happen to this message, plus the ways out of the
states that stop it (check their key, remove them, see the queue). The caret
opens in To, or in the message when the recipient is already known.

The overflow holds the two things that are neither writing the message nor
sending it: **schedule send**, offered only when the send could happen right now
(`scheduleSend` takes no mode and leaves through the encrypted path, so it is
not a way to time a plaintext message), and **discard**, which is the only way
to be rid of a draft from where it is written — closing keeps it, that being
what the autosave is for.

None of that moves a decision. The encrypted / not-encrypted choice still sits
above everything the message is written into, because `encryption.md` requires it
be made up front; the arrow's `accessibilityLabel` still spells out which send
it is, since an arrow cannot; and its tint is coral in plaintext mode and the
accent otherwise, so the one unencrypted action never wears the endorsed colour.

## Primitives

[app/src/ui/primitives.tsx](../../app/src/ui/primitives.tsx) gains `Segmented`,
`Rail`, `SettingsRow`, `Radio`, `Swatch`, and a `Sheet` that owns the modal
scaffolding both filter and account sheets currently duplicate. `Glass` and
`Glow` stay exported but are used only by the sheet; `frost()` stays for its web
fallback. `Icon` gains the glyphs the drawer and settings need (`archive` and
`clock` exist; add `junk`, `sent`, `settings`, `bell`, `palette`, `signature`,
`accessibility`, `globe`).

## Deliberate divergences from the reference

- **No header image.** The mountain photo in shot 1 lights every pixel behind
  the top bar; CLAUDE.md's AMOLED true-black rule is a considered decision and
  this rework does not undo it. The Images strip is omitted from Appearance.

  The inbox top bar is the one place light is drawn, and it is drawn rather
  than photographed: `ui/aurora` shades an aurora band inside the bar's own
  bounds, in `reacticx-aurora`'s own colour combination — cyan, violet and
  green ribbons over a near-black sky, chosen by `palette` id rather than
  from the accent, which makes it the one surface here that does not follow
  `useAccent()`. It paints over the bar's `color.surface` fill rather than
  lighting it, so the bar reads darker than the rest of the chrome. The rule
  it does not break is the one that mattered — the ground below the bar is
  still `#000000` with no wash over it, so the panel is off
  wherever there is mail. It is bounded, it stops when the screen is not
  focused, and it freezes under the OS reduced-motion setting. A full-screen
  glow would still be a regression; this is not one.
- **Trust colour is not themeable.** The colour palettes change the band and
  the brand accent only. Verified/blocked keep mint and coral at every one.
- **No folders that do not exist.** See step 4.
- **Crypto banners stay.** The demo-core warning and the encryption badges
  survive every restyle; they get quieter typography, never less presence.

## Verification

Per step, from `app/`: `npx tsc --noEmit` and `npm test -- --ci` (CI runs
exactly this). New logic modules get sibling `__tests__/<name>-test.ts` files —
`prefsStore`, and the inbox tab split as a pure function
(`app/src/ui/__tests__/inboxTabs-test.ts`) so the tab logic is testable
without a screen. Screens stay untested, per the existing convention. Visual
checks go through `npm run web`.

Docs updated in the same PR: this file, the CLAUDE.md "UI conventions" section
(new token names, `system-design.html` demoted to a historical mockup),
[features.md](../features.md) (appearance settings shipped; archive/snooze/trash
folders named as not-built).

## Risks

- **InboxScreen churn.** 903 lines, and it holds the search/filter/threading
  glue as well as presentation. The rework is presentational; the safe order is
  to lift `MailRow` and the filter logic out first, then restyle.
- **Accent as runtime state.** Every `color.brass` reference (~all screens)
  becomes a hook read. Components that use `StyleSheet.create` at module scope
  need the accent applied inline at the call site; mechanical, but wide.
- **Density factor** touching `space` risks reflowing screens not yet reworked;
  it lands in step 1 as an identity function and only starts scaling in step 5.


## Status

All six steps are in the working tree on `feat/ui-rework`, with
`npx tsc --noEmit` and `npm test -- --ci` (826 tests) green.

What the rework did **not** touch, deliberately: the send path and its gating,
`state/`, the core boundary, and every store but the new one. `prefsStore` is
global, so it is in `SEALED_STORE_KEYS` but **not** in `PER_ACCOUNT_STORE_KEYS`
— removing an account must not reset how the app looks.
