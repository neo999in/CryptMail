# Design

How to build UI in CryptMail so that a new screen looks like it was always
there. This is the forward-looking reference: what to reach for, what never to
write, and the traps that have already cost us something.

Read it with:

| | |
|---|---|
| [CLAUDE.md](CLAUDE.md) § UI conventions | the short list of rules enforced in review |
| [app/src/theme.ts](app/src/theme.ts) | the tokens themselves, with the reasoning in comments |
| [app/src/ui/primitives.tsx](app/src/ui/primitives.tsx) | the components you compose screens out of |
| [docs/design/ui-rework.md](docs/design/ui-rework.md) | how the look got here — history, not a spec |
| `docs/design/system-design.html` | the **previous** look. Kept as history. Never port from it. |

---

## 1. The rules that do not bend

These are decisions, not preferences. Changing one is a design conversation,
not a refactor.

**The ground is true black and carries no light.** `color.ground` is
`#000000` because on an OLED panel that means the pixel is *off*. The aurora
glows and film grain that used to wash the background are gone for this reason
— see the long note in [app/src/ui/AppBackground.tsx](app/src/ui/AppBackground.tsx).
Do not reintroduce a background wash, a gradient, or a header photo. Surfaces
lift off the ground by being *lighter than it*, never by casting light onto it.

**The accent is runtime state, not a constant.** Read it with `useAccent()`
and apply it inline. A `StyleSheet.create` at module scope cannot call a hook,
so a baked-in accent silently stops following the user's choice. `defaultAccent`
exists for genuinely fixed cases (a default argument), not as a shortcut past
the hook.

