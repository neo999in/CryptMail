# Contributions by author

A summary of who built what in CryptMail, taken from the history of `main`
(146 commits, 2026-08-02 → 2026-09-17). Commit counts don't include merges.
Line counts cover non-merge commits on `main` and are rough: they include
lockfiles, docs and generated assets.

| Author | Commits | Lines (+/−) | Main areas |
|---|---|---|---|
| neo999in / Aayush Patel | 36 (+8 merges) | +47.6k / −5.7k | Crypto core, key discovery and recovery, state architecture, multi-account, Outlook |
| Ashok Prajapati | 37 | +17.1k / −4.0k | UI rework and design system, HTML reader, mail folders, contacts, snooze, undo send |
| Akashi7766 (Kashif Mukaddam) | 28 | +6.4k / −0.8k | Reply/forward, first multi-account pass, performance fixes, decrypt reveal, raw cache |
| Parth | 27 | +26.2k / −1.9k | Google sign-in, spam detection, swipe actions, labels and rules, rich-text compose, export |

`neo999in` and `Aayush Patel` commit with the same email (`neo999in@gmail.com`),
so they're counted as one person. `Aayush Patel` shows up only on GitHub PR
merges.

---

## neo999in / Aayush Patel

Started the project, built the crypto and key layers, and set up the app's
structure. They also handled most integration merges.

**Foundation (Aug 2–9)**
- Created the repo and renamed it from CipherMail to CryptMail.
- Added the first four screens for sending and reading mail.
- **Crypto core:** wrote the post-quantum migration plan and an rPGP spike
  showing Rust is required. Added `cryptmail-core` with RFC 9980 post-quantum
  encryption, connected the TypeScript bridge to the native core, and tested the
  algorithm IDs.
- **Docs:** added the implementation-status ledger (verified vs. unverified) and
  a detailed trace of the encryption flow.
- Fixed interop, storage, verification and re-auth issues.
- **Key recovery:** wrapped the identity key with an Argon2id recovery code.
- **Key discovery:** find, publish and queue keys so the first message is
  encrypted. Added support for multi-identity published keys and opening the
  keyserver confirmation link inside the app.
- **Send path:** added the outbox's "Check for a key" action, an explicit
  unencrypted send mode, and the Autocrypt header on plaintext sends.
- **UI:** added the flat true-black AMOLED ground and tappable links behind a
  confirmation sheet.

**Architecture (Aug 23–31)**
- Split `AppState` into a synchronous store plus plain service modules. This is
  the `state/` layout described in CLAUDE.md.
- Added attachments inside the encrypted MIME tree (send, receive and save).
- Removed the demo mailbox.
- Merged the attachments, multi-account and spam-detection branches into `main`.

**Accounts and providers (Sep 5–14)**
- Rebuilt multi-account support so several mailboxes, including several Gmail
  accounts, are served at once, and rebuilt compose around the active account.
- Added per-mailbox management: settings, sync window and pausing.
- Added key restore from a file.
- Connected Outlook.com and Microsoft 365 through Microsoft Graph.
- Sent Mark as spam and Not spam through to the provider.
- Made lists load from a local cache for faster destination switches, and fixed
  swipe undo when a sync races it.
- Moved Keys and Key recovery onto grouped cards.

---

## Ashok Prajapati

Built the current look and most of the reading experience.

**UI and design system (Aug 30 – Sep 3)**
- Reworked the app onto flat surfaces with a themeable accent.
- Replaced the Outlook-style chrome with bordered cards, added the aurora top bar,
  and themed every dialog.
- Wrote **Design.md**, the UI pattern reference.
- Made every drawer row a destination on a single home screen.
- Added aurora headers on the message, Sent and Archive screens, and reworked the
  Appearance screen.
- Fixed an Android crash on a wrapped passphrase the device can't open.

