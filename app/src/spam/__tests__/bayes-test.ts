/**
 * The personal model, and above all its refusals.
 *
 * Most of these tests are about what the classifier does *not* do. A Bayesian
 * filter that answers confidently on four training messages will hide a user's
 * mail, so the guards — untrained means no opinion, only decisive tokens vote,
 * per-token probability is capped while the corpus is small — are the behaviour
 * worth pinning down. The maths underneath is textbook; the restraint is not.
 */
import {
  bayesWeight,
  classify,
  emptyModel,
  isSpamModel,
  MIN_TRAINED_MESSAGES,
  modelIsTrained,
  SPAM_MODEL_VERSION,
  train,
  trainedCount,
  untrain,
  type SpamModel,
} from '../bayes';
import type { TokenizeInput } from '../tokenize';

/** A spam-shaped training message, distinct per index so vocabularies overlap. */
const spamMessage = (n: number): TokenizeInput => ({
  subject: `Claim your lottery prize ${n}`,
  body:
    'You have won the international lottery. To claim your prize send a processing ' +
    `fee by wire transfer to our agent. Reference ${n}. Bitcoin accepted.`,
  from: { address: `agent${n}@lotto-claims.example`, name: 'Prize Department' },
});

const hamMessage = (n: number): TokenizeInput => ({
  subject: `Sprint planning notes ${n}`,
  body:
    'Here are the notes from planning. We agreed to move the migration to next ' +
    `week and Priya will own the rollout checklist. Item ${n} is still open.`,
  from: { address: `priya@northgate-eng.example`, name: 'Priya Raman' },
});

/** A model trained on `spam` spam messages and `ham` ham messages. */
function trained(spam: number, ham: number): SpamModel {
  let model = emptyModel();
  for (let i = 0; i < spam; i += 1) model = train(model, spamMessage(i), 'spam');
  for (let i = 0; i < ham; i += 1) model = train(model, hamMessage(i), 'ham');
  return model;
}

describe('the empty model', () => {
  it('has both tables empty, no messages, and no timestamp', () => {
    const model = emptyModel();
    expect(model).toEqual({
      version: SPAM_MODEL_VERSION,
      spam: {},
      ham: {},
      spamMessages: 0,
      hamMessages: 0,
      updatedAt: null,
    });
  });

  it('is not trained, and offers no opinion on anything', () => {
    expect(modelIsTrained(emptyModel())).toBe(false);
    const result = classify(emptyModel(), spamMessage(1));
    expect(result.applies).toBe(false);
    expect(result.tokensUsed).toBe(0);
    expect(bayesWeight(result)).toBe(0);
  });
});