**There is exactly one colour preference.** `auroraPalette` — an
`AURORA_PALETTES` id — sets the aurora band *and* the accent (`useAccent()`
returns that palette's `accent`). Six standalone accent swatches used to sit
beside the band picker; two colour controls on one screen read as one setting
that half the app ignored, because nothing explained why the band stayed cyan
when the accent went red. Do not add a second colour control back.

**Trust colour is not themeable.** `color.mint` (verified, protected) and
`color.coral` (blocked, key changed, destructive) are fixed at every palette.
What a signature proved is not a matter of taste, and a user must not be able
to recolour it into something it isn't. Every trust state also carries a text
or `accessibilityLabel` equivalent — **never colour alone**.

**Density scales padding and row height only — never font size.** Density is
about how much fits on screen, not how readable text is. Shrinking type to fit
more mail is how a mail app becomes unusable.

**The UI never offers a plaintext downgrade.** Queued is not sent; say
*queued*. See [CLAUDE.md](CLAUDE.md) § "Rules that are not style preferences" —
that one is a security rule that happens to have UI consequences.

---

## 2. Tokens: never write a literal

Every colour, radius, space, font and shadow comes from
[app/src/theme.ts](app/src/theme.ts). A hex code or a magic number in a screen
is a bug, because it cannot follow the accent, the density, or the next
palette change.

### Surfaces, darkest to lightest

| Token | What sits on it |
|---|---|
| `color.ground` `#000000` | the ground itself — the mail list, screen backgrounds |
| `color.ground2` `#0A0A0A` | a recessed inset: a code block, a ciphertext dump |
| `color.card` `#0D0D0D` | a **card floating on the ground** — mail row, settings group, active rail tile |
| `color.cardPress` `#141414` | that card, pressed |
| `color.surface` `#1F1F1F` | chrome that lifts off black — top bars, drawer panel, sheets |
| `color.surfaceRaised` `#2A2A2A` | a control resting on `surface` — the Filter pill, a field |
| `color.segment` `rgba(255,255,255,.07)` | a segmented control's track — translucent, so the aurora runs under it |
| `color.segmentActive` `rgba(255,255,255,.20)` | the thumb sliding inside that track, and a press wash |

The card does its work with `color.border` (a hairline), not with a fill —
`card` is only barely lighter than `ground`. That restraint is the whole look.
Reach for `borderStrong` only when a hairline genuinely disappears.

### Lines, ink, and state

- `color.line` / `color.lineSoft` — hairlines between rows, under bars.
- `color.ink` → `inkDim` → `inkFaint` — the text ramp. `color.body` for
  reading copy.
- `color.rowPress` — the neutral whole-row press wash. Neutral **on purpose**,
  so it reads at any accent.
- `tint(accent, 0.12)` — a soft accent wash for a selected surface that should
  read as a tinted card rather than a solid block.

### Shape and rhythm

- `radius.xl` (18) cards · `radius.lg` (14) sheets, tiles · `radius.sm` (9)
  buttons, fields · `radius.pill` badges.
- `space.xs|sm|md|lg|xl` = 4/8/12/18/24. `space.lg` is the standard screen
  gutter and the standard icon-to-label gap.
- `shadow.raised | floating | sheet` — and **only** these. They use
  `boxShadow`; React Native's `shadow*` props are deprecated as of 0.81 and
  warn on every render.

Anything marked `@deprecated` in `theme.ts` (the `brass` family, `panel`,
`panel2`, `chip`, `focus`, `press`, most of `glass`) exists so unconverted
screens keep compiling. Nothing new may reference them.

---

## 3. Type

**Address a weight by its font family, never `fontWeight`.** Custom faces do
not synthesize weights reliably, so each weight is its own registered family.

| Face | Job |
|---|---|
| Manrope (`font.sans*`) | the entire UI voice — rows, headers, buttons, settings, body |
| JetBrains Mono (`font.mono*`) | cryptographic truth only: fingerprints, safety numbers, raw addresses |
| Space Grotesk (`font.display*`) | the connect/setup brand screens, and nowhere else |

Compose from the roles in `type.*` rather than picking a size:
`display` (screen titles) · `heading` (card and section titles) ·
`row` / `rowSubject` / `rowSub` (the three lines of a mail row) · `date` ·
`tab` · `settingsRow` / `settingsValue` · `strong` (buttons) · `body` ·
`small` · `meta` (mono) · `section` · `eyebrow`.

A mail row is three lines of one family at three weights. That is what lets the
subject lead without a colour trick.

---

## 4. Primitives

Build screens out of [app/src/ui/primitives.tsx](app/src/ui/primitives.tsx)
rather than raw styled `View`s. If you find yourself restyling the same shape
twice, it belongs here instead.

| Primitive | Use for | Shape it draws |
|---|---|---|
| `Group` | a run of related rows | bordered card, hairlines **inside** it between rows |
| `GroupHeading` | the label above a `Group` | uppercase, drawn in the accent |
| `SettingsRow` | a settings destination | icon · label · optional value line · optional trailing |
| `PressableRow` | any list item | whole-surface press wash, no scale |
| `Segmented` | tabs — `Primary \| Encrypted`, `Theme \| Density` | a filled track with a **neutral** pill thumb that *slides* to the active tab; widths measured, never divided evenly |
| `PrimaryButton` | the one real action on a screen | solid **neutral** (`color.ink` on `color.ground` text) |
| `SecondaryButton` | everything else | outlined card; `tone="danger"` gives coral *text*, not a coral fill |
| `IconButton` | header and toolbar controls | square ghost tile, flush until pressed |
| `Field` + `Input` + `useFocus()` | text entry | border tracks the caret |
| `Radio` | an exclusive choice | ring fills with the accent when selected |
| `Sheet` | a modal bottom sheet | scrim + blur + grip. **The only place blur is used.** |
| `Badge` / `Banner` / `Callout` | encryption and trust state | `enc`→mint, `warn`→coral, `plain`→faint |
| `Avatar` | a sender or account | circle, tint derived deterministically from the address |
| `EmptyState` | "nothing here" / "nothing matched" | centred glyph, title, hint, optional action |
| `Skeleton` | loading | pulsing block — loading should have the shape of the result |

`Glass` and `Glow` still exist but are effectively retired: blur is for `Sheet`
alone. `frost()` stays because `expo-blur` does not blur on web, so the web
build needs a CSS `backdrop-filter` fallback.

---

## 5. The patterns

### A screen

Top bar on `color.surface` with an `IconButton` back and a `type.display`
title; content in a `ScrollView` below it. Pad by the safe-area insets —
`insets.top + 6` on the bar, `insets.bottom + space.xl` on the scroll content.

```tsx
<View style={s.screen}>
  <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
    <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
    <Text style={s.title}>Settings</Text>
  </View>
  <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
    …
  </ScrollView>
</View>
```

### A mail list

Every list of mail — the inbox, its category filters, Sent, Archive — is a
**destination body on the one home screen**, never a push
(`ui/destination.tsx`, `screens/HomeScreen.tsx`). Drafts and Scheduled are
destinations too; their rows are their own, their bar is the same one.

**The bar is mounted once, on the home screen, above whichever body is up.** Not
per body: a `MailTopBar` inside each body remounts on every destination change,
which restarts the aurora from a zero height and throws away the search text —
a visible blink on a gesture that is meant to read as a filter. The state the
bar owns (search text, the Primary/Encrypted lens, the filter) therefore lives
on the home screen and is passed down as `BodyProps`, and so do the compose
button and the filter sheet.

The pieces:

- `ui/mailBar.tsx` — the aurora top bar. It owns the measured height the band is
  sized from, the search field, the demo-crypto strip and the fade while a mail
  is open above it (`ui/chrome.tsx`). `mailTopInset()` is where an opened mail
  starts.
- `ui/mailList.tsx` — `MailListRow` (the card of `ui/mailRow.tsx` plus the entry
  animation and the origin measurement the expand transition needs),
  `groupByDay` + `SectionHeading`, `MailSkeletonList`, and `ComposeFab`.
- `ui/mailFilter.ts` — the "needs attention" filter and its predicate, shared
  because the control and the bodies that apply it are now different components.

The bar's controls strip is **always drawn, at one height** (`CONTROL_HEIGHT`
plus its padding). Drafts and Scheduled have no Primary/Encrypted lens to offer —
that is a property of received mail, and a draft has not been encrypted yet — so
they put a count there instead of leaving the strip out: a strip that disappears
takes the bar's height with it, and the list under it jumps on a gesture that is
meant to read as a filter. Search is offered on every destination; a draft is
text this device wrote, so `textMatchesQuery` reads it directly
(`search/search.ts`) rather than going through the decrypted-content index.

