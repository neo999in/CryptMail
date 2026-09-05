# Two Gmail accounts on one device — design

Written 2026-09-05. Extends
[2026-08-08-google-auth-native-design.md](2026-08-08-google-auth-native-design.md),
which chose Play-services sign-in and recorded, correctly, that it holds one
signed-in user. That was read as "one mailbox", and it is not.

## What was actually blocked

The multi-account work was already done everywhere except one file. The account
registry, the per-account store scoping, the provider-per-account map, the
switcher, the merged inbox and the per-account teardown on removal all handle N
and are covered end to end by
[`state/__tests__/accounts-test.ts`](../../../app/src/state/__tests__/accounts-test.ts).

`googleAuth.restoreAll` returned an array of one, and `freshAccessToken(email)`
and `signOut(email)` ignored the address they were handed. So the plumbing above
was real and unreachable.

## The distinction the old spec missed

Play services has one **current user**. It does not have one **grant**.

`GoogleSignin.signOut()` clears the local sign-in state; only `revokeAccess()`
removes the app's authorization from a Google account. So an app that has been
granted access to two accounts can move between them without a consent screen —
`configure({ accountName })` then `signInSilently()`.

That is what this design uses: one user in front at any instant, several
reachable.

| Option | Verdict |
|---|---|
| `accountName` multiplexing over Play services | **Chosen.** No new dependency, no server. |
| `offlineAccess` → `serverAuthCode` → refresh token | Real simultaneous grants, but the exchange needs the **Web client secret**, i.e. a backend. Breaks "a client, never a provider" and rule 4 (no secrets in the repo). Refused. |
| Hosted `https` redirect + App Links + per-account AppAuth | Works, and gives genuinely independent grants. Needs a domain serving `assetlinks.json` — the same reason it was refused in the 2026-08-08 spec. **Kept as the escape hatch** if the chosen shape fails on a device. |
| Interactive switch (sign out, re-pick, every time) | The fallback inside the chosen shape: correct, but a picker per switch, and a merged inbox becomes impossible. |

## The risk, and what contains it

The configured account is **global mutable state**. Interleaving one account's
`getTokens` with another's `configure` hands a Gmail client a token for the wrong
mailbox — which reads, and could send from, the wrong inbox. That is the worst
failure this codebase could have short of a plaintext send, and it is not
hypothetical: it is the default behaviour of the naive implementation.

Two things contain it, both in
[`auth/googleAuth.ts`](../../../app/src/auth/googleAuth.ts):

1. **One FIFO queue** for every Play-services interaction. The unit that has to
   be atomic is the whole configure/sign-in/token triple, not each library call
   — which is why this replaces, rather than extends, the two single-flight
   slots the 2026-08-08 spec added. Those existed because the library overwrites
   an in-flight `signInSilently` or `getTokens` promise and the overwritten one
   never settles; a queue fixes that bug and this one together.
2. **The address that comes back is checked against the address asked for**
   before any token is handed out. A mismatch throws.

The mismatch is `failed`, not `reauth-required`, and deliberately so: Google
ignoring an account hint says nothing about whether the grant is good, and
signing in again would not fix it. Calling an unrecognised failure permanent is
the inversion `revocation.ts` exists to prevent.

## Access tokens are now cached, in memory, per account

The 2026-08-08 design cached nothing on purpose — Play services was asked afresh
every time, and only the *pending call* was shared. That is no longer free. A
merged-inbox refresh is `limit + 1` requests **per account**
([`mail/gmail.ts`](../../../app/src/mail/gmail.ts)), and without a cache each one
would re-point Play services at a different user and silently sign in again. The
account thrash would dominate the sync and multiply the window in which the wrong
account is in front.

The TTL is 5 minutes — far shorter than a Google access token's real hour. It is
not an expiry (Play services still owns that) but a bound on how long a revoked
grant can keep being served from memory. A token that dies inside the window
still surfaces: the Gmail client turns a 401 into `reauth-required`.

Never persisted. The property that matters from the old spec — **no stored
long-lived secret** — is unchanged.

## `restoreAll` takes the addresses it should ask for

Play services will silently restore whichever account it is *asked* for, but it
does not enumerate the grants an app holds. So the provider cannot discover the
mailboxes on a device, and `restoreAll(known?: string[])` is handed them.

They come from `accountsStore`, which is already the record of which mailboxes
this device has. A second copy kept inside the auth layer could disagree with it,
and the disagreement would be invisible.

An empty list means "restore whoever is in front" — a first launch, and an
install from before the registry existed.

An address that cannot be restored is **omitted, not thrown for**: one revoked
grant must not cost the user the other mailbox that still works. A failure that
leaves *nothing* restored does throw, so an offline launch reaches the user as an
error rather than as a silent sign-out.

## Boot is two phases

[`state/session.ts`](../../../app/src/state/session.ts) restores the mailbox that
was in front, paints it, and brings the rest back behind it.

Restoring an account is a Play-services round trip that the queue takes one at a
time, so putting all of them in front of the first paint would make a second
mailbox cost every launch — the user waiting on a mailbox they are not looking
at. The background restores register with `activate: false`; one that activated
itself would move the mailbox out from under whatever the user had already
started reading.

