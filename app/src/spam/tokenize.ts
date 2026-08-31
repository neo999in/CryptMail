/**
 * Turning a message into the tokens the Bayes classifier counts.
 *
 * Tokenization is most of what makes a Bayesian spam filter work, which is why
 * this is its own module with its own tests. Two decisions matter more than the
 * rest:
 *
 * **Tokens are namespaced by where they came from.** The word "invoice" in a
 * subject line is a different piece of evidence from the same word in a body, and
 * a sender domain is different again. Prefixing (`s:invoice`, `d:shop.example`)
 * lets one flat token table hold all of them without a subject word being
 * confused for a body word — Paul Graham's "A Plan for Spam" observes the same
 * thing, and SpamAssassin's Bayes does it too.
 *
 * **Case is folded but shape is kept.** `FREE` and `free` are the same word, so
 * they share a token; the fact that a *subject* was shouted is a rules-side
 * signal (`content.ts`) rather than a token, because otherwise every caps-locked
 * legitimate mail poisons the model with a token nobody can ever un-learn.
 *
 * Nothing here is security-sensitive on its own, but it is fed attacker-supplied
 * text on every call, so it is written to be linear-time and allocation-bounded:
 * no backtracking regexes, and a cap on how much of a body is read.
 */
import { hostOf } from '../lib/links';
import { registrableDomain } from './unicode';

/**
 * How much body text is tokenized.
 *
 * A 4 MB newsletter and its first 20 000 characters classify the same, and the
 * cap is what stops a hostile message from making an inbox render slow.
 */
const MAX_BODY_CHARS = 20_000;

/** Tokens shorter than this carry no signal and are extremely common. */
const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 24;

/**
 * Words too common in *both* classes to help.
 *
 * A short list on purpose: Bayes handles uninformative words correctly by giving
 * them probabilities near 0.5, so aggressive stop-listing removes signal for no
 * gain. These are here to keep the model small, not to steer it.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'from', 'have',
  'has', 'not', 'but', 'are', 'was', 'were', 'will', 'would', 'can', 'could',
  'all', 'any', 'our', 'out', 'get', 'about', 'they', 'them', 'their', 'there',
  'been', 'more', 'when', 'what', 'who', 'why', 'how', 'its', 'it\'s',
]);

/**
 * Phrases worth a token of their own.
 *
 * A bigram is evidence a unigram is not: "click here" and "wire transfer" say
 * something neither word says alone, and this is where the specification's "do
 * not classify on the presence of the word *account*" is answered in the learning
 * half of the engine — the model learns phrases, so a single word cannot carry a
 * verdict by itself.
 */
const PHRASES = [
  'click here', 'act now', 'limited time', 'verify your account', 'confirm your account',
  'update your account', 'account suspended', 'account has been suspended', 'suspended account',
  'unusual activity', 'suspicious activity', 'log in to', 'sign in to', 'confirm your identity',
  'verify your identity', 'security alert', 'password expire', 'password will expire',
  'reset your password', 'wire transfer', 'bank transfer', 'gift card', 'gift cards',
  'you have won', 'you won', 'free money', 'risk free', 'no risk', 'money back',
  'guaranteed income', 'work from home', 'make money', 'double your', 'crypto investment',
  'investment opportunity', 'unclaimed funds', 'next of kin', 'lottery winner',
  'dear customer', 'dear user', 'dear valued', 'valued customer', 'final notice',
  'last warning', 'immediate action', 'action required', 'urgent action', 'within 24 hours',
  'within 48 hours', 'expires today', 'expire today', 'confirm payment', 'payment failed',
  'payment declined', 'invoice attached', 'unsubscribe here',
];

/** Split on anything that is not a word character, an apostrophe, or a digit. */
const WORD_SPLIT = /[^\p{L}\p{N}'$%]+/u;

/**
 * Words from a chunk of text, lowercased, filtered and length-capped.
 *
 * Exported because both the tokenizer and the content rules need the same notion
 * of "a word", and two notions would drift.
 */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(WORD_SPLIT)) {
    const word = raw.replace(/^'+|'+$/g, '');
    if (word.length < MIN_TOKEN_LENGTH || word.length > MAX_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(word)) continue;
    // A number on its own is noise; a number *with* a currency or percent mark
    // is not, and the split above keeps `$` and `%` attached.
    if (/^\d+$/.test(word)) continue;
    out.push(word);
  }
  return out;
}