```tsx
// screens/HomeScreen.tsx — the bar, once
<View style={s.screen}>
  <MailTopBar title={…} leading={<DrawerAvatar />} search={{ value: query, onChange: setQuery }} … />
  {box ? <MailboxBody {...bodyProps} box={box} /> : <InboxBody {...bodyProps} />}
  <ComposeFab … />
</View>

// a body — the list, and nothing above it
<SectionList sections={groupByDay(rows, (r) => r.item.date)} … />
```

A destination that pushes a screen instead is the thing this exists to prevent.
Sent and Archive used to: half the drawer then had a back arrow, a slide and a
second title row, while the other half quietly re-filtered a list — two
gestures that are the same gesture, looking nothing alike.

### Grouped rows

`GroupHeading` + `Group`. The `Group` supplies the border, the radius, the
gutter and the dividers — pass it bare rows, not pre-styled ones.

```tsx
<GroupHeading>General</GroupHeading>
<Group>
  <SettingsRow icon="key" label="Keys and fingerprints" onPress={…} />
  <SettingsRow icon="signout" label="Sign out" onPress={…} tint={color.coral} />
</Group>
```

A row's `value` line is load-bearing, not decoration: "Dark / Arctic Glow /
Roomy" under *Display & Appearance* means the current state reads without
opening the screen.

### A menu row (the drawer)

The drawer is deliberately **not** carded — it is a flat list of plain rows, so
the panel reads as navigation rather than as content. Icon, label, optional
count; active state is the accent applied to the icon *and* the label, with no
background wash:

