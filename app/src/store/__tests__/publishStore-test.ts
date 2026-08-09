/**
 * The publish record, read against the key this device actually holds.
 *
 * The case that matters is a restored or regenerated identity: a record about
 * some *other* fingerprint says nothing about this one, and treating it as
 * though it did would leave senders fetching a key this device cannot read.
 */
import { PublishState, publishStatusFor } from '../publishStore';

const FP = 'AAAA1111BBBB2222';
const OTHER = 'CCCC3333DDDD4444';

const state = (over: Partial<PublishState> = {}): PublishState => ({
  status: 'published',
  fingerprint: FP,
  updatedAt: '2026-08-09T12:00:00.000Z',
  ...over,
});

describe('publishStatusFor', () => {
  it('reports the stored status for the key it describes', () => {
    expect(publishStatusFor(state(), FP)).toBe('published');
    expect(publishStatusFor(state({ status: 'pending' }), FP)).toBe('pending');
  });

  it('reports unpublished for a different key', () => {
    expect(publishStatusFor(state(), OTHER)).toBe('unpublished');
  });

  it('does not carry a refusal across to a different key', () => {
    // Declining to list one key is not a decision about another one.
    expect(publishStatusFor(state({ status: 'declined' }), OTHER)).toBe('unpublished');
    expect(publishStatusFor(state({ status: 'declined' }), FP)).toBe('declined');
  });

  it('reports unpublished when there is no key at all', () => {
    expect(publishStatusFor(state(), null)).toBe('unpublished');
  });
});
