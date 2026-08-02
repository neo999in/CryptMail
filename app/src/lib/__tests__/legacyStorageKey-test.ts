import { getItemMigrating, KeyValueStore, legacyKeyFor } from '../legacyStorageKey';

/** In-memory KeyValueStore that records the calls the migration makes. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const removed: string[] = [];
  const store: KeyValueStore = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
      removed.push(key);
    },
  };
  return { store, data, removed };
}

describe('legacyKeyFor', () => {
  test('maps a cryptmail key back to its pre-rename name', () => {
    expect(legacyKeyFor('cryptmail.keyring.v1')).toBe('ciphermail.keyring.v1');
  });

  test('maps per-address keys too', () => {
    expect(legacyKeyFor('cryptmail.demo.identity.ada@example.com')).toBe(
      'ciphermail.demo.identity.ada@example.com',
    );
  });

  test('leaves a key without the prefix alone', () => {
    expect(legacyKeyFor('something.else')).toBe('something.else');
  });
});

describe('getItemMigrating', () => {
  test('returns the current value without touching the old key', async () => {
    const { store, data, removed } = fakeStore({
      'cryptmail.keyring.v1': '{"new":1}',
      'ciphermail.keyring.v1': '{"old":1}',
    });

    await expect(getItemMigrating(store, 'cryptmail.keyring.v1')).resolves.toBe('{"new":1}');
    expect(data.get('ciphermail.keyring.v1')).toBe('{"old":1}');
    expect(removed).toEqual([]);
  });

  test('carries a pre-rename value over and deletes the old key', async () => {
    const { store, data, removed } = fakeStore({ 'ciphermail.keyring.v1': '{"old":1}' });

    await expect(getItemMigrating(store, 'cryptmail.keyring.v1')).resolves.toBe('{"old":1}');
    expect(data.get('cryptmail.keyring.v1')).toBe('{"old":1}');
    expect(data.has('ciphermail.keyring.v1')).toBe(false);
    expect(removed).toEqual(['ciphermail.keyring.v1']);
  });

  test('migrates only once — the second read comes straight from the new key', async () => {
    const { store, removed } = fakeStore({ 'ciphermail.drafts.v1': '{"d":1}' });

    await getItemMigrating(store, 'cryptmail.drafts.v1');
    await expect(getItemMigrating(store, 'cryptmail.drafts.v1')).resolves.toBe('{"d":1}');
    expect(removed).toEqual(['ciphermail.drafts.v1']);
  });

  test('returns null when neither key holds a value', async () => {
    const { store } = fakeStore();
    await expect(getItemMigrating(store, 'cryptmail.outbox.v1')).resolves.toBeNull();
  });

  test('does not look for a legacy twin of an unprefixed key', async () => {
    const { store } = fakeStore({ 'other.key': 'v' });
    await expect(getItemMigrating(store, 'unprefixed')).resolves.toBeNull();
  });

  test('still returns the data when clearing the old key fails', async () => {
    const { store } = fakeStore({ 'ciphermail.keyring.v1': '{"old":1}' });
    store.removeItem = async () => {
      throw new Error('keystore unavailable');
    };

    await expect(getItemMigrating(store, 'cryptmail.keyring.v1')).resolves.toBe('{"old":1}');
  });
});
