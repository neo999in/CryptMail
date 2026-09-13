import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CannedReply,
  cannedReplyLabel,
  loadCannedReplies,
  MAX_CANNED_BODY_LENGTH,
  MAX_CANNED_REPLIES,
  normaliseCannedReplies,
  removeCannedReply,
  saveCannedReplies,
  upsertCannedReply,
} from '../cannedRepliesStore';
import { initLocalCrypto, resetLocalCryptoForTests, SecretStore } from '../localCrypto';

function memoryStore(): SecretStore {
  const data: Record<string, string> = {};
  return {
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

const reply = (id: string, body = `text ${id}`, title = ''): CannedReply => ({
  id,
  title,
  body,
  updatedAt: '2026-09-13T10:00:00.000Z',
});

describe('normaliseCannedReplies', () => {
  it('reads anything that is not a list as none', () => {
    expect(normaliseCannedReplies(null)).toEqual([]);
    expect(normaliseCannedReplies({ a: 1 })).toEqual([]);
  });

  it('drops a malformed entry on its own and keeps the rest in order', () => {
    const out = normaliseCannedReplies([reply('a'), { id: 'b' }, 7, reply('c'), { ...reply('d'), body: '   ' }]);
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('keeps the first of a duplicated id', () => {
    expect(normaliseCannedReplies([reply('a', 'first'), reply('a', 'second')])).toEqual([reply('a', 'first')]);
  });

  it('clamps lengths and count', () => {
    const long = normaliseCannedReplies([reply('a', 'x'.repeat(MAX_CANNED_BODY_LENGTH + 10), 't'.repeat(200))]);
    expect(long[0].body).toHaveLength(MAX_CANNED_BODY_LENGTH);
    expect(long[0].title.length).toBeLessThanOrEqual(80);
    const many = Array.from({ length: MAX_CANNED_REPLIES + 5 }, (_, i) => reply(`r${i}`));
    expect(normaliseCannedReplies(many)).toHaveLength(MAX_CANNED_REPLIES);
  });
});

describe('upsertCannedReply / removeCannedReply', () => {
  it('appends a new reply and replaces one in place', () => {
    let list = upsertCannedReply([], reply('a'));
    list = upsertCannedReply(list, reply('b'));
    list = upsertCannedReply(list, reply('a', 'edited', '  Name  '));
    expect(list.map((r) => [r.id, r.body, r.title])).toEqual([
      ['a', 'edited', 'Name'],
      ['b', 'text b', ''],
    ]);
  });

  it('refuses an empty reply with a sentence', () => {
    expect(() => upsertCannedReply([], reply('a', '  '))).toThrow(/needs some text/);
  });

  it('refuses one past the cap, but still allows editing at the cap', () => {
    const full = Array.from({ length: MAX_CANNED_REPLIES }, (_, i) => reply(`r${i}`));
    expect(() => upsertCannedReply(full, reply('new'))).toThrow(/up to/);
    expect(upsertCannedReply(full, reply('r0', 'changed'))[0].body).toBe('changed');
  });

  it('removes by id and ignores a missing one', () => {
    expect(removeCannedReply([reply('a'), reply('b')], 'a').map((r) => r.id)).toEqual(['b']);
    expect(removeCannedReply([reply('a')], 'zzz')).toHaveLength(1);
  });
});

describe('cannedReplyLabel', () => {
  it('is the title, else the first line of the text', () => {
    expect(cannedReplyLabel({ title: 'Thanks', body: 'x' })).toBe('Thanks');
    expect(cannedReplyLabel({ title: ' ', body: '\nFirst line\nsecond' })).toBe('First line');
  });
});

describe('canned replies persistence', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetLocalCryptoForTests();
    await initLocalCrypto(memoryStore(), 'keystore');
  });

  it('round-trips through the sealed store', async () => {
    expect(await loadCannedReplies()).toEqual([]);
    await saveCannedReplies([reply('a'), reply('b', 'Hello\nthere', 'Greeting')]);
    expect(await loadCannedReplies()).toEqual([reply('a'), reply('b', 'Hello\nthere', 'Greeting')]);
  });
});