```tsx
<Pressable style={({ pressed }) => [s.item, pressed && { opacity: 0.6 }]}>
  <Icon name={icon} size={22} color={active ? accent : color.inkDim} />
  <Text style={[s.itemLabel, { color: active ? accent : color.ink },
                active && { fontFamily: font.sansSemibold }]}>{label}</Text>
  {count > 0 ? <Text style={[s.count, { color: tone }]}>{count}</Text> : null}
</Pressable>
```

The two selection languages, and when each applies:

- **Accent text + icon, no background** — a navigation destination (drawer row).
- **`tint(accent, 0.12–0.18)` wash** — a selected *surface* (the rail's active
  account tile).

### A dialog — never `Alert.alert`

`Alert.alert` is OS chrome: plain system grey, the platform's type, the
platform's accent. It answers to none of these tokens, so every "are you sure?"
broke the illusion the rest of the app builds. Use
[app/src/ui/dialog.tsx](app/src/ui/dialog.tsx), which takes the same shape:

```tsx
confirmDialog('Remove account?', 'This deletes its keyring and local mail.', [
  { label: 'Cancel' },
  { label: 'Remove', tone: 'destructive', onPress: () => void removeAccount(id) },
]);
```

`buttons` is never optional — unlike `Alert.alert`, which quietly supplies a
bare "OK". The safe action renders in the accent, `tone: 'destructive'` renders
coral. `DialogHost` is mounted once at the root; screens need no state of their
own.

---

## 6. Where the accent is allowed

The accent is for **selection and one primary action** — not for every control.
Legitimate uses: a selected drawer row, an unread count, a date stamp, a
`GroupHeading`, a selected `Radio`, an `Input` caret.

Not the accent: ordinary buttons (`PrimaryButton` is neutral by design),
top bars, row backgrounds, or anything expressing trust. If a screen looks
washed in accent, that is the bug — a hairline border is doing the work a fill
used to.

**`Segmented`'s thumb is neutral too** (`color.segmentActive`), and that is a
deliberate exception rather than an oversight: the inbox tabs sit directly above
a list of accented date stamps and unread counts, and an accent-filled thumb
makes the bar compete with the mail under it. Selection reads there from the
fill, the weight and the icon — it does not need the colour as well.

---

## 7. Motion, and the aurora's four gates

Keep motion short and consistent: `motion.fast` (120ms) and `motion.base`
(180ms). Anything longer reads as lag, not polish.

There are two classes of motion here, and they answer to different rules:

- **A discrete transition** the user asked for — the tab indicator sliding, a
  press scale. It runs once, so it needs only to honour `useReducedMotion()`,
  and honouring it means *arriving instantly*, not staying put: an indicator
  left behind is a lie about which tab is selected.
- **A continuous animation** nobody asked for — the aurora band. It keeps the
  display pipeline awake, so it answers to all four gates below.

[app/src/ui/aurora/](app/src/ui/aurora/) is the one animated decorative
surface, and it is allowed **only because of the terms it meets**. All of them
have to hold for any further use of it:

1. It is sized from a **measured** height and never `absoluteFill` — it lives
   inside a mail list's top bar (`ui/mailBar.tsx`) own bounds, so the ground
   under the list is untouched. That bar is one component worn by the inbox,
   Sent, Archive, Drafts and Scheduled alike; there is still exactly one band on
   screen, because exactly one of those screens is in front.
2. It is `pointerEvents="none"`.
3. It animates only when `useShouldAnimate()` says so: screen focused
   (`active`, from `useIsFocused()`), app in the foreground, reduced motion
   off, **and** battery saver off. Those last two are separate OS settings and
   neither implies the other.
4. Its palette's sky bottoms out at `#000000`, so the band still meets the
   ground cleanly. A palette added to `AURORA_PALETTES` must keep that.

```tsx
<View onLayout={(e) => setTopbarHeight(e.nativeEvent.layout.height)}>
  <Aurora active={useIsFocused()} height={topbarHeight} palette={auroraColors} />
</View>
```

An animated band keeps the display pipeline awake on a screen that would
otherwise be idle, and *that* — not the shader's arithmetic — is what it costs.
Anything that animates answers to the same four gates.

