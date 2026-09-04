/**
 * The places CSS and React Native disagree, and the tags that leak.
 *
 * Everything here was found by walking real mail rather than by reading the
 * spec: each case rendered visibly wrong in the reader before its fix, and the
 * failure was the same shape every time — a declaration that is perfectly
 * valid CSS, survives the allowlist, and then means nothing to the renderer,
 * so the element silently falls back or blows up.
 */
import { sanitizePipeline } from '../sanitize';

const FACES = { regular: 'R', medium: 'M', semibold: 'S', bold: 'B' };
const out = (html: string) => sanitizePipeline(html, undefined, FACES);
const dark = (html: string) => sanitizePipeline(html, undefined, FACES, true);

describe('tags whose text must not reach the body', () => {
  it('drops the subject line hiding in <title>', () => {
    // It rendered as the message's first line, above the greeting.
    const result = out('<html><head><title>Your receipt</title></head><body><p>body</p></body></html>');
    expect(result).not.toContain('Your receipt');
    expect(result).toContain('body');
  });

  it('drops fallback copy meant for a client that could not render', () => {
    expect(out('<noscript>Enable images</noscript><p>hi</p>')).not.toContain('Enable images');
    expect(out('<iframe>Upgrade your client</iframe><p>hi</p>')).not.toContain('Upgrade');
  });

  it('still reads the stylesheet out of the head it discards', () => {
    // <head> is dropped whole, but rules are extracted before that happens.
    expect(out('<head><style>p{color:#00ff00}</style></head><p>hi</p>')).toContain('color:#00ff00');
  });
});

describe('units React Native cannot resolve', () => {
  it('drops a percentage font-size, which has nothing to be a percentage of', () => {
    // Not a wrong size — no size, silently falling back to the base.
    expect(out('<p style="font-size:120%">x</p>')).not.toContain('font-size');
    expect(out('<p style="font-size:12pt">x</p>')).toContain('font-size:12pt');
  });

  it('turns the two line-heights email writes into em', () => {
    expect(out('<p style="line-height:1.5">x</p>')).toContain('line-height:1.5em');
    expect(out('<p style="line-height:150%">x</p>')).toContain('line-height:1.5em');
  });

  it('drops line-height:normal, which has no equivalent at all', () => {
    expect(out('<p style="line-height:normal">x</p>')).not.toContain('line-height');
  });
});

describe('colour notations that were silently skipping adaptation', () => {
  it('adapts an hsl() background', () => {
    // Rare by hand, routine in anything generated — and it stayed white.
    expect(dark('<p style="background-color:hsl(0,0%,100%)">x</p>')).not.toContain('hsl');
  });

  it('adapts a named light background', () => {
    const result = dark('<p style="background-color:ivory">x</p>');
    expect(result).not.toContain('ivory');
  });

  it('still leaves a saturated hsl() alone', () => {
    expect(dark('<p style="color:hsl(120,60%,45%)">x</p>')).toContain('hsl(120,60%,45%)');
  });
});

describe('the legacy tags mail never stopped using', () => {
  it('keeps the colour off a <font> tag', () => {
    const result = out('<font color="#ff0000" face="Georgia">red</font>');
    expect(result).toContain('color:#ff0000');
    expect(result).toContain('red');
  });

  it('ignores a font attribute that is not a colour', () => {
    expect(out('<font color="url(https://evil.example/p.png)">x</font>')).not.toContain('evil.example');
  });
});

describe('individual border properties', () => {
  it('takes the longhand, not only the shorthand', () => {
    const result = out('<div style="border-bottom-width:2px;border-bottom-style:solid">x</div>');
    expect(result).toContain('border-bottom-width:2px');
    expect(result).toContain('border-bottom-style:solid');
  });
});

describe('images the renderer cannot fetch', () => {
  it('removes them rather than leaving a blank gap', () => {
    // A stripped cid:, data: or path-relative src leaves an <img> with
    // nothing to show, which lays out as a hole in the message.
    expect(out('<img src="cid:logo@1">')).toBe('');
    expect(out('<img src="/images/logo.png">')).toBe('');
    expect(out('<img>')).toBe('');
  });

  it('keeps a real one', () => {
    expect(out('<img src="https://cdn.example/a.png">')).toContain('cdn.example');
  });
});

describe('compound selectors', () => {
  it('matches a tag and class together', () => {
    expect(out('<style>p.lead{color:#00ff00}</style><p class="lead">x</p>')).toContain('#00ff00');
  });

  it('requires every part to match', () => {
    expect(out('<style>p.lead{color:#00ff00}</style><div class="lead">x</div>')).not.toContain('#00ff00');
    expect(out('<style>.a.b{color:#00ff00}</style><p class="a">x</p>')).not.toContain('#00ff00');
    expect(out('<style>.a.b{color:#00ff00}</style><p class="a b">x</p>')).toContain('#00ff00');
  });

  it('outranks the single selectors it is built from', () => {
    const result = out('<style>p{color:#111111}p.lead{color:#00ff00}</style><p class="lead">x</p>');
    expect(result.indexOf('#111111')).toBeLessThan(result.indexOf('#00ff00'));
  });

  it('still refuses a descendant combinator, which cannot be evaluated per element', () => {
    expect(out('<style>.card h1{color:#00ff00}</style><div class="card"><h1>x</h1></div>')).not.toContain('#00ff00');
  });
});
