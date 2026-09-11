# Swipe actions

What a swipe on a mail row does, and why it does only that.

This is the behaviour doc for the feature; the code follows it, and a change to
one is a change to both. The pieces:

| | |
|---|---|
| Model, resolver, geometry | [`app/src/swipe/swipe.ts`](../app/src/swipe/swipe.ts) |
| Persistence (global, one device) | [`app/src/store/mailPrefsStore.ts`](../app/src/store/mailPrefsStore.ts) |
| Live preference | [`app/src/ui/mailPrefs.tsx`](../app/src/ui/mailPrefs.tsx) |
| Gesture + revealed pane | [`app/src/ui/swipeRow.tsx`](../app/src/ui/swipeRow.tsx) |
| Running it | [`app/src/ui/swipeRun.tsx`](../app/src/ui/swipeRun.tsx) |
| Settings | `Settings → Mail → Swipe options` — [`MailScreen`](../app/src/screens/MailScreen.tsx), [`SwipeOptionsScreen`](../app/src/screens/SwipeOptionsScreen.tsx) |

## The defaults

**Left: Archive. Right: Set Up.**

The right side ships unconfigured, and that is a decision rather than an
omission: every action on offer moves or re-files mail, and nobody should meet
one by brushing the screen. A user who wants Delete under their thumb says so
once and it is theirs from then on.

Unconfigured is not the same as dead. Swiping that way reveals a neutral grey
block reading **"Swipe to set up actions"**, and completing the swipe opens this
settings screen. **Nothing is done to the message** — nothing archived, moved,
filed, flagged or marked — which is the rule that matters; what the row does
instead of nothing at all is offer to be configured.

Both sides are independent, on screen and on disk: setting one writes one field
and leaves the other exactly as it was.

## The actions

Only operations CryptMail already has. Each is the *same* call the message
screen's own toolbar makes — a swipe adds a gesture, never a second
implementation.

| Action | Runs | Undo |
|---|---|---|
| Set Up | opens this screen; touches no mail | n/a |
| Archive | `archiveMessage`, or `unarchiveMessage` in Archive | yes |
| Delete | `trashMessage`, or `restoreMessage` in Trash | yes |
| Mark as spam | `markSpam` / `markNotSpam` | yes |
| Mark read or unread | `setUnread`, whichever the row is not | yes |
| Snooze | the existing snooze sheet, then `snoozeMessage` | yes |

Deliberately absent:

- **Move to folder.** There is no folder to move to. Archive, Trash and Spam are
  the three places a message goes, and each is its own action here. A picker
  offering "Inbox / Bills / Promotions" would be offering the *categoriser's*
  reading of mail as though it were storage — it isn't (`categorizer.ts`).
- **Flag / star.** `toggleStar` reads the inbox list only, so the action would
  quietly misbehave in Sent, Archive and Trash.
- **Report.** CryptMail's spam handling *is* the report: marking trains this
  device's own filter (`spam/`). Nothing is sent anywhere.

Adding one later is a case in `resolveSwipe`, an entry in `SWIPE_ACTIONS`, and a
glyph in `swipeRow.tsx`. Nothing else.

## Context

The preference is a preference. It is never rewritten because of where you are —
the resolver decides what it *means* here, at the moment of the swipe:

| Configured | Inbox (and categories) | Sent | Archive | Trash |
|---|---|---|---|---|
| Set Up | opens settings | opens settings | opens settings | opens settings |
| Archive | Archive | — | **Move to inbox** | — |
| Delete | Delete | Delete | Delete | **Restore** |
| Mark as spam | Spam / Not spam | — | — | — |
| Read | toggles | toggles | toggles | toggles |
| Snooze | Snooze | — | — | — |

A dash is a real answer: **the row does not move at all**, exactly as an
unconfigured side does not. Sent and Trash have no INBOX label to remove and are
not the archive to come back from, so Archive means nothing there — and a row
that slid away under an "Archived" toast having done nothing would be a lie
about the mailbox.

Two actions are also unavailable on **another mailbox's row in a merged inbox**:
a spam mark trains the active account's model and a snooze is written to the
active account's store. Opening the row switches to its account, and the swipe is
there a gesture later.

## The gesture

- The row follows the finger once the pull is unmistakably sideways
  (`SWIPE_ENGAGE_PX`, with vertical movement failing the gesture so the list
  still scrolls).
- Behind it, a block of the action's colour grows out of the edge the row came
  away from. It carries the action's **glyph** from the start and its **name**
  only once the pull will actually run it — a block that said "Delete" through a
  gesture about to be cancelled would be lying about what happens next.
- The fill deepens with the pull: 16% at the top of the gesture, full colour at
  the trigger line, where the glyph also flips to dark ink. Three things say
  "this will fire" — colour, ink, a word — so none of them is load-bearing
  alone.
