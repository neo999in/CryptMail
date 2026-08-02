# Roadmap

Phased plan from a provable MVP to a hardened product. Each phase is shippable.

## Phase 0 — Proof of concept (spike)

Goal: prove the core claim end-to-end on one platform, one provider.

- [ ] Desktop shell (Tauri or Electron) with a minimal inbox + compose UI.
- [ ] Gmail OAuth (PKCE) + Gmail API read/send (or IMAP/SMTP XOAUTH2).
- [ ] Local keypair generation (Curve25519) via the chosen OpenPGP lib.
- [ ] Encrypt/sign outgoing mail as PGP/MIME; decrypt/verify incoming.
- [ ] Manual public-key import (paste) to unblock testing between two accounts.

**Done when:** you send from account A to account B, Gmail's web UI shows
ciphertext, and CipherMail on B shows the plaintext.

## Phase 1 — MVP

Goal: the seamless experience for two CipherMail users.

- [ ] Autocrypt headers on send; auto-cache received keys.
- [ ] Backend **key directory** (publish/lookup) with address ownership proof.
- [ ] Discovery pipeline: keyring → Autocrypt → directory → WKD.
- [ ] Encrypted subject (protected headers) + encrypted attachments.
- [ ] Encryption-status UI per recipient; fail-safe send (no silent plaintext).
- [ ] Encrypted local store (SQLCipher) + OS keychain for the wrapped key.
- [ ] Recovery code flow + encrypted key backup.
- [ ] Outlook/Graph provider connector.

**Done when:** two users who have emailed once can exchange encrypted mail with no
manual key steps, and a lost device can be recovered.

## Phase 2 — Reach & robustness

- [ ] Generic IMAP/SMTP connector (iCloud, Yahoo, Fastmail, custom).
- [ ] Mobile apps (iOS/Android) with Keychain/Keystore + push relay.
- [ ] Multi-device sync + device approval.
- [ ] Secure-link fallback for key-less recipients (web reader).
- [ ] Key rotation, expiry, revocation flows.
- [ ] Search over locally-decrypted mail.

## Phase 3 — Hardening & trust

- [ ] Fingerprint/safety-number verification UX (QR in person).
- [ ] Key transparency log for the directory (CONIKS/KT-style).
- [ ] Independent security audit of the crypto core.
- [ ] Google/Microsoft OAuth app verification + CASA security assessment.
- [ ] "No plaintext cache" high-security mode; auto-lock.
- [ ] Responsible-disclosure program.

## Phase 4 — Beyond v1 (exploratory)

- [ ] Modern non-PGP scheme option (X25519 + XChaCha20-Poly1305) with a migration
      path.
- [ ] Better forward secrecy investigation (ratcheting where feasible).
- [ ] Enterprise/admin features (policy, provisioning) — mindful of the E2EE vs.
      archival tension in [security.md](security.md).
- [ ] Interop testing with Thunderbird/Proton/GnuPG.

## Cross-cutting, from day one

- Keep the **crypto core** a standalone, auditable, well-specified module.
- Write conformance tests against the [message-format.md](message-format.md) spec.
- Treat metadata limits and recovery limits as **explicit product copy**, not fine
  print.
- Budget early for provider app-verification timelines (they gate production).

## Key risks to track

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Provider OAuth verification delays | Blocks production launch | Start Google/MS verification in Phase 1 |
| Key substitution on unverified keys | MITM | Verification UX + key transparency (Phase 3) |
| Users losing recovery codes | Permanent data loss | Clear onboarding, optional device-approval backup |
| PGP UX complexity | Adoption | Autocrypt-first, hide crypto details by default |
| No forward secrecy | Long-term key compromise | Rotation now; ratcheting research later |

---

# Backlog — candidate features (beyond the committed phases)

The phases above are the committed path and are deliberately security-first. This
section is the wider catalogue: everything worth considering, so the roadmap
doubles as a complete feature map rather than only the critical path.

> **See also [features.md](features.md)** — the implementation-oriented register
> of the same ground, organised by *what is blocking each feature* (buildable
> today / needs the Rust core / needs a backend / needs a new platform), with
> build sketches against the actual codebase and a record of what has shipped.
> This section stays the strategic view; that file is the working one.

