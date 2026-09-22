# The security levels, explained simply

Every email you write in CryptMail goes out at one of three **security levels**.
You choose one in compose, per message. This page explains what each one really
does, what it costs, and how they compare — in plain language, with the crypto
jargon translated as it appears.

If you read nothing else: **Level 1 is the default and it is the right answer
almost always.** Level 2 exists to demonstrate the quantum Key Manager.

> **In this build, compose offers two:** `L1 · PGP` and `L2 · Quantum`.
> **Level 3 is switched off**: hidden, and refused if a held message still
> carries it. Level 3 mail you already received still opens.
>
> **Level 4 (per-email keys) was removed on 2026-09-22.** Mail sealed with it
> can no longer be decrypted; copies already in the local archive still open.
> A message still waiting in the outbox at Level 4 never sends by itself —
> cancel it to drafts and send it again.

---

## Contents

- [The one thing that never happens](#the-one-thing-that-never-happens)
- [Why they are two groups, not a ladder](#why-they-are-two-groups-not-a-ladder)
- [Level 1 — no quantum security (standard PGP)](#level-1--no-quantum-security-standard-pgp-the-default)
- [Level 2 — quantum](#level-2--quantum)
- [Level 3 — quantum secure, one-time pad (switched off)](#level-3--quantum-secure-one-time-pad-switched-off)
- [Comparisons](#comparisons)
- [Choosing: a short decision guide](#choosing-a-short-decision-guide)
- [Things true at every level](#things-true-at-every-level)
- [Honest limitations](#honest-limitations)
- [Glossary](#glossary)

---

## The one thing that never happens

**CryptMail never sends your mail unencrypted to get a send through.** There is
no "just this once" button, and no silent fall-back to a weaker level. When
something is wrong, one of exactly two things happens:

| Situation | What CryptMail does |
|---|---|
| The recipient has **no key yet** | Holds the message in the outbox (*awaiting-key*), sends them a contentless invite, and delivers itself once their key arrives. The UI says **queued**, never *sent*. |
| The recipient's key **fingerprint changed** | **Blocks the send outright.** Nothing goes out and nothing is queued — a changed fingerprint may mean someone swapped the key, and waiting cannot resolve that. |

Writing a deliberately unencrypted email is a separate, explicit action. Nothing
on the encrypted path can wander onto it.

---

## Why they are two groups, not a ladder

Numbered in a row, these look like a difficulty slider where bigger is better.
That reading is wrong: **Level 3's famous "unbreakable" guarantee rests on a key
source that is simulated here.** On paper a one-time pad is the strongest
encryption that can exist. In *this* build the keys come from a software random
generator, not from quantum hardware, so the paper guarantee does not transfer.

So compose groups them, separated by a divider (the group names below are not
shown on screen):

**Everyday — 1.** Works with anyone whose public key you hold. No shared key
bank, and it is **signed** so the recipient knows it was you.

**Quantum keys — 2 (and 3, switched off for now).** Need a key bank shared
with the recipient in advance. These demonstrate how a real Quantum Key
Distribution system would plug into email.

---

## Level 1 — no quantum security (standard PGP) *(the default)*

### What it does

**Ordinary OpenPGP encryption to the recipient's long-term public key** — the
same thing every other PGP mail tool has done for decades — and to your own, so
your Sent folder stays readable.

One key, held for years, encrypts and decrypts everything:

- **No forward secrecy.** Whoever obtains that long-term private key later can
  open every message ever sealed to it, including ones sent years ago.
- **Quantum resistance depends on the recipient's key.** A CryptMail key
  encrypts with **ML-KEM-768 combined with X25519**, so recorded mail stays
  sealed if *either* algorithm holds — a defence against
  *harvest-now-decrypt-later*. A key from another PGP client is usually
  classical only, and mail sealed to it is not protected that way.

It is named *"No quantum security"* in the picker because no quantum keys are
involved. That is the honest label.

### Costs and limits

Needs the recipient's public key (imported manually, or harvested from mail they
sent you — CryptMail does **not** look keys up on the network). Any size,
attachments fine. Signed. Opens as often as you like, on any device holding the
key.

---

## Level 2 — quantum

Shown in compose as **`L2 · Quantum`** (it was called *quantum-aided AES*).

### What it does

**One key is drawn from your Key Manager's shared bank and used to seed
AES-256-GCM**, the standard strong cipher, which then encrypts the message.

More precisely: the 1 Kb quantum key is run through **HKDF** (a key-derivation
function) together with the key's ID, and the result becomes the AES key. The
key ID acts as a salt, so two messages never end up with the same AES key even
though both came from the same bank.

### The key bank

Levels 2 and 3 work completely differently from Level 1: **they never look at
the recipient's public key at all.** Instead, both devices must already hold
**the same bank of secret keys** — 100 keys of 1 Kb each. Holding that bank is
what makes the message readable. Nothing about the key travels with the email
except its ID, and an ID without the bank is worthless. So Level 2 is exactly as
safe as the bank is secret, which is why the messages that build it are sealed
with post-quantum encryption (below).

You establish a shared bank in **Settings → Quantum Key Manager**, two ways:

1. **BB84 over email** — runs the actual quantum-key-distribution protocol
   across three emails, each sealed to the other person's post-quantum key and
   signed (send states, compare measurement bases, check the error rate, then
   privacy-amplify what survives). You need their key first — exchange one
   encrypted message before linking. It completes over a few
   syncs with no action from either person, or press **Check for link
   messages** on each phone to move it along and see what happened.
2. **A link file and a one-time code** — copies one bank straight to the other
   phone. Kept for when both phones are in the same room.

Once linked, one end becomes **master** and sends only from the first 50 keys,
the other becomes **slave** and sends only from the last 50. This is deliberate:
if both ends could pick the same key, a one-time pad would be reused, which
destroys it completely.

### Costs and limits

- **One key per message, regardless of size.** AES does the heavy lifting, so
  long emails and attachments are fine. This is what makes Level 2 the practical
  member of the pair.
- **Sending is blocked if this mailbox has no quantum link.** Compose checks and
  refuses, pointing you at the Key Manager screen — because with no recipient
  key involved, nothing else would catch it, and you would produce a message
  nobody on earth could ever open, including you.
- **Not signed.** Holding the bank is what proves who sent it, so CryptMail
  reports the signature as *none* rather than claiming one it does not have.
- **Refilling or re-linking the bank abandons any unopened mail** sealed with
  the old keys. The refill dialog warns you.

---

## Level 3 — quantum secure (one-time pad) *(switched off)*

**Switched off in this build.** Level 3 is hidden from compose and refused if a held message still carries it; Level 3 mail you already received still opens. The section below describes it for when it returns.

### What it does

**The keys from the bank are used directly as a one-time pad.** The message is
combined bit-for-bit (XOR) with pure random key material of the same length, and
one further key authenticates the result with **HMAC-SHA256**.

A one-time pad is the only encryption proven mathematically unbreakable —
*information-theoretically secure*, meaning no amount of computing power helps,
ever. The ciphertext genuinely contains no information about the message. But
that proof has three conditions, all strict: the key must be **truly random**,
**as long as the message**, and **never reused**.

### Why there is a MAC on top

A pad on its own is **malleable**: an attacker who cannot read your message can
still flip bits in it, and the recipient has no way to notice. So one extra
quantum key authenticates the ciphertext *and* the header with HMAC-SHA256 —
which also means nobody can tamper with the declared level or the key list.

Worth knowing: the pad itself is information-theoretically secure, but the MAC
is only computationally secure. So the combination is not purely unbreakable in
the textbook sense.

### Costs and limits

This is the expensive one, and the expense is inherent to one-time pads, not a
shortcut in this implementation:

- **One 1 Kb key per 128 bytes of message, plus one more for the MAC.** A short
  paragraph consumes several keys.
- **50 keys per end is about 6,272 bytes of pad in total.** That is short text
  only — **no attachments**, and not many messages before a refill.
- Compose tells you how many keys the message will spend and how many remain,
  and **blocks Send** if the message needs more keys than the bank holds.
- Same as Level 2: needs a quantum link, not signed, refill abandons unopened
  mail.

---

## Comparisons

### At a glance

| | **L1 · PGP** | **L2 · Quantum** | **L3 · One-time pad** *(off)* |
|---|---|---|---|
| Group | Everyday | Quantum keys | Quantum keys |
| Default | **yes** | no | no |
| What seals it | OpenPGP to long-term key | AES-256-GCM seeded by a quantum key | XOR with pad + HMAC-SHA256 |
| Key comes from | their public key | the shared bank | the shared bank |
| Setup needed | their public key | shared key bank | shared key bank |
| Uses recipient's key | yes | **no** | **no** |
| Forward secrecy | **no** | yes (keys deleted) | yes (keys deleted) |
| Resists future quantum computers | to a CryptMail key, yes (ML-KEM-768 + X25519) | **yes**: AES-256, bank linked over ML-KEM | in principle yes |
| Signed | yes | no — bank proves sender | no — bank proves sender |
| Tamper-evident | yes | yes (GCM) | yes (HMAC) |
| Message size limit | none | none | **very small** — short text |
| Attachments | yes | yes | **no** |
| Key cost per message | — | 1 key | 1 per 128 bytes + 1 |
| Opens more than once | yes | no — archived locally | no — archived locally |
| Can the sender reread it later | yes | yes, from the local archive | yes, from the local archive |

### Level 2 vs Level 3 — the quantum pair

Both need the same setup and both spend keys from the same bank. The trade is
**strength of guarantee against practicality**.

| | Level 2 | Level 3 |
|---|---|---|
| Guarantee | computational (AES-256 is unbroken, not unbreakable) | information-theoretic *for the pad itself* |
| Keys per message | 1, whatever the size | 1 per 128 bytes, + 1 |
| Attachments | yes | no |
| Messages from a full 50-key half | ~50 | a handful of short notes |
| Practical for daily mail | yes | no |

**Pick Level 2** for anything normal once you share a bank. Level 3 is switched
off in this build; when it returns it is for short, high-stakes text where you
want the strongest guarantee the protocol can express, bearing the simulation
caveat in mind.

### Everyday vs Quantum keys

| | Everyday (1) | Quantum keys (2, 3) |
|---|---|---|
| Needs advance setup | no | **yes** — a shared bank |
| Depends on the recipient's public key | yes | no |
| Signed | yes | no (bank proves the sender) |
| Fails when | no key yet → queued | no link → **send refused** |
| Runs out | never | yes — the bank depletes and needs refilling |
| Real security today | **yes** | **demonstration** — simulated key source |

---

## Choosing: a short decision guide

1. **Just writing an email?** → **Level 1.** Stop here. This is the default and
   it needs no thought.
2. **Want to see the QKD integration work, and you share a bank with them?** →
   **Level 2** for normal mail.
3. **Want the one-time pad?** Not available: **Level 3 is switched off** in
   this build.

---

## Things true at every level

**1. Your mail is never sent in the clear.** Covered above — hold, block, or
send correctly sealed. There is no fourth option.

**2. The subject line is always encrypted.** Every level uses the same
placeholder subject, `[Encrypted message]`. The real subject lives inside the
encrypted part, along with the body and any attachment filenames. This also
means your inbox, notification rules and the spam engine treat every level
identically without being told anything.

**3. Levels 2 and 3 archive locally, because they can only be opened once.**
Their keys are destroyed as the message opens. Without a local copy, reading an
email would be the last time you ever saw it. So CryptMail keeps its own
**sealed** copy on your device, written *before* the message is sent and again
the moment one is opened. That archive never leaves the phone, never evicts, and
travels with you when you move to a new device. It also keeps mail you read
with the removed Level 4, which nothing else can open any more.

**4. Key discovery never touches the network.** CryptMail does not query key
servers or WKD, in any build. A key reaches your device only from someone who
wrote to you, or by manual import. This was turned off after a directory served
a superseded key for a test account and the resulting message could not be
opened by anyone — exactly the kind of silent failure this app exists to avoid.

**5. Moving to a new phone moves everything, and moves it once.** Your key,
archive and key bank transfer together under a one-time code. The old phone
stops sending with quantum keys — two ends drawing from one half of a bank would
reuse a one-time pad. The old phone can still *read*.

---

## Honest limitations

These are stated plainly in the app too, not just here.

- **The Key Manager is simulated. It gives no quantum security.** Its keys come
  from the operating system's random generator, not from a quantum channel.
  What *is* real is the integration: the same call shape a vendor Key Manager
  exposes (ETSI GS QKD 014), keys issued once and deleted on use, and two ends
  holding matching banks. Swapping in real hardware would replace one file.
- **BB84 over email is the real protocol over a fake channel.** What makes
  genuine quantum eavesdropping detectable is that a quantum state cannot be
  copied. Here the states are bits inside an email, so anyone who could read
  that email would get the bits *and* the bases and leave no trace in the error
  rate. That is why each leg is sealed to the recipient's post-quantum
  (ML-KEM-768 + X25519) key and signed: the bank is as secret as that sealed
  message, and a leg that arrives plain or signed by someone else is refused.
  Everything above the channel — sifting, the error check, privacy
  amplification, the refusal when too much of the sample disagrees — is the
  genuine protocol and would not change with hardware.
- **Level 1 has no forward secrecy.** A stolen long-term key opens every
  Level 1 message sealed to it. Per-email keys, which closed that, were removed.
- **Level 3 is small, permanently.** One-time pads consume key equal to the
  message. That is mathematics, not an implementation shortcut.
- **Levels 2 and 3 authenticate but do not sign.**
- **If the build has no native crypto core, encryption is a stand-in.** In that
  mode the app base64-encodes rather than encrypts, and says so on every screen
  it appears on. It is never presented as secure.

---

## Glossary

| Term | In plain words |
|---|---|
| **Forward secrecy** | Stealing today's key does not open yesterday's messages. |
| **Harvest-now-decrypt-later** | Record encrypted traffic now, break it when the hardware catches up. |
| **Post-quantum** | Designed to survive a large quantum computer. |
| **ML-KEM-768** | A standardised post-quantum key-agreement algorithm. |
| **X25519** | The well-tested classical key-agreement algorithm it is paired with. |
| **AES-256-GCM** | Standard strong cipher that also detects tampering. |
| **HKDF** | Turns one secret into other well-shaped keys. |
| **HMAC-SHA256** | A tag proving data was not altered by someone without the key. |
| **One-time pad** | Combine the message with random key of equal length; unbreakable if the key is random, secret and used once. |
| **Information-theoretic security** | Unbreakable regardless of computing power — not merely "hard". |
| **Malleable** | An attacker can alter the ciphertext meaningfully without reading it. |
| **QKD** | Quantum Key Distribution — producing shared secret keys over a quantum channel. |
| **BB84** | The original QKD protocol, from 1984. |
| **Key bank / Key Manager** | The store of shared secret keys Levels 2 and 3 draw from. |
| **SAE ID** | The identifier naming one end of a key-manager link. |
| **Autocrypt** | Attaching your public key to outgoing mail so recipients gain it automatically. |

---

*Sources in this repo: [`app/src/core/qkd.ts`](../app/src/core/qkd.ts) ·
[QKD levels design](superpowers/specs/2026-09-20-qkd-levels-design.md) ·
[per-email keys design](superpowers/specs/2026-09-19-per-email-keys-design.md) (removed) ·
[encryption.md](encryption.md) · [key-management.md](key-management.md) ·
[message-format.md](message-format.md)*
