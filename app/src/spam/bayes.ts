/**
 * The personal half of the filter: a Naive Bayes classifier that learns from
 * this user's corrections and nobody else's.
 *
 * ## Why Bayes at all, when there are rules
 *
 * The rules in `headers.ts`, `content.ts` and `urls.ts` encode what spam looks
 * like *in general*. They cannot know that this particular user reads three
 * cryptocurrency newsletters on purpose, or that their accountant really does
 * send "URGENT: invoice attached" every month. Only corrections can teach that,
 * and Bayes is the classical way to turn corrections into a score — Paul Graham's
 * "A Plan for Spam" is the origin, SpamAssassin's `BAYES_*` symbols are the same
 * idea in production.
 *
 * ## The shape of the model
 *
 * Two token→count tables and two message counts. That is the whole model, and it
 * is why it can live in sealed storage as a small JSON object: it holds *counts of
 * tokens*, never the messages they came from. A trained model cannot be read back
 * as mail.
 *
 * ## Three guards against overconfidence, which matter more than the maths
 *
 * A classifier trained on four messages will happily report probability 0.999,
 * and a filter that believes it will hide the user's mail. So:
 *
 * 1. **`MIN_TRAINED_MESSAGES`** — below 5 spam *and* 5 ham the model refuses to
 *    answer at all (`applies === false`), and the verdict falls back to rules
 *    only. A new install therefore behaves exactly as it did before the model
 *    existed, which is also the required "empty model" behaviour.
 * 2. **`interestingness` selection** — only the ~20 most decisive tokens vote.
 *    Graham's insight: a long message otherwise drowns its own signal in
 *    hundreds of neutral tokens, and the neutral tokens are precisely where a
 *    small corpus is least trustworthy.
 * 3. **Per-token probability clamping**, tightened while the corpus is small.
 *    With 5 examples no single token may claim more than 0.85; the cap relaxes
 *    towards 0.99 as evidence accumulates. This is what stops one lucky word in
 *    one training message from deciding every future verdict.
 *
 * ## Numerics
 *
 * Combination is done in log-odds rather than Graham's product-of-probabilities,
 * because a 20-term product of values near 0.01 underflows float64 to zero and
 * takes the verdict with it. Log-odds is the same function, computed in a range
 * the hardware can represent.
 */
import { countTokens, tokenize, type TokenizeInput } from './tokenize';

/**
 * Bumped only when a stored model can no longer be read. A mismatch is treated as
 * "no model" — never as an error to surface, and never as a reason to guess.
 */
export const SPAM_MODEL_VERSION = 1;

export type SpamModel = {
  version: number;
  /** Token → times it appeared in a message the user marked spam. */
  spam: Record<string, number>;
  ham: Record<string, number>;
  /** Messages trained, not tokens — the denominator for `P(token | class)`. */
  spamMessages: number;
  hamMessages: number;
  /** Millisecond epoch of the last training call. Diagnostic only. */
  updatedAt: number | null;
};

/** Both classes must reach this before the model is consulted. */
export const MIN_TRAINED_MESSAGES = 5;

/** How many of the most decisive tokens vote on a message. */
const MAX_VOTING_TOKENS = 20;

/**
 * A cap on how large the model may grow, and how it is trimmed.
 *
 * Unbounded growth is a real problem here: every training call adds the message's
 * vocabulary, so a few thousand corrections would put megabytes through the seal
 * on every save. When the vocabulary exceeds the cap, tokens seen exactly once are
 * dropped — the ones carrying least evidence, and the ones a re-encounter would
 * re-learn anyway.
 */
const MAX_VOCABULARY = 12_000;

/** Laplace smoothing: an unseen token gets this much presence, not zero. */
const SMOOTHING = 1;

/** A token needs this many sightings before it is allowed to vote. */
const MIN_TOKEN_SIGHTINGS = 2;

/** An empty model. The same value a corrupted load falls back to. */
export function emptyModel(): SpamModel {
  return { version: SPAM_MODEL_VERSION, spam: {}, ham: {}, spamMessages: 0, hamMessages: 0, updatedAt: null };
}

/**
 * Whether a value loaded from storage is a model this code can use.
 *
 * Written defensively because the input is a parsed JSON blob from disk: it may
 * be any shape at all, including one produced by a future version. Anything that
 * is not exactly right is rejected, and the caller substitutes an empty model
 * rather than trying to repair it — a half-read model would silently misclassify,
 * which is worse than starting over.
 */