Each item is tagged:

- 🆕 **net-new** — not yet anywhere in the phases above.
- 📋 **planned (Phase N)** — already tracked; listed so the map is complete.

**Impact** and **effort** are rough (S / M / L) from the perspective of a small
team. They are a starting point for prioritisation, not estimates.

## What I'd build next (and why)

The phases correctly front-load the cryptographic plumbing — the product claim is
worthless if the envelope or key exchange is wrong. But two honest gaps sit
*outside* that plan:

1. **As an _email client_, the app is thin.** No threading, search, attachments,
   or drafts. Enthusiasts will tolerate a bare client to get encryption; nobody
   else will.
2. **Adoption is the existential risk, not the crypto.** The entire design
   assumes both people run CipherMail. Getting the *second* person there is
   still unsolved.

If I could add only five things after the Phase 0 proof, in this order:

1. **Autocrypt auto key-exchange** — 📋 Phase 1, but pull it forward.
   [prototype-plan.md](prototype-plan.md) already calls it the "closest call" to
   pull into the prototype. It removes manual key pasting — the single most
   obviously unshippable seam — and it's cheap in rPGP. *Impact L · Effort S.*
2. **Encrypted local store (SQLCipher)** — 📋 Phase 1. Right now cached plaintext
   sits unencrypted on disk (the prototype's own "known debt"), directly
   contradicting [security.md](security.md). Unglamorous, but it gates shipping
   to any real user. *Impact M · Effort S–M.*
3. **Threading + attachment UX** — 🆕. The two table stakes whose absence makes
   this "not an email client." Attachment *crypto* is planned; the *experience*
   (compose, inline images, preview, the >1 MB bridge path) is not.
   *Impact L · Effort M.*
4. **Search with an encrypted local index** — 🆕 twist on 📋 Phase 2. Search is
   planned "over decrypted mail," but doing it over a *plaintext* cache fights
   the high-security (no-plaintext-cache) mode. An encrypted index lets search
   and privacy coexist. *Impact M · Effort M.*
5. **Import existing PGP keys + a recovery-code drill** — 🆕. Two cheap wins:
   importing GnuPG/Thunderbird keys converts the existing PGP crowd into day-one
   users, and a "prove you saved your recovery code" step at onboarding de-risks
   the permanent-data-loss failure mode that [security.md](security.md) flags as
   the top *user* risk. *Impact M · Effort S.*

**Two bigger bets to keep on the radar:**

- ⭐ **Browser extension that decrypts in place inside Gmail / Outlook web** (🆕).
  It inverts the adoption problem: instead of asking people to switch clients,
  you meet them in the one they already use and turn the ciphertext block into
  readable text right in the Gmail tab. The highest ceiling of anything here —
  and the largest and most strategically loaded (new surface, new web threat
  model). Not "next," but the thing to prototype the moment the core is stable.
- **Remote-content / tracking-pixel blocking + image proxy** (🆕). A privacy
  client that silently loads tracking pixels undercuts its own promise. Table
  stakes for the audience CipherMail is courting; modest effort.

## The full catalogue

### 1. Email-client table stakes

The roadmap is security-heavy and thin here. Most of this is what a user
*expects* from any mail app; its absence caps adoption regardless of how good the
crypto is.

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Threading / conversation view | 🆕 | L | M | `In-Reply-To`/`References` are already in the clear ([message-format.md](message-format.md)); group on them. |
| Rich-text / HTML compose + reader | 🆕 | M | M | Sanitise inbound HTML hard; it's an XSS/exfil surface even when decrypted. |
| Attachment UX (send, inline images, preview) | 🆕 | L | M | Crypto is 📋 Phase 1; the *experience* and the >1 MB bridge/streaming path are not. |
| Encrypted drafts + autosave | 🆕 | M | S | Store as ciphertext; a draft is plaintext-at-rest otherwise. |
| Scheduled send / send later | 🆕 | M | S | Local queue; must survive app kill. |
| Snooze | 🆕 | S | S | Client-side; provider can't do it for encrypted mail. |
| Undo send | 🆕 | S | S | Hold-then-release window before the connector fires. |
| Labels / archive / star / bulk + swipe actions | 🆕 | M | M | Maps to `updateFlags` in the connector interface. |
| **Client-side filters / rules** | 🆕 | M | M | Server can't read content, so rules (auto-label, mute, forward) must run locally after decrypt. |
| Multiple accounts + unified inbox | 🆕 | M | M | Data model already keys on `account_id`. |
| Address book / contacts + per-contact trust | 🆕 | M | M | Surfaces `contact_keys.trust` where the user picks recipients. |
| Signatures (email sig) & templates / canned replies | 🆕 | S | S | Quality-of-life; low risk. |

### 2. Privacy & metadata hardening

Beyond the encryption already specced — closing the gaps [security.md](security.md)
is honest about.

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Remote-content / tracking-pixel blocking + image proxy | 🆕 | M | M | Default-off remote images; proxy on request. Core to the privacy promise. |
| Message size padding | 🆕 | S | S | security.md admits size is a metadata leak; pad to buckets to blunt size fingerprinting. |
| Expiring / self-destruct messages | 🆕 | M | M | Client-enforced (honest about its limits) + shorter TTL on secure links. |
| Header minimisation on send | 🆕 | S | S | Strip `User-Agent`/`X-Mailer`/client fingerprints from outgoing MIME. |
| Encrypted local search index | 🆕 | M | M | See "next 5" — lets search coexist with no-plaintext-cache mode. |
| Signature-only (sign, don't encrypt) mode | 🆕 | S | S | For broadcast / mailing lists / recipients with no key but who still verify. |

### 3. Trust, verification & anti-abuse

Deepens the Phase 3 verification story and closes the abuse gaps E2EE opens up.

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Fingerprint / QR safety-number verification | 📋 Phase 3 | L | M | The durable defence against key substitution. |
| Contact trust dashboard | 🆕 | M | S | One place to see seen/verified/changed across all contacts. |
| SAS "verify over a call/video" | 🆕 | S | M | Short authentication string for people who won't scan QR in person. |
| **Client-side spam / malware scanning** | 🆕 | M | L | security.md flags that E2EE kills server-side scanning — a real gap. Scan after local decrypt. |
| Report phishing / block sender | 🆕 | M | S | Basic safety hygiene; feeds a local blocklist. |
| Proof-of-work + rate limits on secure-link & directory lookups | 🆕 | M | M | Blunts enumeration of the key directory and abuse of the link relay. |

### 4. Onboarding, recovery & growth

Directly attacks the adoption risk and the "lost everything" failure mode.

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Guided setup + recovery-code ceremony | 📋 Phase 1 | L | M | Recovery limits must be product copy, not fine print (roadmap cross-cutting). |
| **"Test your recovery code" drill** | 🆕 | M | S | Force a real unlock-with-code at onboarding so users learn *before* they need it. |
| **Import existing PGP keys** (GnuPG / Thunderbird) | 🆕 | M | S | Instantly onboards the existing PGP crowd as power users. |
| Invite flow for key-less recipients | 📋 partial | M | S | Mentioned as a fallback in [encryption.md](encryption.md); make it a first-class flow. |
| Encrypted-by-default nudges when both sides are users | 🆕 | M | S | Turn an Autocrypt round-trip into a visible "you two are now encrypted" moment. |
| QR "add me" contact cards | 🆕 | S | S | Distinct from verification QR; for fast in-person key + address exchange. |

### 5. Reach — platforms & surfaces

The prototype is Android-only; the architecture already imagines more.

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Desktop app (Tauri) | 📋 partial | L | L | In Phase 0/architecture, but the prototype pivoted mobile-first — effectively unbuilt. |
| iOS app | 📋 Phase 2 | L | L | Keychain/Secure Enclave for the wrapped key. |
| Web PWA | 📋 partial | M | L | Architecture lists it; big threat-model implications for key storage in a browser. |
| ⭐ **Browser extension (decrypt inside Gmail/Outlook web)** | 🆕 | L | L | The highest-ceiling adoption play — see "bigger bets" above. |
| Home-screen widgets / watch app | 🆕 | S | M | Must respect privacy-preserving notifications (below). |

### 6. Notifications & background sync

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Push relay | 📋 Phase 2 | L | M | Payload carries "new mail" only, never content ([api.md](api.md)). |
| **Privacy-preserving notifications** | 🆕 | M | S | Never leak subject/sender to the OS lock screen; fetch+decrypt then optionally reveal. |
| VIP / priority alerts | 🆕 | S | S | Per-contact notification rules, evaluated locally. |
| Battery-aware background sync scheduling | 🆕 | S | M | Coalesce fetches; respect Doze / low-power. |

### 7. Multi-account, identities & interop

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Send-as / aliases | 🆕 | M | M | One account, multiple From addresses. |
| Multiple identities (separate keypairs) | 🆕 | S | M | Data model already allows N `identity_keys` per account. |
| Publish own key via WKD / keyserver | 🆕 | S | M | WKD *lookup* is planned; *publishing* aids interop with non-users. |
| Sign / verify / encrypt arbitrary files | 🆕 | S | S | Reuses the core; useful power-user surface. |
| S/MIME support | 🆕 | M | L | Enterprise-interop alternative to PGP; large surface. |
| Interop test suite (Thunderbird / Proton / GnuPG) | 📋 Phase 4 | M | M | Protected-headers behaviour varies across clients. |

### 8. Reliability, storage & sync

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| SQLCipher encrypted store | 📋 Phase 1 | M | S–M | See "next 5"; blocks shipping. |
| Encrypted attachment blob store | 🆕 | M | M | Keep large decrypted blobs off plain disk; stream from Rust. |
| Cache eviction / storage management | 🆕 | S | S | Bound the plaintext cache; user-visible "clear cached bodies." |
| Multi-device flag-conflict resolution | 🆕 | S | M | Read/label state can diverge across devices; needs a merge rule. |
| Full mailbox export / backup | 🆕 | M | M | Decrypted, user-controlled archive — the honest answer to "no server-side archival." |

### 9. Accessibility, i18n & polish

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Screen-reader / dynamic-type / high-contrast | 🆕 | M | M | Trust badges must be conveyed non-visually too. |
| Localisation + RTL | 🆕 | M | M | Security copy is the hardest and most important to translate well. |
| Theming (light/dark, custom) | 🆕 | S | S | AuroraBackground already exists; formalise tokens. |
| Motion & haptics | 🆕 | S | S | Restrained; reinforce state changes (locked, verified). |

### 10. Product quality (not user-facing, but load-bearing for a crypto app)

| Feature | Status | Impact | Effort | Notes |
|---|---|---|---|---|
| Test suite + **conformance tests vs message-format.md** | 📋 partial | L | M | Roadmap names conformance tests as cross-cutting; the app currently has none. |
| MIME-parser fuzzing | 🆕 | M | M | The parser eats attacker-controlled bytes; fuzz it. |
| Opt-in, privacy-first telemetry & crash reporting | 🆕 | M | M | Must never exfiltrate content or metadata; local-first, aggregate-only. |
| Reproducible builds | 🆕 | M | M | Lets others verify the shipped binary matches audited source — trust multiplier. |

## Impact × effort at a glance

Quick-win quadrant (high impact, low-ish effort) — where to look first:

| | Low effort | Medium effort | High effort |
|---|---|---|---|
| **High impact** | Autocrypt (📋1), SQLCipher (📋1) | Threading, Attachment UX, Encrypted search, Conformance tests | Browser extension ⭐, Desktop, iOS |
| **Medium impact** | Recovery drill, Import PGP keys, Scheduled send, Privacy notifications | Filters/rules, Remote-content blocking, Contact trust dashboard, Mailbox export | S/MIME, Web PWA |
| **Lower impact** | Undo/snooze, Signatures, Padding, Header minimisation | SAS verify, VIP alerts, Multiple identities | — |

> These are candidates, not commitments. When one is picked up, run it through
> [brainstorming → spec → plan] like anything else, and fold the accepted ones
> back into the phases above.

