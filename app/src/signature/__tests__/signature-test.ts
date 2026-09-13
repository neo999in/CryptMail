import {
  defaultInsertionPoint,
  insertSnippet,
  isOnlySignature,
  seedBody,
  signatureBlock,
  swapSignature,
} from '../signature';

describe('signatureBlock', () => {
  it('is the RFC 3676 separator and the text, after a blank line', () => {
    expect(signatureBlock('Kabir')).toBe('\n\n-- \nKabir');
  });

  it('is nothing for no signature, or only whitespace', () => {
    expect(signatureBlock('')).toBe('');
    expect(signatureBlock(undefined)).toBe('');
    expect(signatureBlock('  \n ')).toBe('');
  });

  it('drops trailing whitespace but keeps the signature’s own lines', () => {
    expect(signatureBlock('Kabir\n  CryptMail\n\n')).toBe('\n\n-- \nKabir\n  CryptMail');
  });
});

describe('seedBody', () => {
  it('opens a new message with the signature', () => {
    expect(seedBody('Kabir')).toBe('\n\n-- \nKabir');
  });

  it('puts the signature above the quoted text of a reply', () => {
    const quoted = '\n\nOn Tue, A <a@x> wrote:\n> hi';
    expect(seedBody('Kabir', quoted)).toBe(`\n\n-- \nKabir${quoted}`);
  });

  it('leaves the quote alone when there is no signature', () => {
    expect(seedBody('', '\n\n> hi')).toBe('\n\n> hi');
  });
});

describe('isOnlySignature', () => {
  it('is true for the untouched seed, so opening and leaving saves no draft', () => {
    expect(isOnlySignature(seedBody('Kabir'), 'Kabir')).toBe(true);
    expect(isOnlySignature('', 'Kabir')).toBe(true);
  });

  it('is false once anything is written', () => {
    expect(isOnlySignature(`Hi${seedBody('Kabir')}`, 'Kabir')).toBe(false);
    expect(isOnlySignature('Hi', '')).toBe(false);
  });

  /** A resumed draft saved with the signature, then emptied back to it. */
  it('tolerates the caret having left whitespace around it', () => {
    expect(isOnlySignature(`  ${seedBody('Kabir')}\n`, 'Kabir')).toBe(true);
  });
});

describe('swapSignature', () => {
  it('replaces the old block with the new one, keeping what was written', () => {
    const body = `Hello${seedBody('Work', '\n\n> quoted')}`;
    expect(swapSignature(body, 'Work', 'Home')).toBe(`Hello\n\n-- \nHome\n\n> quoted`);
  });

  it('removes the block when the new mailbox has none', () => {
    expect(swapSignature(`Hello${seedBody('Work')}`, 'Work', '')).toBe('Hello');
  });

  it('adds one only to an otherwise empty body', () => {
    expect(swapSignature('', '', 'Home')).toBe('\n\n-- \nHome');
    expect(swapSignature('Hello', '', 'Home')).toBe('Hello');
  });

  it('leaves a signature the user edited exactly as they wrote it', () => {
    const edited = 'Hello\n\n-- \nWork, but on holiday';
    expect(swapSignature(edited, 'Work', 'Home')).toBe(edited);
  });

  /** Swapping twice must not stack blocks — the other way drafts accumulate copies. */
  it('round-trips without duplicating', () => {
    const start = `Hi${seedBody('Work')}`;
    const there = swapSignature(start, 'Work', 'Home');
    expect(swapSignature(there, 'Home', 'Work')).toBe(start);
  });
});

describe('canned reply insertion', () => {
  it('defaults to above the signature on a new message', () => {
    const body = seedBody('Kabir');
    const at = defaultInsertionPoint(body, 'Kabir');
    expect(insertSnippet(body, 'Thanks!', at).body).toBe('Thanks!\n\n-- \nKabir');
  });

  it('defaults to above the quote when there is no signature', () => {
    const quoted = '\n\nOn Tue, A wrote:\n> hi';
    const at = defaultInsertionPoint(quoted, '', quoted);
    expect(insertSnippet(quoted, 'Thanks!', at).body).toBe(`Thanks!${quoted}`);
  });

  it('defaults to the end of a plain body', () => {
    expect(defaultInsertionPoint('Hello', undefined)).toBe(5);
    expect(insertSnippet('Hello', 'Thanks!', 5).body).toBe('Hello\nThanks!');
  });

  it('inserts at the caret on its own line, and hands back where the caret goes', () => {
    const result = insertSnippet('Hello world', 'X', 5);
    expect(result.body).toBe('Hello\nX\n world');
    expect(result.caret).toBe(7);
    // A second insert follows the first.
    expect(insertSnippet(result.body, 'Y', result.caret).body).toBe('Hello\nX\nY\n world');
  });

  it('clamps a caret from a body that has since got shorter', () => {
    expect(insertSnippet('Hi', 'X', 99).body).toBe('Hi\nX');
    expect(insertSnippet('Hi', 'X', -3).body).toBe('X\nHi');
  });
});
