/**
 * The scorer: four sources of evidence in, one verdict out.
 *
 * ```
 *   headers.ts  ─┐
 *   content.ts  ─┼─▶  symbols  ─▶  score  ─▶  classification
 *   urls.ts     ─┤                    ▲
 *   bayes.ts    ─┘                    │
 *                              thresholds in types.ts
 * ```
 *
 * ## How a verdict is reached
 *
 * Every rule that fires contributes a named symbol with a weight. The weights sum.
 * `score >= SPAM_THRESHOLD` (5.0) is spam; `phishingScore >= PHISHING_THRESHOLD`
 * (4.0) is phishing-suspicious and takes precedence, because the two are different
 * warnings and the more specific one is the useful one.
 *
 * This is rspamd's model and SpamAssassin's, and the reason to copy it is that it
 * makes the filter *answerable*. When a message is misfiled the symbol list says
 * which rules fired and what each was worth, so the fix is a weight rather than a
 * guess. It is also the mechanism that satisfies the specification's central
 * requirement — no single rule is worth 5.0, so **nothing can classify a message
 * alone**, and "the word *verify* appears" cannot be a verdict no matter how the
 * rules grow.
 *
 * ## Phishing is not "spam, but worse"
 *
 * The two classifications are reached from disjoint evidence. Only symbols marked
 * `kind: 'phishing'` count towards `phishingScore`: broken authentication, a
 * display name claiming a brand its domain does not own, a link whose text lies
 * about its host, a filename written to display a false type. Bulk-mail symbols —
 * shouting, emoji, prize language, a shortened link — never contribute to it, so a
 * loud marketing email cannot become a phishing warning by accumulating enough
 * spam points.
 *
 * ## What the engine will not do
 *
 * - It never fetches, resolves, expands or previews anything. Every input is
 *   already on the device.
 * - It never evaluates markup or scripts; HTML reaches it as extracted text and
 *   `href`/label pairs.
 * - It reads attachment *metadata* only.
 * - It never throws. `classifyMessage` is called while an inbox row renders, so a
 *   malformed message must produce a verdict, not an exception. The guard is at
 *   the boundary here rather than duplicated in every rule.
 * - It sees only content already readable on this device. Ciphertext, and the
 *   provider's snippet of an encrypted message, are never classified — that
 *   boundary is enforced by the caller in `categorizer.ts` and is the reason
 *   `SpamInput` has no field for a raw message.
 */
import {
  bayesWeight,
  classify as classifyBayes,
  emptyModel,
  train as trainModel,
  untrain as untrainModel,
  type BayesResult,
  type SpamModel,
} from './bayes';
import { attachmentSymbols, contentSymbols } from './content';
import { headerSymbols } from './headers';
import type { TokenizeInput } from './tokenize';
import type { SpamClassification, SpamInput, SpamMark, SpamSymbol, SpamVerdict } from './types';
import { PHISHING_THRESHOLD, SPAM_THRESHOLD } from './types';
import { urlSymbols } from './urls';

/**
 * The part of a message the tokenizer may read.
 *
 * One function, used by both scoring and training, because the two must never
 * disagree about what a message *is*. If the body is absent here — an unopened
 * encrypted message — then it is neither scored nor learned from, and that
 * follows from the shape of the input rather than from two rules that happen to
 * agree.
 *
 * `returnPath` and `messageId` are deliberately absent: the tokenizer turns
 * headers into *facts* (`h:spf_pass`), and those two are per-message identifiers
 * that would fill the vocabulary with tokens that can never be seen twice.
 */
function tokenizeInputFor(input: SpamInput): TokenizeInput {
  return {
    subject: input.subject,
    body: input.body,
    from: input.from,
    links: input.links,
    headers: {
      replyTo: input.headers?.replyTo,
      listUnsubscribe: input.headers?.listUnsubscribe,
      authenticationResults: input.headers?.authenticationResults,
    },
  };
}

