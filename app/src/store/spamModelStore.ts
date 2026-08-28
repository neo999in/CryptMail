/**
 * Persistence for the personal spam model and the user's explicit marks.
 *
 * ## What is stored, and what deliberately is not
 *
 * The model is **token counts**, never messages. `tokenize.ts` reduces a mail to
 * words, phrases, sender domains, link *hosts* and header *facts*; this file
 * stores how often each of those was seen in a message the user marked spam or
 * not-spam. A trained model cannot be read back as mail — there is no order, no
 * punctuation, no addressee, no full URL and no body.
 *
 * That is a data-minimisation decision, not an accident of the algorithm. The
 * specification asks not to persist complete bodies for machine learning, and
 * `searchIndex.ts` — which *does* hold decrypted subjects and bodies — remains
 * the only store that does.
 *
 * The marks are `message id → 'spam' | 'ham'`. An id and a one-word verdict, no
 * content. They exist because a user's decision must survive a restart: a message
 * they moved out of spam must not silently move back the next time the app opens.
 *
 * ## Sealed, and validated on the way in
 *
 * It goes through `secureJson` like every other store, so it is encrypted at rest
 * under the device DEK, and its key is registered in `SEALED_STORE_KEYS`
 * (`store/index.ts`) so an install that predates the feature gets swept into the
 * seal at boot.
 *
 * `loadJson` already guards missing keys and unparseable JSON. What it cannot know
 * is whether the parsed object is *this* shape — a truncated write, a hand-edited
 * value or a model from a future version would all parse as JSON and then poison
 * every verdict. So the load path validates structurally and falls back to an
 * empty model on anything unexpected. Losing a training corpus is recoverable by
 * marking a few more messages; a half-read one misfiles mail silently.
 */
import { emptyModel, isSpamModel, type SpamModel } from '../spam/bayes';
import type { SpamMark } from '../spam/types';
import { loadJson, saveJson } from './secureJson';

export const SPAM_STORE_KEY = 'cryptmail.spam.v1';

/**
 * Everything the spam engine persists.
 *
 * One record rather than two stores: the marks and the model are written together
 * on every correction, and splitting them would allow a state where a message is
 * marked spam but the model never learned it.
 */
export type SpamState = {
  model: SpamModel;
  /** Message id → the user's explicit verdict. */
  marks: Record<string, SpamMark>;
};

/**
 * How many marks are kept.
 *
 * Marks are unbounded in principle — one per message the user ever corrected — and
 * a mailbox is unbounded too. The model has already learned from every one of
 * them; a mark's only remaining job is to override the score for a message still
 * in the mailbox. Trimming the oldest is therefore lossless for training and
 * merely means a very old message would be re-scored by rules if it were opened
 * again.
 *
 * `Record` preserves insertion order for string keys, which is what makes "oldest"
 * meaningful here without storing a timestamp per mark.
 */
const MAX_MARKS = 2_000;

export const emptySpamState = (): SpamState => ({ model: emptyModel(), marks: {} });

export async function loadSpamState(): Promise<SpamState> {
  const raw = await loadJson<unknown>(SPAM_STORE_KEY, null);
  return normaliseSpamState(raw);
}

export async function saveSpamState(state: SpamState): Promise<void> {
  await saveJson(SPAM_STORE_KEY, { model: state.model, marks: trimMarks(state.marks) });
}

/**
 * Coerce whatever was on disk into a usable `SpamState`.
 *
 * Exported so the tests can assert the recovery behaviour directly, without
 * needing to stage a corrupted value through AsyncStorage.
 *
 * The two halves are validated independently: a corrupted model with intact marks
 * keeps the marks, because the user's own decisions are the part that cannot be
 * regenerated.
 */
export function normaliseSpamState(value: unknown): SpamState {
  if (typeof value !== 'object' || value === null) return emptySpamState();
  const record = value as Record<string, unknown>;
  return {
    model: isSpamModel(record.model) ? (record.model as SpamModel) : emptyModel(),
    marks: readMarks(record.marks),
  };
}

function readMarks(value: unknown): Record<string, SpamMark> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, SpamMark> = {};
  for (const [id, mark] of Object.entries(value as Record<string, unknown>)) {
    if (!id) continue;
    if (mark === 'spam' || mark === 'ham') out[id] = mark;
  }
  return out;
}

function trimMarks(marks: Record<string, SpamMark>): Record<string, SpamMark> {
  const ids = Object.keys(marks);
  if (ids.length <= MAX_MARKS) return marks;
  const out: Record<string, SpamMark> = {};
  for (const id of ids.slice(ids.length - MAX_MARKS)) out[id] = marks[id];
  return out;
}

/** Set or clear one message's mark (pure). */
export function setMark(marks: Record<string, SpamMark>, id: string, mark: SpamMark | null): Record<string, SpamMark> {
  if (!id) return marks;
  if (mark === null) {
    if (!(id in marks)) return marks;
    const out = { ...marks };
    delete out[id];
    return out;
  }
  // Re-inserting moves the id to the end of the insertion order, which is what
  // makes `trimMarks` drop genuinely stale marks rather than recently-touched ones.
  const out = { ...marks };
  delete out[id];
  out[id] = mark;
  return out;
}
