/**
 * The features.md §0.9 done-when, asserted against html/sanitize.ts's own
 * exports: script tags, on* handlers, remote CSS and data-URI payloads render
 * inert; allowed content round-trips untouched.
 */
import { resolveCssVars, sanitizeHtml, sanitizePipeline } from '../sanitize';

describe('sanitizeHtml — hostile fixtures render inert', () => {
  test('script, style, iframe, object, embed, form, input, link are removed', () => {
    const html =
      '<script>alert(1)</script>' +
      '<style>body { background: url(https://evil.example/tracker.png); }</style>' +
      '<iframe src="https://evil.example"></iframe>' +
      '<object data="https://evil.example"></object>' +
      '<embed src="https://evil.example">' +
      '<form action="https://evil.example"><input type="text" value="pwned"></form>' +
      '<link rel="stylesheet" href="https://evil.example/x.css">' +
      '<p>safe</p>';
    const out = sanitizeHtml(html);
    expect(out).toBe('<p>safe</p>');
  });

  test('on* event handlers are dropped from every element', () => {
    const html =
      '<a href="https://example.com" onclick="alert(1)" onmouseover="steal()">click</a>' +
      '<img src="https://example.com/x.png" onerror="alert(1)">';
    const out = sanitizeHtml(html);
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onmouseover');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('src="https://example.com/x.png"');
  });

  test('class, id, target, title and other non-allowlisted attributes are dropped', () => {
    const out = sanitizeHtml(
      '<p class="evil" id="x" title="y">text</p><a href="https://example.com" target="_blank">l</a>'
    );
    expect(out).toBe('<p>text</p><a href="https://example.com">l</a>');
  });

  test('javascript: and data: URL schemes are dropped from href and src', () => {
    const html =
      '<a href="javascript:alert(1)">x</a>' +
      '<a href="data:text/html;base64,PGI+eGVjPC9iPg==">y</a>' +
      '<img src="data:image/png;base64,AAAA">';
    const out = sanitizeHtml(html);
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('src=');
  });

  test('protocol-relative URLs are dropped — //host/path is still a network load', () => {
    const out = sanitizeHtml('<a href="//evil.example/x">x</a>');
    expect(out).not.toContain('//evil.example');
    expect(out).not.toContain('href=');
  });

  test('an element carrying a positioning declaration is excluded whole', () => {
    // The fixed-overlay trick: the element is dropped, not demoted — its text
    // goes with it.
    const out = sanitizeHtml('<div style="position:fixed; z-index:999; color:red">hi</div>');
    expect(out).toBe('');
  });

  test('pointer-events declarations exclude their element too', () => {
    expect(sanitizeHtml('<div style="pointer-events:none; color:blue">x</div>')).toBe('');
  });

  test('a style that is safe but not allowlisted is stripped without dropping the element', () => {
    // background-position is not a positioning overlay — it must not trip the
    // exclusiveFilter, and since it is not in allowedStyles it is dropped from
    // the style while the element and its other properties survive.
    const out = sanitizeHtml(
      '<div style="background-position:center; color:red; padding: 12px 16px">hi</div>'
    );
    expect(out).toContain('color:red');
    expect(out).toContain('padding:12px 16px');
    expect(out).not.toContain('background-position');
    expect(out).toContain('hi');
  });

  test('benign email round-trips with its structure intact', () => {
    const html =
      '<p>Hello <strong>bold</strong> and <em>italic</em> and <s>gone</s></p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<ol><li>first</li></ol>' +
      '<blockquote>quoted</blockquote>' +
      '<a href="https://example.com/a?b=c#d">a link</a>' +
      '<h2>Heading</h2>' +
      '<code>mono</code>' +
      '<hr>';
    const out = sanitizeHtml(html);
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<s>gone</s>');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol><li>first</li></ol>');
    expect(out).toContain('<blockquote>quoted</blockquote>');
    expect(out).toContain('<a href="https://example.com/a?b=c#d">a link</a>');
    expect(out).toContain('<h2>Heading</h2>');
    expect(out).toContain('<code>mono</code>');
  });

  test('a named-colour border survives (emails write these constantly)', () => {
    const out = sanitizeHtml('<blockquote style="border-left: 1px solid #ccc; color: white">q</blockquote>');
    expect(out).toContain('border-left');
    expect(out).toContain('color:white');
  });
});

describe('resolveCssVars', () => {
  test('substitutes a known variable inside a style attribute', () => {
    expect(resolveCssVars('<p style="color: var(--cm-text)">x</p>', { '--cm-text': '#F2F2F2' })).toBe(
      '<p style="color: #F2F2F2">x</p>'
    );
  });

  test('uses the inline fallback for an unknown variable', () => {
    expect(resolveCssVars('<p style="color: var(--missing, #fff)">x</p>', {})).toBe(
      '<p style="color: #fff">x</p>'
    );
  });

  test('removes an unknown variable with no fallback', () => {
    expect(resolveCssVars('<p style="color: var(--missing)">x</p>', {})).toBe(
      '<p style="color: ">x</p>'
    );
  });

  test('never touches body text — only style attribute values', () => {
    const html = '<p>the word var(--x) is just text</p>';
    expect(resolveCssVars(html, { '--x': 'red' })).toBe(html);
  });

  test('accepts keys with or without the leading --', () => {
    expect(resolveCssVars('<p style="color: var(--x)">x</p>', { x: 'red' })).toBe(
      '<p style="color: red">x</p>'
    );
  });
});

describe('sanitizePipeline — resolve vars, then allowlist', () => {
  test('a var() styled element survives with only its safe props', () => {
    const out = sanitizePipeline(
      '<p style="color: var(--cm-text); letter-spacing: 2px">hi</p>',
      { '--cm-text': '#F2F2F2' }
    );
    expect(out).toContain('color:#F2F2F2');
    expect(out).not.toContain('letter-spacing');
    expect(out).toContain('hi');
  });

  test('no vars passed → plain sanitize', () => {
    expect(sanitizePipeline('<script>x</script><p>ok</p>')).toBe('<p>ok</p>');
  });
});

describe('malformed input never throws', () => {
  test.each([
    ['', '<div><p>unclosed'],
    ['<p>', '</div><span>'],
    ['<script>', '<a href="https://example.com">'],
    ['&<>', '<img src="data:image/png;base64,AAAA">'],
  ])('handles %j', (_label: string, html: string) => {
    expect(() => sanitizeHtml(html)).not.toThrow();
    expect(() => sanitizePipeline(html, { '--cm-text': '#000' })).not.toThrow();
    expect(typeof sanitizeHtml(html)).toBe('string');
  });
});