/**
 * Learn from a message the user classified themselves.
 *
 * Pure — it returns the new model and persists nothing, so the caller decides
 * when the training is durable. `unlearn` is its inverse, needed because a user
 * who reverses a mark must not leave the first verdict's counts behind: without
 * it, marking a message spam and then not-spam would train both directions and
 * teach the filter that its tokens mean nothing in particular.
 */
export const learn = (model: SpamModel, input: SpamInput, label: SpamMark): SpamModel =>
  trainModel(model, tokenizeInputFor(input), label);

export const unlearn = (model: SpamModel, input: SpamInput, label: SpamMark): SpamModel =>
  untrainModel(model, tokenizeInputFor(input), label);

/** A verdict for a message the user has explicitly marked. */
function overrideVerdict(mark: 'spam' | 'ham'): SpamVerdict {
  return {
    classification: mark === 'spam' ? 'spam' : 'legitimate',
    score: mark === 'spam' ? SPAM_THRESHOLD : 0,
    phishingScore: 0,
    symbols: [
      {
        name: mark === 'spam' ? 'USER_MARKED_SPAM' : 'USER_MARKED_HAM',
        weight: 0,
        kind: mark === 'spam' ? 'spam' : 'ham',
        detail: mark === 'spam' ? 'You marked this message as spam.' : 'You marked this message as not spam.',
      },
    ],
    bayesApplied: false,
    bayesProbability: null,
    overridden: true,
  };
}

export type ClassifyOptions = {
  /** The personal model. Omit, or pass an untrained one, for rules-only scoring. */
  model?: SpamModel;
  /**
   * The user's explicit mark for this message, if any. Short-circuits scoring
   * entirely: a human decision is not evidence to be weighed against rules.
   */
  mark?: 'spam' | 'ham' | null;
};

/**
 * Classify one message.
 *
 * The rule groups are independent and order-free; they are collected, not
 * chained, so a change to one cannot alter what another sees.
 */
export function classifyMessage(input: SpamInput, options: ClassifyOptions = {}): SpamVerdict {
  if (options.mark === 'spam' || options.mark === 'ham') return overrideVerdict(options.mark);

  let symbols: SpamSymbol[] = [];
  let bayes: BayesResult = { applies: false, probability: 0.5, tokensUsed: 0 };

  try {
    const safe = normalise(input);
    symbols = [
      ...headerSymbols(safe),
      ...contentSymbols(safe),
      ...urlSymbols(safe),
      ...attachmentSymbols(safe),
    ];

    const model = options.model ?? emptyModel();
    bayes = classifyBayes(model, tokenizeInputFor(safe));
    const weight = bayesWeight(bayes);
    if (weight !== 0) {
      symbols.push({
        name: weight > 0 ? 'BAYES_SPAM' : 'BAYES_HAM',
        weight,
        // Bayes never votes for *phishing*. It learns what this user considers
        // unwanted, which is a bulk-mail judgement; phishing must stay grounded in
        // structural evidence that a training accident cannot manufacture.
        kind: weight > 0 ? 'spam' : 'ham',
        detail:
          weight > 0
            ? 'Similar to messages you have marked as spam.'
            : 'Similar to messages you have marked as not spam.',
      });
    }
  } catch {
    // A rule threw on hostile input. The message is not evidence of anything, and
    // an inbox that renders is worth more than a verdict — so: no symbols, no
    // classification, and the mail stays visible.
    return {
      classification: 'legitimate',
      score: 0,
      phishingScore: 0,
      symbols: [],
      bayesApplied: false,
      bayesProbability: null,
      overridden: false,
    };
  }

  const score = round(symbols.reduce((total, symbol) => total + symbol.weight, 0));
  // Phishing evidence, minus the evidence that positively rules impersonation
  // out. Only symbols that opted in with `counterPhishing` are subtracted —
  // in practice the authentication credits — because a general ham credit is a
  // statement about bulk mail and this score is about identity. See
  // `SpamSymbol.counterPhishing`.
  const phishingScore = round(
    symbols.reduce(
      (total, symbol) =>
        total + (symbol.kind === 'phishing' || (symbol.kind === 'ham' && symbol.counterPhishing) ? symbol.weight : 0),
      0,
    ),
  );

  return {
    classification: verdictFor(score, phishingScore),
    score,
    phishingScore,
    symbols: symbols.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.name.localeCompare(b.name)),
    bayesApplied: bayes.applies,
    bayesProbability: bayes.applies ? round(bayes.probability, 4) : null,
    overridden: false,
  };
}

