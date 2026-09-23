# The security levels, explained simply

Every email you write in CryptMail goes out at one of two **security levels**.
You choose one in compose, per message. This page explains what each one really
does, what it costs, and how they compare — in plain language, with the crypto
jargon translated as it appears.

If you read nothing else: **Level 1 is the default and it is the right answer
almost always.** Level 2 exists to demonstrate the quantum Key Manager.

> **Compose offers two:** `L1 · PGP` and `L2 · Quantum`.
>
> **Level 3 (one-time pad) was removed on 2026-09-23**, and with it the split
> of the key bank into halves. Level 3 mail you already opened stays in the
> local archive and still opens; Level 3 mail you had not opened can no longer
> be opened. A message still waiting in the outbox at Level 3 never sends by
> itself — cancel it to drafts and send it again.
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
- [Why there is no Level 3](#why-there-is-no-level-3)
- [Comparisons](#comparisons)
- [Choosing: a short decision guide](#choosing-a-short-decision-guide)
- [Is it quantum safe?](#is-it-quantum-safe)
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
That reading is wrong: **Level 2's "quantum" rests on a key source that is
simulated here.** Its keys come from a software random generator, not from
quantum hardware.

So compose groups them, separated by a divider (the group names below are not
shown on screen):

**Everyday — 1.** Works with anyone whose public key you hold. No shared key
bank, and it is **signed** so the recipient knows it was you.

**Quantum keys — 2.** Needs a key bank shared with the recipient in advance. These demonstrate how a real Quantum Key
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
function) together with the key's ID **and the sender's SAE ID** — the name of
the phone that sealed it — and the result becomes the AES key. The sender's ID
is what lets both phones use the whole bank (below): if you and the other
person happen to pick the same key, your message and theirs still get two
different AES keys.

### The key bank

Level 2 works completely differently from Level 1: **it never looks at the
recipient's public key at all.** Instead, both devices must already hold
**the same bank of secret keys** — 100 keys of 1 Kb each. Holding that bank is
what makes the message readable. Nothing about the key travels with the email
except its ID, and an ID without the bank is worthless. So Level 2 is exactly as
safe as the bank is secret, which is why the messages that build it are sealed
with post-quantum encryption (below).

There is one extra layer when it can be had: if CryptMail already holds the
public key of **everyone** you are writing to, and none of them changed, the
Level 2 message is also sealed to those keys (ML-KEM-768 + X25519) and
signed. Then the bank alone opens nothing — a reader needs the bank *and* the
recipient's private key. Without those keys, the message goes sealed by the
bank only, as before; it is never held waiting for one. The opened message
says which it was.

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

Once linked, **both phones send from the whole bank** — all 100 keys each. The
two phones list the keys in the same order, so before either has seen the
other's latest mail they can both pick the same key. That is harmless: the AES
key also depends on who sent it, so one bank key gives two unrelated AES keys.
(The phone that started the link is still called *master* and the other
*slave*, but that is only a name now.)

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
- **Mail sent before 2026-09-23 still opens.** It was sealed without the
  sender's ID, when each phone used only its half of the bank; its header says
  so, and CryptMail opens it the old way.

---

## Why there is no Level 3

Level 3 was a **one-time pad**: the bank's keys XORed straight onto the message,
one 1 Kb key per 128 bytes, plus one for an HMAC tag. It was removed on
2026-09-23.

A one-time pad is only unbreakable if **no key is ever used twice**. When two
phones share one bank and can both send, the only way to guarantee that without
them talking first is to split the bank — each phone sends from its own half.
That halved what each side could send, for Level 2 as much as Level 3.

Level 2 can do without the split, because its AES key is *derived* from the bank
key, and the derivation can include who sent it. A pad cannot: the key bytes
*are* the encryption, so there is nothing to mix the sender into. Keeping
Level 3 meant keeping the halves, so it went. It was also small (about 6 KB of
text per side, no attachments) and its "unbreakable" guarantee rested on a key
source this build simulates.

---

## Comparisons

### At a glance

| | **L1 · PGP** | **L2 · Quantum** |
|---|---|---|
| Group | Everyday | Quantum keys |
| Default | **yes** | no |
| What seals it | OpenPGP to long-term key | AES-256-GCM seeded by a quantum key and the sender's ID |
| Key comes from | their public key | the shared bank |
| Setup needed | their public key | shared key bank |
| Uses recipient's key | yes | **no** |
| Forward secrecy | **no** | yes (keys deleted) |
| Resists future quantum computers | to a CryptMail key, yes (ML-KEM-768 + X25519) | **yes**: AES-256, bank linked over ML-KEM |
| Signed | yes | no — bank proves sender |
| Tamper-evident | yes | yes (GCM) |
| Message size limit | none | none |
| Attachments | yes | yes |
| Key cost per message | — | 1 key, from all 100 in the bank |
| Opens more than once | yes | no — archived locally |
| Can the sender reread it later | yes | yes, from the local archive |

### Everyday vs Quantum keys

| | Everyday (1) | Quantum keys (2) |
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
3. **Want the one-time pad?** Not available: **Level 3 was removed** — see
   [why](#why-there-is-no-level-3).

---

## Is it quantum safe?

Short answer: **Levels 1 and 2 are safe against a future quantum computer
reading mail recorded today, as long as ML-KEM-768 holds.** Neither gives
"quantum security" in the QKD sense.

**Level 1 — yes, when the recipient's key is a CryptMail key.**

- A CryptMail key encrypts with ML-KEM-768 + X25519 together, and the message
  itself with AES-256. A recording stays sealed if either key algorithm holds.
- A key from another PGP client (GnuPG, Proton, …) is usually classical only.
  Level 1 mail sealed to it can be broken by a large quantum computer.
- Signatures are classical Ed25519. A quantum computer could forge them, but
  that does not help it read past mail.
- No forward secrecy: whoever later steals the long-term private key opens
  every Level 1 message sealed to it.

**Level 2 — yes, in the post-quantum sense.**

- Each message is AES-256-GCM under a key derived by HKDF from one bank key. A
  quantum computer at best halves AES-256's strength, to about 128 bits, which
  is still safe.
- So Level 2 is exactly as safe as the bank is secret. A bank built by **BB84
  over email** is protected as well as ML-KEM is, because every leg is sealed
  to ML-KEM-768 + X25519 and signed. A bank copied by **link file** is sealed
  with AES under a random 160-bit code — quantum-resistant, provided the code
  itself travels safely.
- The Key Manager is **simulated**: random keys, and a BB84 "channel" that is
  ordinary email. That is post-quantum security, not the physics-based
  guarantee real QKD hardware would give.
- Keys are deleted as mail opens, so a stolen phone cannot reopen what it
  already read, except through the local archive.
- When the recipients' keys are held, the message is also sealed to them with
  ML-KEM-768 + X25519. That does not add a *different* kind of quantum safety
  — a BB84 bank already rests on ML-KEM — but it means a bank that leaked some
  other way (a link file whose code was overheard, a copied phone) is not
  enough to read it.

**What both rest on.** ML-KEM-768 is NIST's standard (FIPS 203) and no quantum
or classical attack on it is known — but that is a well-studied assumption, not
a proof, and it is younger than the algorithms it replaces. Pairing it with
X25519 means an attacker has to break both. The detail is in
[post-quantum.md](post-quantum.md#what-ml-kem-768-rests-on).

---

## Things true at every level

**1. Your mail is never sent in the clear.** Covered above — hold, block, or
send correctly sealed. There is no fourth option.

**2. The subject line is always encrypted.** Every level uses the same
placeholder subject, `[Encrypted message]`. The real subject lives inside the
encrypted part, along with the body and any attachment filenames. This also
means your inbox, notification rules and the spam engine treat every level
identically without being told anything.

**3. Level 2 archives locally, because it can only be opened once.**
Their keys are destroyed as the message opens. Without a local copy, reading an
email would be the last time you ever saw it. So CryptMail keeps its own
**sealed** copy on your device, written *before* the message is sent and again
the moment one is opened. That archive never leaves the phone, never evicts, and
travels with you when you move to a new device. It also keeps mail you read
with the removed Levels 3 and 4, which nothing else can open any more.

**4. Key discovery never touches the network.** CryptMail does not query key
servers or WKD, in any build. A key reaches your device only from someone who
wrote to you, or by manual import. This was turned off after a directory served
a superseded key for a test account and the resulting message could not be
opened by anyone — exactly the kind of silent failure this app exists to avoid.

**5. Moving to a new phone moves everything, and moves it once.** Your key,
archive and key bank transfer together under a one-time code. The old phone
stops sending with quantum keys — the new phone sends under the same ID, and
two phones sending as one would seal two messages with the same AES key. The
old phone can still *read*.

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
- **Level 2 authenticates but does not sign.**
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
| **ML-KEM-768** | NIST's standardised post-quantum key-agreement algorithm (FIPS 203), built on a lattice problem. |
| **X25519** | The well-tested classical key-agreement algorithm it is paired with. |
| **AES-256-GCM** | Standard strong cipher that also detects tampering. |
| **HKDF** | Turns one secret into other well-shaped keys. |
| **One-time pad** | Combine the message with random key of equal length; unbreakable if the key is random, secret and used once. The removed Level 3. |
| **QKD** | Quantum Key Distribution — producing shared secret keys over a quantum channel. |
| **BB84** | The original QKD protocol, from 1984. |
| **Key bank / Key Manager** | The store of shared secret keys Level 2 draws from. |
| **SAE ID** | The identifier naming one end of a key-manager link. Level 2 mixes the sender's into each message's AES key. |
| **Autocrypt** | Attaching your public key to outgoing mail so recipients gain it automatically. |

---

*Sources in this repo: [`app/src/core/qkd.ts`](../app/src/core/qkd.ts) ·
[QKD levels design](superpowers/specs/2026-09-20-qkd-levels-design.md) ·
[per-email keys design](superpowers/specs/2026-09-19-per-email-keys-design.md) (removed) ·
[encryption.md](encryption.md) · [key-management.md](key-management.md) ·
[message-format.md](message-format.md)*