/** Phrase tokens present in already-lowercased text. */
function phrases(lowered: string): string[] {
  return PHRASES.filter((phrase) => lowered.includes(phrase)).map((phrase) => `p:${phrase.replace(/ /g, '_')}`);
}

/**
 * What the classifier is trained and scored on.
 *
 * Deliberately takes the same `SpamInput`-shaped fields the rules do, but only
 * the ones that survive being stored as *counts*: a token table holds words, not
 * sentences, which is how the model can be persisted without keeping a copy of
 * the mail (see the note in `store/spamModelStore.ts`).
 */
export type TokenizeInput = {
  subject?: string;
  body?: string;
  from?: { address: string; name?: string };
  links?: { href: string; text: string }[];
  headers?: { replyTo?: string; listUnsubscribe?: string; authenticationResults?: string };
};

/**
 * The token multiset for a message.
 *
 * Duplicates are kept: a body that says "bitcoin" eleven times is stronger
 * evidence than one that says it once, and the counts are what `bayes.ts`
 * consumes. Callers that want set semantics can dedupe.
 */
export function tokenize(input: TokenizeInput): string[] {
  const tokens: string[] = [];

  const subject = (input.subject ?? '').slice(0, 1000);
  if (subject) {
    for (const word of words(subject)) tokens.push(`s:${word}`);
    for (const phrase of phrases(subject.toLowerCase())) tokens.push(`s${phrase}`);
  }

  const body = (input.body ?? '').slice(0, MAX_BODY_CHARS);
  if (body) {
    for (const word of words(body)) tokens.push(`b:${word}`);
    for (const phrase of phrases(body.toLowerCase())) tokens.push(`b${phrase}`);
  }

  const address = input.from?.address?.trim().toLowerCase() ?? '';
  if (address) {
    tokens.push(`f:${address}`);
    const at = address.lastIndexOf('@');
    if (at !== -1) {
      const domain = address.slice(at + 1);
      if (domain) {
        tokens.push(`d:${domain}`);
        const registrable = registrableDomain(domain);
        if (registrable && registrable !== domain) tokens.push(`d:${registrable}`);
      }
    }
  }
  // The display name is where impersonation is written, so it is its own
  // namespace: "PayPal Security" as a name is not the same token as the word
  // "paypal" in a body.
  for (const word of words(input.from?.name ?? '')) tokens.push(`n:${word}`);

  // Link *hosts*, never whole URLs: a URL carries a per-recipient tracking id, so
  // training on it would fill the model with tokens that can never recur.
  const seenHosts = new Set<string>();
  for (const link of input.links ?? []) {
    const host = hostOf(link.href);
    if (!host || seenHosts.has(host)) continue;
    seenHosts.add(host);
    tokens.push(`u:${host}`);
    const registrable = registrableDomain(host);
    if (registrable && registrable !== host) tokens.push(`u:${registrable}`);
  }

  // Header *facts*, not header values. Whether a message carried unsubscribe
  // hygiene is learnable; the mailing-list id in it is not.
  if (input.headers?.listUnsubscribe) tokens.push('h:has_list_unsubscribe');
  if (input.headers?.replyTo) tokens.push('h:has_reply_to');
  const auth = (input.headers?.authenticationResults ?? '').toLowerCase();
  if (auth.includes('dkim=pass')) tokens.push('h:dkim_pass');
  if (auth.includes('dkim=fail')) tokens.push('h:dkim_fail');
  if (auth.includes('spf=pass')) tokens.push('h:spf_pass');
  if (auth.includes('spf=fail')) tokens.push('h:spf_fail');
  if (auth.includes('dmarc=pass')) tokens.push('h:dmarc_pass');
  if (auth.includes('dmarc=fail')) tokens.push('h:dmarc_fail');

  return tokens;
}

/** Token → occurrence count, which is the shape training folds into the model. */
export function countTokens(tokens: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokens) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}