/**
 * Score and phishing-score to a classification.
 *
 * Phishing is checked first and independently. A message can be phishing-suspicious
 * on a total score below the spam threshold — a well-written impersonation is not
 * spammy in the bulk-mail sense at all, which is exactly why the two thresholds
 * are separate numbers.
 */
function verdictFor(score: number, phishingScore: number): SpamClassification {
  if (phishingScore >= PHISHING_THRESHOLD) return 'phishing-suspicious';
  if (score >= SPAM_THRESHOLD) return 'spam';
  return 'legitimate';
}

const round = (value: number, places = 2): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Coerce an input of unknown provenance into one the rules can trust.
 *
 * The rules are already written defensively, but they are written against a
 * *shape*. This is the one place that guarantees the shape: strings are strings,
 * arrays are arrays, and anything else becomes absent. It exists because the input
 * is assembled from provider JSON and from a parsed MIME tree, neither of which is
 * under this app's control.
 */
function normalise(input: SpamInput): SpamInput {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;

  const from = input.from && typeof input.from === 'object' ? input.from : undefined;
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : undefined;

  return {
    from: from
      ? { address: typeof from.address === 'string' ? from.address : '', name: text(from.name) }
      : undefined,
    to: Array.isArray(input.to) ? input.to.filter((value): value is string => typeof value === 'string') : undefined,
    subject: text(input.subject),
    body: text(input.body),
    links: Array.isArray(input.links)
      ? input.links.filter(
          (link): link is { href: string; text: string } =>
            !!link && typeof link === 'object' && typeof link.href === 'string',
        )
      : undefined,
    headers: headers
      ? {
          replyTo: text(headers.replyTo),
          authenticationResults: text(headers.authenticationResults),
          listUnsubscribe: text(headers.listUnsubscribe),
          returnPath: text(headers.returnPath),
          received: text(headers.received),
          messageId: text(headers.messageId),
        }
      : undefined,
    attachments: Array.isArray(input.attachments)
      ? input.attachments.filter((meta): meta is NonNullable<SpamInput['attachments']>[number] => !!meta && typeof meta === 'object')
      : undefined,
    selfAddress: text(input.selfAddress),
  };
}

/** Whether a verdict should keep a message out of the primary inbox. */
export const isUnwanted = (verdict: SpamVerdict): boolean =>
  verdict.classification === 'spam' || verdict.classification === 'phishing-suspicious';

/**
 * The one-line reason to show a user, or null when there is nothing to say.
 *
 * The heaviest symbol that carries a `detail`, which is the rule that did most to
 * reach the verdict. Symbols without a `detail` are the small structural ones that
 * would mean nothing to a reader.
 */
export function topReason(verdict: SpamVerdict): string | null {
  for (const symbol of verdict.symbols) {
    if (symbol.weight > 0 && symbol.detail) return symbol.detail;
  }
  return null;
}

/** Up to `limit` reasons, heaviest first — for the details sheet. */
export function reasons(verdict: SpamVerdict, limit = 4): string[] {
  const out: string[] = [];
  for (const symbol of verdict.symbols) {
    if (symbol.weight <= 0 || !symbol.detail) continue;
    if (out.includes(symbol.detail)) continue;
    out.push(symbol.detail);
    if (out.length >= limit) break;
  }
  return out;
}

export { emptyModel, isSpamModel, MIN_TRAINED_MESSAGES, modelIsTrained, SPAM_MODEL_VERSION, train, trainedCount, untrain } from './bayes';
export type { SpamModel } from './bayes';
export { extractLinks } from './urls';
export type { SpamClassification, SpamInput, SpamMark, SpamSymbol, SpamVerdict, LinkPair } from './types';
export { PHISHING_THRESHOLD, SPAM_THRESHOLD } from './types';
