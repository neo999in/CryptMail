import { describeCheck } from '../checkResult';

describe('describeCheck', () => {
  test('says nobody has published a key when the directory answered', () => {
    const result = describeCheck(['ada@example.com'], []);
    expect(result.kind).toBe('no-key');
    expect(result.text).toContain('ada@example.com has not published a key yet');
    expect(result.text).toContain('stays queued');
  });

  test('names every address without a key, read aloud', () => {
    const { text } = describeCheck(['ada@example.com', 'bob@example.com'], []);
    expect(text).toContain('ada@example.com and bob@example.com have not published a key yet');
  });

  /**
   * The distinction this module exists for: a lookup that failed is a fault on
   * our side, not evidence that the recipient does not use encryption.
   */
  test('reports a failed lookup as our failure, not as their absence', () => {
    const result = describeCheck(['ada@example.com'], ['ada@example.com']);
    expect(result.kind).toBe('unreachable');
    expect(result.text).toContain("Couldn't reach the key directory");
    expect(result.text).not.toContain('has not published a key');
  });

  test('matches addresses regardless of case or padding', () => {
    expect(describeCheck(['Ada@Example.com'], [' ada@example.com '])).toMatchObject({ kind: 'unreachable' });
  });

  test('reports both when one lookup failed and another answered', () => {
    const { kind, text } = describeCheck(['ada@example.com', 'bob@example.com'], ['ada@example.com']);
    expect(kind).toBe('unreachable');
    expect(text).toContain("Couldn't reach the key directory for ada@example.com");
    expect(text).toContain('bob@example.com has not published a key yet either');
  });

  test('an unrelated failed lookup does not change the answer about a recipient', () => {
    expect(describeCheck(['ada@example.com'], ['someone.else@example.com'])).toMatchObject({ kind: 'no-key' });
  });

  test('still says something when there is nothing to name', () => {
    const { kind, text } = describeCheck([], []);
    expect(kind).toBe('no-key');
    expect(text).toContain('Still waiting');
  });
});