**Mail and inbox**
- Added backward paging through mailboxes, plus the Sent and Archive folders.
- Changed the Focused/Other tabs to **Primary/Encrypted** on a sliding pill.
  Stopped categorising encrypted mail and left plaintext tabs to Gmail.
- Added contacts with a trust dashboard for each contact.
- Added **Undo send** (5-second window and toast) and **Snooze**.

**HTML reader (Sep 4–5)**
- Rendered HTML in encrypted mail, applying its stylesheet and gating remote
  images.
- Translated email CSS to React Native:
  - fonts addressed by face
  - palettes adapted to the black ground
  - presentational attributes and buttons
  - a single table deciding what is safe and translatable
  - charset-correct decoding
  - fitting content to a phone width

**Polish (Sep 15)**
- Folded Settings into one group and removed rows that duplicate the drawer.
- Renamed "In front" to "Active".
- Removed the unread dot; read mail now shows a greyed date.
- Made the compose button fold to an icon on scroll.
- Moved press-scale, skeleton-pulse and fold animations onto Reanimated.

---

## Akashi7766 (Kashif Mukaddam)

Worked on threading, accounts, performance and the latest message-screen
features.

- **Categories (Aug 25–26):** category drawer navigation and the email
  categoriser.
- **Reply, forward and threading (feature 0.7).** Also shows the recipient list
  in the message header.
- **First multi-account pass (Aug 31):** several mailboxes with a merged inbox.
- **Attachment cap:** measured the real limit and set it to 5 MB.
- **HTML components (Sep 2–3):** the first `HtmlReader` and rich-text composer
  components, wired into `MessageScreen`.
- **Merged-inbox fixes (Sep 11):**
  - dropped the active-account ring and sending-mailbox markers while merged
  - added a loader while a mailbox is added
  - ignored double back taps
- **Performance (Sep 11):**
  - reads account stores in parallel at boot
  - fetches the inbox and junk folder in parallel
  - mounts swipe panes only while dragging
  - stops list renders from re-rendering every row
- **Message screen (Sep 17):**
  - scramble-reveal animation for a freshly decrypted subject and body
  - on-device cache of encrypted mail as ciphertext (`rawCache`), so reopening
    skips the network
- **Docs:** rewrote the README and updated the docs to match the current build.

---

## Parth

Worked on sign-in, spam, and most of the mail-management and compose features.

- **Auth (Aug 8):** added the native Google sign-in module.
- **Spam (Aug 28 – Sep 2):** spam and phishing detection, and Gmail junk mailbox
  support.
- **Swipe actions (Sep 10–13):**
  - one configurable action per side, where a side can be set to do nothing
  - fixed layouts for Sent, Drafts, Archive and Spam
  - animated read, unread, spam, snooze and not-spam glyphs
  - the action shows from the first centimetre of the pull
- **Reader:** shared the reader's body, link sheet and chrome. Added a
  conversation view that opens as one page growing out of its row.
- **Mail management (Sep 13):**
  - local labels, client-side rules and multi-select bulk actions
  - a Snoozed folder, per-mailbox signatures and canned replies
- **Compose:** rich-text writing sealed as `multipart/alternative`, then a
  borderless editor with a bottom formatting bar.
- **Notifications:** privacy policy and push payload contract.
- **Storage (Sep 13–14):**
  - byte counts and a bounded search index
  - full mailbox and `.eml` export that waits out provider rate limits
  - a recovery-code drill
- **Connect screen (Sep 14):** rebuilt on grouped cards with Google and Microsoft
  marks, and fixed the "no key" promise. Added the provider logo as an account
  avatar option.
- **Tooling:** added the `run-cryptmail` skill for driving the Android emulator.

---

## Not yet on `main`

Some commits exist only on feature branches, for example `feature/emailSignature`,
`feature/undo-send`, `feat/snooze` and `backup/pre-trailer-strip`. Several of
these landed on `main` later in another form. This summary doesn't cover them.
Run `git log --all --not main` to see them.