export function isSpamModel(value: unknown): value is SpamModel {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.version !== SPAM_MODEL_VERSION) return false;
  if (!isCountTable(m.spam) || !isCountTable(m.ham)) return false;
  if (!isCount(m.spamMessages) || !isCount(m.hamMessages)) return false;
  if (m.updatedAt !== null && !isCount(m.updatedAt)) return false;
  return true;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isCountTable(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const count of Object.values(value as Record<string, unknown>)) {
    if (!isCount(count)) return false;
  }
  return true;
}

/** Whether the model has seen enough of both classes to be trusted. */
export const modelIsTrained = (model: SpamModel): boolean =>
  model.spamMessages >= MIN_TRAINED_MESSAGES && model.hamMessages >= MIN_TRAINED_MESSAGES;

/**
 * Fold one message into the model and return a new one.
 *
 * Pure: the input model is never mutated, which is what lets the caller treat a
 * failed save as "training did not happen" rather than leaving state and storage
 * disagreeing.
 *
 * Token *counts* within a message are collapsed to one increment per token
 * ("bitcoin" eleven times still trains once) because otherwise a single long
 * message would outweigh dozens of short ones. Repetition is evidence at scoring
 * time; it is distortion at training time.
 */
export function train(model: SpamModel, input: TokenizeInput, label: 'spam' | 'ham'): SpamModel {
  const tokens = Object.keys(countTokens(tokenize(input)));
  if (tokens.length === 0) return model;

  const table = { ...(label === 'spam' ? model.spam : model.ham) };
  for (const token of tokens) table[token] = (table[token] ?? 0) + 1;

  const next: SpamModel = {
    version: SPAM_MODEL_VERSION,
    spam: label === 'spam' ? table : { ...model.spam },
    ham: label === 'ham' ? table : { ...model.ham },
    spamMessages: model.spamMessages + (label === 'spam' ? 1 : 0),
    hamMessages: model.hamMessages + (label === 'ham' ? 1 : 0),
    updatedAt: Date.now(),
  };
  return prune(next);
}

/**
 * Undo one training example.
 *
 * Needed because a correction is often a *re*-correction: the user marks a
 * message spam, then marks it not-spam. Without untraining, the model would hold
 * both examples and learn that the message's vocabulary is evidence for
 * everything. Counts floor at zero so a double-untrain cannot corrupt the model.
 */
export function untrain(model: SpamModel, input: TokenizeInput, label: 'spam' | 'ham'): SpamModel {
  const messages = label === 'spam' ? model.spamMessages : model.hamMessages;
  if (messages <= 0) return model;

  const tokens = Object.keys(countTokens(tokenize(input)));
  const table = { ...(label === 'spam' ? model.spam : model.ham) };
  for (const token of tokens) {
    const next = (table[token] ?? 0) - 1;
    if (next > 0) table[token] = next;
    else delete table[token];
  }

  return {
    version: SPAM_MODEL_VERSION,
    spam: label === 'spam' ? table : { ...model.spam },
    ham: label === 'ham' ? table : { ...model.ham },
    spamMessages: model.spamMessages - (label === 'spam' ? 1 : 0),
    hamMessages: model.hamMessages - (label === 'ham' ? 1 : 0),
    updatedAt: Date.now(),
  };
}

/** Drop singleton tokens once the vocabulary outgrows the cap. */
function prune(model: SpamModel): SpamModel {
  const size = Object.keys(model.spam).length + Object.keys(model.ham).length;
  if (size <= MAX_VOCABULARY) return model;

  const keep = (table: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [token, count] of Object.entries(table)) if (count > 1) out[token] = count;
    return out;
  };
  return { ...model, spam: keep(model.spam), ham: keep(model.ham) };
}

/**
 * How far along the corpus is towards "enough evidence", in [0, 1].
 *
 * Zero at the minimum training size, one at 50 examples of each class. Both
 * confidence guards below are functions of it, so they relax together.
 */
function growthFactor(model: SpamModel): number {
  const examples = Math.min(model.spamMessages, model.hamMessages);
  return Math.min(1, Math.max(0, (examples - MIN_TRAINED_MESSAGES) / (50 - MIN_TRAINED_MESSAGES)));
}

/**
 * The ceiling on any single token's spamminess, as a function of corpus size.
 *
 * 0.85 at the minimum training size, rising to 0.99 once there are 50 examples of
 * each class. Symmetric at the bottom (`1 - cap`), so a token cannot be
 * overwhelming evidence of *ham* on thin data either.
 */
function confidenceCap(model: SpamModel): number {
  return 0.85 + growthFactor(model) * 0.14;
}