- A neutral block (Set Up, a read flag) ramps to `surfaceRaised` rather than to
  a bright fill, and keeps light ink. It is a panel behind the row, not a
  verdict about the message.
- **Trigger distance scales with the row** — a fraction of its width, clamped at
  both ends, so it is one gesture on a phone and on a tablet. Destructive
  operations (Delete, Spam) ask for a longer pull than reversible ones.
- Released short of the line: the row springs back and **nothing runs**.
- Released past it: the operation runs once, and the row is flung away only if it
  actually leaves this list. A snooze springs back — the picker still has to ask
  until when.

Colours are a family of their own — `swipeColor` in `theme.ts`: a deep green
(`#0E7A41`) for Archive, Move to inbox and Not spam, a deep red (`#A83239`) for
Delete and Spam. Snooze follows the accent, because a time is not a verdict
about a message.

Deep rather than bright, because of the ground they sit on: a block the height of
a mail row is the largest lit area the app ever draws, and on a true-black OLED
screen a saturated one is a lamp — it reads as an alert rather than as the quiet,
reversible filing action it is.

They are deliberately **not** the `mint`/`coral` trust pair. Those two mean
*verified* and *key changed*, they are fixed at every accent because a user must
not be able to recolour what a signature proved, and a block the size of a mail
row is the loudest place in the app to say them — while an archive is not a
claim about who sent the message. Washing them down the pull gives the two
states the reference shows: a near-black forest green at a shallow pull
(`#052C17` on the true-black ground), full colour at the line. The wash starts at
24% rather than 16% — at 16% a colour this deep is indistinguishable from the
ground, and the first centimetre of the pull looked like nothing was happening.

Armed ink is per tone rather than one constant: the action colours are deep
enough that dark ink on them is a smudge, so they take white; only the accents
(Snooze) are light enough to take dark ink, and the neutral surface keeps light
ink at every depth.

**One implementation note that is load-bearing.** The block is drawn full-bleed
behind the row and is *seen* only through the strip the row has uncovered,
because the row is opaque. It is deliberately not sized to the pull: animating
its `width` moves the view's frame on the UI thread without re-running layout,
so its glyph and label keep the offsets Yoga gave them when the pane was first
laid out — at zero width — and end up parked outside the visible strip. The
block then reads as an empty slab. It cost an afternoon on a device; don't
reintroduce it. It is also why the **gap between rows lives on the swipe
wrapper** rather than on the row: a margin inside the wrapper is a strip the row
does not cover, and the block shows through it as a coloured hairline under
every row it is behind. For the same reason nothing here reads the pull through a
captured helper closure: the first render of a row happens before it is
measured, so a closure over the threshold pins it at zero for the row's life.

## Undo

**Every swipe can be undone.** Each operation has an opposite that already
exists: Archive ↔ Move to inbox, Trash ↔ Restore, Spam ↔ Not spam, read ↔
unread, snooze → un-snooze. Five seconds, in the toast the snooze flow already
used.

Archive was the exception until `FlagPatch.archived` became two-way, and it
became two-way *for this*: the gesture a thumb reaches by accident should not be
the one action with no way back. `archived: false` adds the INBOX label
(`mail/gmail.ts`), and `applyFlagPatch` drops the row in that direction too —
archiving takes it out of the inbox, un-archiving takes it out of Archive.

Two things make an undo actually look undone, and both are easy to leave out:

- **The list it returns to has to re-fetch.** `applyFlagPatch` only ever removes
  rows; nothing adds them back. So an undo re-syncs the list the swipe happened
  in — `refreshInbox()` for the inbox, `loadBox(box)` for Sent, Archive or
  Trash — and `runSwipe` is told which list that was. Without it the message is
  back in the mailbox and still missing from the screen. The two flag actions
  and the spam marks skip this: they never moved the row. So does un-snoozing,
  which un-hides a message this device is already holding.
- **The button has to be reachable.** The toast sat at `insets.bottom + 16` and
  the compose button at `+ 22` — the same rectangle. The toast painted over it,
  but the button took the touch, so Undo did nothing. The toast now clears it by
  `fabClearance` (`theme.ts`).

A failure is reported as a failure — never a success line over an operation that
threw. `setFlags` re-fetches the list it could not change, so what is on screen
is the provider's answer again.

## Where it is wired

The inbox and the Sent/Archive/Trash bodies, through the one shared row
(`ui/mailList.tsx`). An inbox row is a *conversation*, so the operation runs over
every message in it — archiving one of three would spring the row straight back.

Verified on a device against a real Gmail account: the default right swipe
showing the set-up block and opening this screen; Archive from the inbox; a
cancelled pull leaving the row untouched; archive → Undo → the message back in
the inbox; Delete's longer threshold refusing the
pull that would already have archived; delete → Trash → swipe → back in the
inbox; and Archive sitting inert in Trash, where it has nothing to do.

Drafts, Scheduled and Contacts do not swipe: none of them is provider mail, and
none of these operations means anything there.
