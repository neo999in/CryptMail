# The Email Categorizer — Explained Simply

This is the plain-language version of [`CATEGORIZER.md`](./CATEGORIZER.md). Same
engine, fewer technical words.

## What it does (in one sentence)

It looks at each email and drops it into one of five buckets — **Primary,
Purchases, Bills, Promotions, or Spam** — so your inbox can group mail the way
Gmail does.

## How it decides a bucket

Think of it like a bouncer with a checklist. For each email, it reads the text
and asks these questions **in order**, and stops at the first "yes":

1. **Is it spam or a phishing attempt?** → put it in **Spam**.
   *(This one isn't word-spotting. It's a separate detector with its own
   explanation — see [the spam section below](#the-spam-check-in-plain-words).)*
2. **Does it mention money owed?** (words like *invoice*, *bill*, *payment due*)
   → **Bills**.
3. **Did you buy something?** (words like *your order*, *receipt*, *shipped*,
   *tracking*) → **Purchases**.
4. **Is it an ad?** (words like *sale*, *% off*, *coupon*, *unsubscribe*)
   → **Promotions**.
5. **None of the above?** → **Primary** (the default — normal mail from people).

The **order matters**. An email that's both a bill *and* an ad counts as a
**Bill**, because that question comes first. That's on purpose.

### How the "reading" actually works

For the four shopping-and-money buckets there's no fancy AI. It just lowercases
the text and checks whether it **contains** certain words from a list (for
example, does the subject contain the word `"invoice"`?). That's it — simple
word-spotting. Because everything is lowercased first, `INVOICE`, `Invoice`, and
`invoice` all match.

Because it's just word-spotting, it can be fooled — an email from a person named
"Bill" might land in the **Bills** bucket. It's a helpful guess, not a guarantee.

The spam check is deliberately *not* built this way, for exactly that reason. An
email that says "verify your account" might be a phishing attack or it might be
your bank; a word list can't tell the difference, and getting that wrong hides
real mail.

## The spam check, in plain words

Spam and phishing are decided by a separate detector that adds up **evidence**
instead of spotting words.

### It's a points system

Each suspicious thing the detector notices is worth some points. It adds them up.
Cross one line and the email is **spam**; cross a different line and it's
**phishing-suspicious**.

The important part: **nothing is worth enough points on its own.** One suspicious
thing is never enough — it takes a combination. That's what stops an honest email
that happens to say "payment" from being hidden.

### What it looks at

Four kinds of evidence:

- **Who really sent it.** Email carries stamps from the mail system saying whether
  the sender is genuinely who they claim (the technical names are SPF, DKIM and
  DMARC). A failed stamp is real evidence. A **missing** stamp is not — plenty of
  ordinary email has none, so missing never counts against a message.
- **How it's written.** Not single words, but *combinations* — urgency plus a
  password request, a threat to close your account plus a link, a prize plus a
  demand for secrecy. Also things like shouting in all caps, and characters that
  are invisible or that look like letters but aren't (a trick for disguising
  words).
- **Where its links go.** Whether a link's visible text says one website while the
  link actually goes to another (the clearest lie there is), whether the address
  is a bare string of numbers, whether the domain is a near-copy of a famous one
  (`paypa1.com`), whether one website's address is hidden inside another's.
- **What you've taught it.** See below.

It also glances at attachment **names and types** — a file called
`invoice.pdf.exe`, for example. It never opens one.

### Spam and phishing are different answers

"Spam" means unwanted bulk mail — a loud newsletter, a get-rich-quick pitch.
"Phishing-suspicious" means someone may be **pretending to be someone else** to
get your password or your money.

They're kept genuinely separate: shouting and prize language can never add up to a
phishing warning, no matter how much of it there is. Only impersonation evidence
counts towards that.

### It learns from you

There are **Mark as spam** and **Mark as not spam** buttons when you open a
message.

- Your mark always wins. If you say a message isn't spam, it isn't — the detector
  doesn't get a vote on that message any more.
- Marking also *teaches* it, so similar mail is handled the way you'd want next
  time.
- If you change your mind, it properly **unlearns** the first answer instead of
  just voting the other way — otherwise it would end up having learned that those
  words mean nothing at all.
- What it learns is saved (locked, like everything else the app stores) and is
  still there after you restart.
- It stays modest early on. A handful of examples can't make it confident; that
  only comes with a reasonable amount of your own feedback.

### What it will never do

- **It never visits a link** to find out where it goes. Everything is worked out
  from the letters in the address, on your phone. Clicking a link to "just check"
  would tell a spammer their email was read.
- It never runs anything from an email, never loads pictures or pages from a
  sender's website to make its decision, and never opens an attachment.
- It never sends any part of your mail anywhere. There's no server involved.
- **It never reads a locked email** it hasn't been allowed to see (next section).

## The privacy rule (the important bit)

Your encrypted emails are locked. The app can only read an encrypted email
**after you've opened it** on this device.

So the categorizer follows one firm rule:

- **Normal (unencrypted) email** → it reads the subject and preview text and
  sorts it.
- **Encrypted email you've already opened** → it reads the decrypted words and
  sorts it.
- **Encrypted email you haven't opened yet** → it **doesn't peek** at the message.
  It stays in **Primary**.

In short: it never tries to guess a category from scrambled, locked text. And
when you mark a locked message you haven't opened, the detector only learns from
the unlocked parts too — never from the scrambled text.

There's one thing it *can* still see on a locked email: the delivery information
on the outside of the envelope — who it claims to be from, and whether the mail
system's stamps checked out. That part was never encrypted. So a locked message
can still be flagged as spam if the envelope itself is clearly forged, even though
nobody has read a word of it. This matters more here than in most apps: your
provider can't scan your encrypted mail either, so if this app didn't look at the
envelope, nothing would be checking it at all.

## What goes in, what comes out

**Goes in:** one email's basic info (its ID, subject, preview text, sender, and
the delivery stamps from the outside of the envelope), plus a lookup table of
emails you've already unlocked on this device. Optionally: what the detector has
learned from you, and your marks.