If the account that was in front will not restore, the next one opens rather than
the connect screen.

## A revoked grant is one account's problem

`handleAuthLoss` cleared the entire account list. With one account that was
indistinguishable from the truth; with two it signs the user out of a mailbox
that is working because a different one's grant expired.

It now takes the account that failed (defaulting to the active one) and, when
another connected mailbox exists, flags it instead: `State.needsReauth`, the
session and provider dropped, and a switch to a survivor. Only the last mailbox
returns the app to the connect screen.

**Nothing is erased.** A dead access token says nothing about whether the
keyring, drafts and decrypted mail on this device are still the user's. Only
`removeAccount` erases those, and only because the user asked. The flag is held
in memory: the next launch discovers it again by failing to restore the account.

**Both at once is the case that bit.** One merged refresh asks every provider,
so two mailboxes can come back `401` in the same tick and `markReauth` then runs
twice, concurrently: the first picks the second as the account to step onto
while the second is dropping its own session. `switchAccount` landed on an
account that no longer had one and **threw** — into a `void` call, so it
surfaced on the device as `Uncaught (in promise): "Error: That account is not
connected."` and never as anything a user could read. Found by running it, not
by the tests, which is worth recording.

It now reports through `State.error` instead of throwing, since every caller is
fire-and-forget, and it no longer starts a sign-in of its own accord — Google's
picker appearing as a side effect of a background token failure is a prompt
nobody asked for. The drawer offers that explicitly for a mailbox it has already
marked. Covered by "both accounts failing together" in `accounts-test.ts`.

The merged inbox is where this is usually *seen*. It swallows a non-active
account's failure so one offline mailbox does not blank the others — which meant
a permanently revoked second mailbox sat in the switcher contributing no mail,
with nothing on screen saying why. It now flags on `reauth-required` and stays
tolerant of everything else.

## Testing

[`auth/__tests__/googleAuth-test.ts`](../../../app/src/auth/__tests__/googleAuth-test.ts)
runs against a fake Play services that is a small state machine holding two
grants and minting a token per account. That shape is the point: a fake returning
one token whatever is configured cannot produce a crossed token, and so cannot
test the thing most worth testing.

Covered: each account gets its own token; the ops log shows one account's triple
completing before the other begins; a hint that Play services ignores fails
without minting anything; the cache is per account and collapses concurrent
requests for one mailbox into a single `getTokens`; `signOut(email)` drops one
mailbox and leaves the other; and — carried over intact from 2026-08-08 — a
revoked grant is `reauth-required` while a dropped connection is `failed` with
the session kept.

[`state/__tests__/accounts-test.ts`](../../../app/src/state/__tests__/accounts-test.ts)
covers the two-phase boot, a front mailbox that will not restore, a second one
flagged rather than dropped, and one account's auth loss leaving the other signed
in.

## Verified on a device — 2026-09-05

The open question was whether Play services honours `accountName`, since it is
documented as an account that should be "prioritized", not one that is forced.
**It does.** Run on an Android 37 `google_apis_playstore` emulator (Pixel 10 Pro
XL, x86_64) with two real Gmail accounts — `neotestmail9@gmail.com` and
`neo.op99@gmail.com` — both granted to the app:

- **Adding a second mailbox.** `signIn()` signs the current client out first,
  the picker appears, and the new account registers *beside* the first rather
  than replacing it. Both appear in the drawer rail.
- **Switching, silently.** Tapping the other avatar loads that mailbox's mail
  with no picker and no consent screen — the inbox changes completely, and back
  again on the return trip.
- **The merged inbox is the real proof.** With "All accounts" on, the list
  interleaves both mailboxes newest-first and tags each row with the account it
  came from. Every tag matches its content: the keyserver mail addressed to
  `neo.op99` is tagged `neo.op99`, and `neotestmail9`'s mail is tagged
  `neotestmail9`. **Crossed tokens would show up here as both accounts
  returning the same mailbox's mail under two different tags.** They did not.
  The unread count went 18 → 20 across the toggle.
- **Two-phase boot.** A cold launch restored the mailbox that was in front,
  painted it, and brought the other back behind it: both rail avatars read
  "Switch to …", neither was flagged as needing a sign-in.

No `AuthError`, no identity mismatch, and no JS error in logcat throughout.

### Still not verified

- **A revoked grant.** Nothing was revoked on the device, so `needsReauth`, the
  flagged rail avatar, `signOut(email)` for one account, and `removeAccount` on
  a flagged account are covered by tests only.
- **Token refresh across a long-lived session.** §7.3's background scheduler
  depends on `getTokens` continuing to refresh without an interactive sign-in,
  and switching accounts is new pressure on the same uncertainty the 2026-08-08
  spec flagged. The session here was minutes, not hours.
- **A device where the hint is ignored.** The identity check would turn that
  into a clean `failed` rather than a wrong inbox, but the fallback path — the
  interactive switch, or App Links — has never been run.

## Deprecation, recorded rather than hidden

`GoogleSignin` is the legacy Google Sign-In SDK; Google is pushing Credential
Manager, and v16 of the library still ships both. Building account multiplexing
on `accountName` deepens the dependency on the deprecated half. That is a real
cost, accepted because the alternative is a server.