Note that the band paints **over** the bar's `color.surface` fill rather than
lighting it, so the inbox bar reads darker than the rest of the chrome. That is
intended.

### Opening a mail: it rises, and it goes back to its row

Not a push, and not the same move in both directions.
[app/src/ui/expand.tsx](app/src/ui/expand.tsx) owns both halves; it is discrete
motion, one run per open, gated on `useReducedMotion()` alone.

- **Opening slides up.** The card comes off the bottom edge at full size, over a
  list that stays lit in the gap above it until it is covered. A mail is a whole
  screen of text, and a screen of text that arrives by growing out of a row-high
  band spends most of the transition unreadable.
- **Closing collapses onto the row.** The frame shrinks back to the exact
  rectangle that was tapped, while a copy of that row fades back in over the
  message. The mail becomes the row again, so the list handed back is visibly
  the one that was left.

Both run in one clipping frame drawn over the still-visible inbox, and the
aurora bar the mail opened under does not move for either.

The parts that have to stay together:

- `Message` is a `transparentModal` with `animation: 'none'` and
  `gestureEnabled: false` ([App.tsx](app/App.tsx)) — the inbox has to stay
  visible underneath, and a half-swiped native card cannot be put back on the
  row.
- **The ghost is the row, not a likeness of it.**
  [ui/mailRow.tsx](app/src/ui/mailRow.tsx) is the single definition the list and
  the transition both draw, which is why it lives in `ui/` rather than in the
  inbox. The last frame of the collapse is pixel-identical to what the list is
  about to draw under it; a second definition drifts, and the drift reads as a
  cut. Anything added to a row — the unread dot included — belongs in that file,
  not in the list's wrapper.
- **Only the frame's box is animated.** Opening, it is full size the whole way
  and rides one `translateY`. Collapsing, the box itself shrinks and
  `overflow: hidden` does the work: the message inside stays absolutely
  positioned at fixed pixel dimensions on a `transform`, so Yoga measures that
  subtree once instead of at every width between the card and the row, and text
  is hidden rather than scaled, never squashed.
- The row hands its rectangle over at press time, via `useOriginRef()`. A list
  row is somewhere else every frame, and the only rectangle that matters is the
  one that was under the finger. No rectangle — every entry point that is not a
  tapped row — still slides up, and closes by sliding back down: there is
  nothing to collapse onto, and inventing a row would throw the card at one that
  is not there. Reduced motion draws the screen in place. Both of those paths
  must keep working.
- **The band is not in the transition at all.** The inbox passes a `topInset`
  and nothing the message draws paints inside it, at any point — so the aurora
  is never scaled, faded, clipped or re-mounted by the transition.
  That inset is the status bar plus most of the title row, not the bar's full
  height. The tabs and filter are faded out while a mail is open, and the band
  behind them is the black end of the palette's gradient — every sky bottoms out
  at `#000000` — so keeping their height would hold the mail down against dead
  space. Both edges of that range have been walked: the line is where it is on
  purpose, and `MAIL_LIFT` in the inbox is the one knob.
- **The band keeps running, too.** `Aurora` restarts its loop from zero on every
  re-activation, so it must not be allowed to stop. Gate 3 therefore reads "on
  screen", not "focused": [ui/chrome.tsx](app/src/ui/chrome.tsx) carries that
  one bit, and the *inbox* sets it at the tap, in the same commit as the
  navigate — a mount effect on the far side is one commit too late and costs two
  visible jumps. The other three gates are untouched.
- **The band keeps its contents out of the way — but only while the mail is
  open.** The bar's title, tabs, icons and filter fade out on the way in: they
  describe a list that is not what is being read. They come back the moment the
  mail *starts* closing, not when it unmounts at the end, because the collapse
  reveals the list from its first frame and a populated list under an empty bar
  reads as broken. That is why `Overlay` is three states and not a boolean —
  `'closing'` shows the contents again while the band is still held running.
  Faded, never unmounted: the bar's height is what the mail is inset by, and a
  bar that collapsed under it would open a strip of list along the top.