describe('training', () => {
  it('records tokens for the class it was told, and leaves the other alone', () => {
    const model = train(emptyModel(), spamMessage(1), 'spam');
    expect(model.spamMessages).toBe(1);
    expect(model.hamMessages).toBe(0);
    expect(Object.keys(model.spam).length).toBeGreaterThan(0);
    expect(model.ham).toEqual({});
  });

  it('does not mutate the model it was given', () => {
    const before = emptyModel();
    const snapshot = JSON.stringify(before);
    train(before, spamMessage(1), 'spam');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('counts a repeated token once per message, not once per occurrence', () => {
    // "bitcoin" eleven times in one mail is repetition, not eleven examples.
    const body = new Array(11).fill('bitcoin wallet').join(' ');
    const model = train(emptyModel(), { subject: 'x', body }, 'spam');
    expect(model.spam['b:bitcoin']).toBe(1);
  });

  it('is incremental: the same message twice counts twice', () => {
    let model = train(emptyModel(), spamMessage(1), 'spam');
    model = train(model, spamMessage(1), 'spam');
    expect(model.spamMessages).toBe(2);
    expect(model.spam['b:lottery']).toBe(2);
  });

  it('stamps the training time', () => {
    expect(train(emptyModel(), spamMessage(1), 'spam').updatedAt).toEqual(expect.any(Number));
  });

  it('ignores a message that produces no tokens at all', () => {
    const model = train(emptyModel(), { subject: '', body: '' }, 'spam');
    expect(model).toEqual(emptyModel());
  });
});

describe('untraining', () => {
  it('reverses a training example exactly', () => {
    const before = train(emptyModel(), hamMessage(1), 'ham');
    const after = untrain(train(before, spamMessage(1), 'spam'), spamMessage(1), 'spam');
    expect(after.spamMessages).toBe(before.spamMessages);
    expect(after.spam).toEqual(before.spam);
  });

  it('deletes a token rather than leaving a zero behind', () => {
    const model = untrain(train(emptyModel(), spamMessage(1), 'spam'), spamMessage(1), 'spam');
    expect(model.spam['b:lottery']).toBeUndefined();
  });

  it('floors at zero: untraining an untrained class changes nothing', () => {
    const model = untrain(emptyModel(), spamMessage(1), 'spam');
    expect(model.spamMessages).toBe(0);
    expect(model).toEqual(emptyModel());
  });

  it('leaves counts non-negative when untrained more often than trained', () => {
    let model = train(emptyModel(), spamMessage(1), 'spam');
    model = untrain(model, spamMessage(1), 'spam');
    model = untrain(model, spamMessage(1), 'spam');
    expect(model.spamMessages).toBe(0);
    for (const count of Object.values(model.spam)) expect(count).toBeGreaterThan(0);
  });
});

describe('the minimum-training guard', () => {
  it('refuses while either class is below the minimum', () => {
    expect(classify(trained(MIN_TRAINED_MESSAGES, MIN_TRAINED_MESSAGES - 1), spamMessage(0)).applies).toBe(false);
    expect(classify(trained(MIN_TRAINED_MESSAGES - 1, MIN_TRAINED_MESSAGES), spamMessage(0)).applies).toBe(false);
  });

  it('answers once both classes reach it', () => {
    expect(classify(trained(MIN_TRAINED_MESSAGES, MIN_TRAINED_MESSAGES), spamMessage(0)).applies).toBe(true);
  });

  it('a lopsided corpus does not simply learn whichever button was pressed more', () => {
    // 40 spam against 5 ham: rate-normalisation is what keeps a plainly hammy
    // message from being dragged spamwards by the imbalance.
    const model = trained(40, 5);
    expect(classify(model, hamMessage(0)).probability).toBeLessThan(0.5);
  });
});

describe('classification', () => {
  it('scores a message like the spam it was trained on above the ham it was not', () => {
    const model = trained(8, 8);
    const spam = classify(model, spamMessage(0));
    const ham = classify(model, hamMessage(0));
    expect(spam.applies && ham.applies).toBe(true);
    expect(spam.probability).toBeGreaterThan(ham.probability);
    expect(spam.probability).toBeGreaterThan(0.5);
    expect(ham.probability).toBeLessThan(0.5);
  });

  it('has no opinion on a message with no token it recognises', () => {
    const result = classify(trained(8, 8), {
      subject: 'Tide table',
      body: 'Kayaks racked afterwards.',
      from: { address: 'sam@riverclub.example' },
    });
    expect(result.applies).toBe(false);
    expect(result.probability).toBe(0.5);
  });

  it('never returns a probability outside the clamped range', () => {
    const model = trained(30, 30);
    for (const input of [spamMessage(0), hamMessage(0), spamMessage(99), hamMessage(99)]) {
      const { probability } = classify(model, input);
      expect(probability).toBeGreaterThanOrEqual(0.001);
      expect(probability).toBeLessThanOrEqual(0.999);
    }
  });

  it('votes with at most twenty tokens however long the message', () => {
    const model = trained(10, 10);
    const long = { ...spamMessage(0), body: new Array(50).fill(spamMessage(0).body).join(' ') };
    expect(classify(model, long).tokensUsed).toBeLessThanOrEqual(20);
  });

  it('is not overconfident on a corpus at the minimum size', () => {
    // Five and five is the smallest corpus the model will speak on, and on the
    // very messages it memorised it must still stop short of certainty.
    const thin = classify(trained(5, 5), spamMessage(0));
    const thick = classify(trained(60, 60), spamMessage(0));
    expect(thin.probability).toBeLessThan(0.999);
    expect(thick.probability).toBeGreaterThan(thin.probability);
  });
});

describe('bayesWeight', () => {
  it('is zero for no opinion', () => {
    expect(bayesWeight({ applies: false, probability: 0.99, tokensUsed: 0 })).toBe(0);
  });

  it('is zero inside the dead zone', () => {
    for (const probability of [0.36, 0.5, 0.64]) {
      expect(bayesWeight({ applies: true, probability, tokensUsed: 5 })).toBe(0);
    }
  });

  it('is capped at ±3.0, which is below the spam threshold on its own', () => {
    expect(bayesWeight({ applies: true, probability: 1, tokensUsed: 5 })).toBeCloseTo(3.0);
    expect(bayesWeight({ applies: true, probability: 0, tokensUsed: 5 })).toBeCloseTo(-3.0);
  });

  it('grows with confidence', () => {
    const low = bayesWeight({ applies: true, probability: 0.75, tokensUsed: 5 });
    const high = bayesWeight({ applies: true, probability: 0.95, tokensUsed: 5 });
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });
});

describe('isSpamModel', () => {
  it('accepts a model this code produced', () => {
    expect(isSpamModel(emptyModel())).toBe(true);
    expect(isSpamModel(trained(2, 2))).toBe(true);
  });

  it('rejects a different version, so a future model reads as no model', () => {
    expect(isSpamModel({ ...emptyModel(), version: SPAM_MODEL_VERSION + 1 })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), version: '1' })).toBe(false);
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 0, '', 'model', true, []]) {
      expect(isSpamModel(value)).toBe(false);
    }
  });

  it('rejects a corrupted count table', () => {
    expect(isSpamModel({ ...emptyModel(), spam: { 'b:x': 'many' } })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), spam: { 'b:x': -1 } })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), spam: { 'b:x': Number.NaN } })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), ham: [] })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), ham: null })).toBe(false);
  });

  it('rejects corrupted message counts and timestamps', () => {
    expect(isSpamModel({ ...emptyModel(), spamMessages: -3 })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), hamMessages: 'lots' })).toBe(false);
    expect(isSpamModel({ ...emptyModel(), updatedAt: 'yesterday' })).toBe(false);
  });

  it('survives a round trip through JSON, which is how it is stored', () => {
    const model = trained(6, 6);
    expect(isSpamModel(JSON.parse(JSON.stringify(model)))).toBe(true);
  });
});

describe('trainedCount', () => {
  it('is the total of both classes', () => {
    expect(trainedCount(emptyModel())).toBe(0);
    expect(trainedCount(trained(3, 4))).toBe(7);
  });
});