**Comes out:** just one word — the bucket name (`primary`, `bills`, etc.). A
second function returns the full spam verdict instead, including *why* — that's
what produces the explanation you see when you open a flagged message.

There's also a counter function that runs over your whole inbox and returns **how
many _unread_ emails are in each bucket** — those are the little number badges
you see next to each category. Already-read emails don't count toward the badge.

## How it connects to the app

Four small pieces tie it together:

- **The shared "which bucket am I viewing?" setting** — a single value that
  remembers the category you tapped. "All mail" means no filter. Both the menu
  and the inbox read from this same setting, so they always agree.

- **The side menu (Category Drawer)** — lists All mail plus the five buckets,
  each with an unread-count badge. Tap one and it (a) saves your choice to the
  shared setting and (b) closes the menu.

- **The inbox list (Inbox Screen)** — watches that shared setting. When a bucket
  is selected, it hides every email that doesn't belong to it, and shows the
  bucket's name as the title. There's an ✕ button to go back to "All mail".

- **The open message (Message Screen)** — shows the warning notice and the
  **Mark as spam** / **Mark as not spam** buttons. It asks the same question the
  inbox did, so the notice can never disagree with the bucket. It has one extra
  piece of evidence the inbox row didn't: now that the message is open, it can see
  what each link *says* versus where it actually goes.

The flow, start to finish:

```
You open the menu  →  tap "Bills"  →  the shared setting becomes "bills"
                                          ↓
              the inbox notices, and shows only emails sorted into Bills
```

## Things to keep in mind

- **It's a helpful guess, not perfect.** Word-spotting makes mistakes in the four
  shopping-and-money buckets, and the spam detector will occasionally get one
  wrong in either direction. That's what the two mark buttons are for.
- **Spam and phishing are one bucket but two warnings.** Both land in **Spam**;
  the message itself tells you which it was, and why.
- **English only, for now.** Both the word lists and the spam detector's
  writing-style checks are written for English text.
- **It only changes what you _see_.** It never moves, deletes, or re-labels your
  actual email, and it never reads anything that's still locked.
- **It re-sorts on the fly** every time the inbox is shown — nothing is saved to
  disk. The one exception is your own marks and what they taught the detector,
  which are saved (locked) so they survive a restart.