- **A spring opening, a timing close.** `withSpring` decelerates the way the
  finger that started it did; a spring run backwards reads as hesitation, so
  closing is `motion.base` with an ease-in. One `progress` value drives both,
  with a `phase` shared value saying which — the two are not each other's
  reverse. It is flipped at the start of the close, where both halves describe
  the same resting frame and the switch itself paints nothing. `beforeRemove`
  holds the pop until the frame is back on the row, then re-dispatches the
  action it captured.

---

## 8. Where UI code lives

```
screens/   compose the primitives; never call a provider, the core, or a store
ui/        presentation + UI-only state (appearance, inboxFilter, dialog, aurora)
state/     the seam to the five subsystems — reached only through useApp()
```

`ui/` is where view state that happens to be persisted belongs.
`ui/appearance.tsx` and `ui/inboxFilter.tsx` live there rather than in `state/`
because `AppState` is the seam to core, mail, auth, keys and store — appearance
is none of those, and widening that boundary is exactly what the architecture
depends on not happening.

A global imperative UI service (a themed dialog, a toast) is a module-level
singleton function plus one host mounted at the root — the shape `dialog.tsx`
uses. That keeps the call site a one-liner.

Logic modules get a sibling `__tests__/<name>-test.ts`; that is the jest
`testMatch`, so a test placed anywhere else silently never runs. Screens are
not unit-tested by convention — extract the logic instead, the way
`ui/inboxTabs.ts` and `ui/aurora/palette.ts` are extracted and tested.

---

## 9. Accessibility

Non-negotiable, and cheap:

- `accessibilityRole` on every interactive element (`button`, `tab`, `radio`,
  `switch`).
- `accessibilityState` for `selected` / `checked` / `disabled`.
- `accessibilityLabel` wherever the visual is an icon or a bare number — e.g.
  a drawer row reads `` `${label}, ${count} unread` ``.
- A disabled control says **why** (`accessibilityHint`, plus visible text —
  see the Light theme radio).
- **Never colour alone.** Every trust state carries text or a label.

---

## 10. Traps that have already cost us

**A press-scale `transform` must be applied unconditionally.** Swapping
`usePressScale().style` for `undefined` while a control is disabled or busy
removes the `transform` array while the native driver still holds the node, and
Fabric asserts on exactly that — a hard `AssertionError` on the main thread,
i.e. the app dies. It cost a crash on every send. `Pressable`'s own `disabled`
already stops the animation, so there is nothing to gain by removing it.

**A module-scope `StyleSheet.create` cannot read the accent.** Build the static
parts there and apply `useAccent()` inline at the call site.

**A UI provider mounted beside `AppState` is not sequenced by it.** If it reads
a store, it must `await initStorage()` itself — that call is memoised precisely
so every caller can. This is why `AppearanceProvider` could otherwise read
prefs before storage was initialised and silently fall back to defaults.

**`expo-blur` does not blur on web.** Use `frost()` for the fallback.

**Expo SDK 57 changed substantially.** Read
https://docs.expo.dev/versions/v57.0.0/ rather than relying on remembered API
shapes, and keep `react-native-worklets/plugin` **last** in
`babel.config.js`'s plugin array.

---

## Checklist before a UI PR

- [ ] No colour, radius, spacing or font literal — everything from `theme.ts`.
- [ ] Accent read from `useAccent()` and applied inline; nothing baked in.
- [ ] Trust colour still fixed; every trust state has a text equivalent.
- [ ] Weights addressed by font family, never `fontWeight`.
- [ ] Elevation via `shadow.*`, never the deprecated `shadow*` props.
- [ ] Built from primitives; any new repeated shape was promoted into one.
- [ ] No `Alert.alert` — `confirmDialog` instead.
- [ ] No background wash, gradient or header image on the ground.
- [ ] Anything animated passes all four gates.
- [ ] `accessibilityRole` / `State` / `Label` present.
- [ ] Density changes padding only.
- [ ] `npx tsc --noEmit` and `npm test -- --ci` green from `app/`.
- [ ] If behaviour changed, the doc in `docs/` changed in the same PR.