/**
 * The ceiling on the *combined* verdict, as a function of corpus size.
 *
 * `confidenceCap` bounds one token; it does not bound twenty of them. Twenty
 * tokens at 0.85 each sum to a log-odds near 35, which is 1.0 in float64 — so a
 * five-message corpus would report certainty even though no individual token was
 * allowed to. This is the guard that actually holds the line: 0.90 at the minimum
 * training size, relaxing to 0.999 once there are 50 examples of each class.
 *
 * 0.90 is not an arbitrary number. It is the probability at which `bayesWeight`
 * returns 2.14 — well short of its own ±3.0 ceiling, and comfortably short of the
 * 5.0 spam threshold. A model trained on ten messages therefore contributes real
 * evidence and cannot come close to deciding a verdict by itself.
 */
function verdictCap(model: SpamModel): number {
  return 0.9 + growthFactor(model) * 0.099;
}

/**
 * `P(spam | token)` for one token, Graham-style but rate-normalised.
 *
 * Dividing each raw count by its class's message total is what makes a user who
 * has marked 200 messages spam and 20 ham comparable to one who did the reverse.
 * Without it the model would simply learn whichever button was pressed more.
 */
function tokenProbability(model: SpamModel, token: string, cap: number): number | null {
  const spamHits = model.spam[token] ?? 0;
  const hamHits = model.ham[token] ?? 0;
  if (spamHits + hamHits < MIN_TOKEN_SIGHTINGS) return null;

  const spamRate = spamHits / Math.max(1, model.spamMessages);
  // Ham is weighted double, as in "A Plan for Spam": a false positive costs the
  // user a real message, a false negative costs them a delete.
  const hamRate = (2 * hamHits) / Math.max(1, model.hamMessages);
  const raw = (spamRate + SMOOTHING / Math.max(1, model.spamMessages + model.hamMessages))
    / (spamRate + hamRate + (2 * SMOOTHING) / Math.max(1, model.spamMessages + model.hamMessages));

  return Math.min(cap, Math.max(1 - cap, raw));
}

export type BayesResult = {
  /** False when the model is untrained; the caller must then ignore `probability`. */
  applies: boolean;
  /** Spam probability in [0, 1], or 0.5 when the model did not apply. */
  probability: number;
  /** How many tokens actually voted — useful in tests and diagnostics. */
  tokensUsed: number;
};

/**
 * The model's opinion of a message.
 *
 * Returns `applies: false` — not a guess — whenever the model has too little
 * training, or the message produced no token the model recognises. Both are
 * genuinely "no opinion", and reporting 0.5 as though it were a measurement would
 * let a neutral result drag a rules-based verdict around.
 */
export function classify(model: SpamModel, input: TokenizeInput): BayesResult {
  if (!modelIsTrained(model)) return { applies: false, probability: 0.5, tokensUsed: 0 };

  const cap = confidenceCap(model);
  const scored: { token: string; probability: number; interest: number }[] = [];
  for (const token of Object.keys(countTokens(tokenize(input)))) {
    const probability = tokenProbability(model, token, cap);
    if (probability === null) continue;
    scored.push({ token, probability, interest: Math.abs(probability - 0.5) });
  }
  if (scored.length === 0) return { applies: false, probability: 0.5, tokensUsed: 0 };

  scored.sort((a, b) => b.interest - a.interest || a.token.localeCompare(b.token));
  const voting = scored.slice(0, MAX_VOTING_TOKENS);

  // Sum of log-odds: equivalent to Graham's product form, but representable.
  let logOdds = 0;
  for (const { probability } of voting) logOdds += Math.log(probability / (1 - probability));
  const combined = 1 / (1 + Math.exp(-logOdds));

  // Clamped by corpus size, not just by float range: twenty capped tokens still
  // sum to certainty, and certainty on ten training messages is a lie.
  const ceiling = verdictCap(model);
  return {
    applies: true,
    probability: Math.min(ceiling, Math.max(1 - ceiling, combined)),
    tokensUsed: voting.length,
  };
}

/**
 * The Bayes contribution to the unified score, in the same units as the rule
 * weights.
 *
 * Deliberately modest — ±3.0 at the extremes against a spam threshold of 5.0 — so
 * a confident model still cannot classify alone. That is the specification's "no
 * single signal decides" applied to the learned half of the engine, and it is also
 * the honest position: a personal model trained on a few dozen messages is good
 * evidence, not proof.
 *
 * The dead zone between 0.35 and 0.65 contributes nothing at all: a model that is
 * unsure should be silent rather than nudging.
 */
export function bayesWeight(result: BayesResult): number {
  if (!result.applies) return 0;
  const p = result.probability;
  if (p >= 0.65) return Math.min(3.0, ((p - 0.65) / 0.35) * 3.0);
  if (p <= 0.35) return Math.max(-3.0, -((0.35 - p) / 0.35) * 3.0);
  return 0;
}

/** Total messages trained, for the settings/diagnostic copy. */
export const trainedCount = (model: SpamModel): number => model.spamMessages + model.hamMessages;
