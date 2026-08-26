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

1. **Is it spam?** → put it in **Spam**.
   *(Right now this check is switched off — it always says "no". Someone will
   build the real spam detector later.)*
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

There's no fancy AI here. It just lowercases the text and checks whether it
**contains** certain words from a list (for example, does the subject contain
the word `"invoice"`?). That's it — simple word-spotting. Because everything is
lowercased first, `INVOICE`, `Invoice`, and `invoice` all match.

Because it's just word-spotting, it can be fooled — an email from a person named
"Bill" might land in the **Bills** bucket. It's a helpful guess, not a guarantee.

## The privacy rule (the important bit)

Your encrypted emails are locked. The app can only read an encrypted email
**after you've opened it** on this device.

So the categorizer follows one firm rule:

- **Normal (unencrypted) email** → it reads the subject and preview text and
  sorts it.
- **Encrypted email you've already opened** → it reads the decrypted words and
  sorts it.
- **Encrypted email you haven't opened yet** → it **doesn't peek**. It leaves it
  in **Primary** until you open it.

In short: it never tries to guess a category from scrambled, locked text.

## What goes in, what comes out

**Goes in:** one email's basic info (its ID, subject, and preview text) plus a
lookup table of emails you've already unlocked on this device.

**Comes out:** just one word — the bucket name (`primary`, `bills`, etc.).

There's also a counter function that runs over your whole inbox and returns **how
many _unread_ emails are in each bucket** — those are the little number badges
you see next to each category. Already-read emails don't count toward the badge.

## How it connects to the app

Three small pieces tie it together:

- **The shared "which bucket am I viewing?" setting** — a single value that
  remembers the category you tapped. "All mail" means no filter. Both the menu
  and the inbox read from this same setting, so they always agree.

- **The side menu (Category Drawer)** — lists All mail plus the five buckets,
  each with an unread-count badge. Tap one and it (a) saves your choice to the
  shared setting and (b) closes the menu.

- **The inbox list (Inbox Screen)** — watches that shared setting. When a bucket
  is selected, it hides every email that doesn't belong to it, and shows the
  bucket's name as the title. There's an ✕ button to go back to "All mail".

The flow, start to finish:

```
You open the menu  →  tap "Bills"  →  the shared setting becomes "bills"
                                          ↓
              the inbox notices, and shows only emails sorted into Bills
```

## Things to keep in mind

- **It's a helpful guess, not perfect.** Word-spotting makes mistakes.
- **Spam doesn't work yet** — that bucket will always be empty for now.
- **It only changes what you _see_.** It never moves, deletes, or re-labels your
  actual email, and it never reads anything that's still locked.
- **It re-sorts on the fly** every time the inbox is shown — nothing is saved to
  disk.
