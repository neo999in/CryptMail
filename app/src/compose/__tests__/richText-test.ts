import { signatureBlock } from '../../signature/signature';
import {
  escapeHtml,
  hasFormatting,
  htmlToText,
  isOnlySignatureHtml,
  swapSignatureHtml,
  textToHtml,
} from '../richText';

describe('textToHtml', () => {
  it('makes each line a paragraph, and a blank line an empty one', () => {
    expect(textToHtml('Hi Ada,\n\nSee you Friday.')).toBe('<p>Hi Ada,</p><p></p><p>See you Friday.</p>');
  });

  it('escapes what would otherwise be markup', () => {
    expect(textToHtml('a <b> & "c"')).toBe('<p>a &lt;b&gt; &amp; &quot;c&quot;</p>');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('turns a run of quoted lines into a blockquote, nested by depth', () => {
    expect(textToHtml('Sure.\n> Lunch?\n>> Friday')).toBe(
      '<p>Sure.</p><blockquote><p>Lunch?</p><blockquote><p>Friday</p></blockquote></blockquote>',
    );
  });
});

describe('htmlToText', () => {
  it('is the inverse of textToHtml for text with no formatting', () => {
    const text = 'Hi Ada,\n\nSee you Friday.\n\n-- \nGrace\n> quoted\n>\n> more';
    expect(htmlToText(textToHtml(text))).toBe(text);
  });

  it('drops inline formatting but keeps the words', () => {
    expect(htmlToText('<p>This is <strong>bold</strong>, <em>italic</em> and <s>gone</s>.</p>')).toBe(
      'This is bold, italic and gone.',
    );
  });

  it('keeps list markers, numbering and nesting', () => {
    const html =
      '<ul><li><p>milk</p></li><li><p>eggs</p><ol><li><p>brown</p></li><li><p>white</p></li></ol></li></ul>';
    expect(htmlToText(html)).toBe('- milk\n- eggs\n   1. brown\n   2. white');
  });

  it('honours an ordered list start', () => {
    expect(htmlToText('<ol start="3"><li><p>c</p></li></ol>')).toBe('3. c');
  });

  it('keeps a link address the label does not already say', () => {
    expect(htmlToText('<p>Read <a href="https://example.com/a">the doc</a>.</p>')).toBe(
      'Read the doc <https://example.com/a>.',
    );
    expect(htmlToText('<p><a href="https://example.com">https://example.com</a></p>')).toBe('https://example.com');
    expect(htmlToText('<p><a href="mailto:ada@example.com">ada@example.com</a></p>')).toBe('ada@example.com');
  });

  it('writes a rule, a line break and a blockquote as text does', () => {
    expect(htmlToText('<p>a<br>b</p><hr><blockquote><p>c</p></blockquote>')).toBe('a\nb\n---\n> c');
  });

  it('decodes entities and collapses source whitespace outside <pre>', () => {
    expect(htmlToText('<p>fish &amp;\n   chips&nbsp;&#8212; &#x263A;</p>')).toBe('fish & chips — ☺');
    expect(htmlToText('<pre><code>a\n  b</code></pre>')).toBe('a\n  b');
  });

  it('keeps the words of headings, underline and coloured text', () => {
    const html = '<h1>Plan</h1><p><u>Read</u> this <span style="color: #D93025">first</span></p>';
    expect(htmlToText(html)).toBe('Plan\nRead this first');
    expect(hasFormatting(html)).toBe(true);
  });

  it('is empty for an empty editor', () => {
    expect(htmlToText('<p></p>')).toBe('');
  });
});

describe('hasFormatting', () => {
  it('is false for what textToHtml wrote, including trailing blank lines', () => {
    expect(hasFormatting(textToHtml('a\n\nb'))).toBe(false);
    expect(hasFormatting('<p>a</p><p></p><p><br></p>')).toBe(false);
  });

  it('is true once anything plain text cannot hold is in it', () => {
    expect(hasFormatting('<p><strong>a</strong></p>')).toBe(true);
    expect(hasFormatting('<ul><li><p>a</p></li></ul>')).toBe(true);
    expect(hasFormatting('<p><a href="https://x.test">x</a></p>')).toBe(true);
  });
});

describe('signatures in rich text', () => {
  const seeded = (sig: string) => textToHtml(signatureBlock(sig));

  it('counts a body holding only the seeded block as empty, trailing space or not', () => {
    expect(isOnlySignatureHtml(seeded('Grace'), 'Grace')).toBe(true);
    expect(isOnlySignatureHtml('<p></p><p></p><p>--</p><p>Grace</p>', 'Grace')).toBe(true);
    expect(isOnlySignatureHtml('<p>Hello</p>' + seeded('Grace'), 'Grace')).toBe(false);
    expect(isOnlySignatureHtml('<p></p>', undefined)).toBe(true);
  });

  it('swaps an intact block for the new mailbox’s, leaving formatting around it alone', () => {
    const html = '<p><strong>Hi</strong></p>' + seeded('Grace\nWork');
    expect(swapSignatureHtml(html, 'Grace\nWork', 'G.')).toBe('<p><strong>Hi</strong></p>' + seeded('G.'));
  });

  it('finds the block when the editor dropped the separator’s trailing space', () => {
    const html = '<p>Hi</p><p></p><p></p><p>--</p><p>Grace</p>';
    expect(htmlToText(swapSignatureHtml(html, 'Grace', 'Ada'))).toBe('Hi\n\n\n-- \nAda');
  });

  it('removes the block and its blank lead-in when the new mailbox has none', () => {
    expect(swapSignatureHtml('<p>Hi</p>' + seeded('Grace'), 'Grace', '')).toBe('<p>Hi</p>');
  });

  it('leaves an edited block alone', () => {
    const html = '<p>Hi</p><p></p><p></p><p>-- </p><p>Grace, on holiday</p>';
    expect(swapSignatureHtml(html, 'Grace', 'Ada')).toBe(html);
  });

  it('adds a signature to an empty message only', () => {
    expect(swapSignatureHtml('<p></p>', undefined, 'Ada')).toBe(seeded('Ada'));
    expect(swapSignatureHtml('<p>Hi</p>', undefined, 'Ada')).toBe('<p>Hi</p>');
  });
});
