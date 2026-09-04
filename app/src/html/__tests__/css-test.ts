/**
 * `<style>` blocks, read but never trusted.
 *
 * Two things have to hold at once. A class-styled newsletter must keep its
 * design — that is the whole reason to read a stylesheet at all. And nothing a
 * stylesheet says may reach the renderer that an inline `style=` could not:
 * every declaration merged here still has to pass `allowedStyles`, so the
 * hostile cases below are the same ones sanitize-test.ts asserts inline.
 */
import { extractRules, mergeDeclarations } from '../css';
import { sanitizePipeline } from '../sanitize';

describe('extractRules', () => {
  it('reads tag, class and id selectors', () => {
    const rules = extractRules(
      '<style>p { color: #fff } .lead { font-size: 18px } #hero { text-align: center }</style>',
    );

    expect(rules.tags.get('p')).toContain('color: #fff');
    expect(rules.classes.get('lead')).toContain('font-size: 18px');
    expect(rules.ids.get('hero')).toContain('text-align: center');
  });

  it('splits a comma-separated selector group across its selectors', () => {
    const rules = extractRules('<style>h1, h2, .title { font-weight: bold }</style>');

    expect(rules.tags.get('h1')).toContain('font-weight: bold');
    expect(rules.tags.get('h2')).toContain('font-weight: bold');
    expect(rules.classes.get('title')).toContain('font-weight: bold');
  });

  it('merges a selector written twice, later winning', () => {
    const rules = extractRules('<style>p { color: red } p { color: blue }</style>');
    const merged = mergeDeclarations('p', {}, rules);

    // Both kept, in source order — the renderer applies the last one.
    expect(merged).toBe('color: red;color: blue');
  });

  it('skips @media whole, rather than leaving its rules unconditional', () => {
    // The trap: strip only the `@media (...)` line and `.only-wide` survives as
    // though it applied always.
    const rules = extractRules(
      '<style>.always { color: red } @media (min-width: 900px) { .only-wide { color: blue } }</style>',
    );

    expect(rules.classes.get('always')).toContain('color: red');
    expect(rules.classes.has('only-wide')).toBe(false);
  });

  it('ignores @import, which is a network fetch in a stylesheet costume', () => {
    const rules = extractRules('<style>@import url("https://evil.example/x.css"); p { color: red }</style>');

    expect(rules.tags.get('p')).toContain('color: red');
    expect([...rules.tags.values()].join()).not.toContain('evil.example');
  });

  it('ignores selectors it cannot match per element', () => {
    const rules = extractRules(
      '<style>div p { color: red } a:hover { color: blue } [data-x] { color: green }</style>',
    );

    expect(rules.tags.size).toBe(0);
    expect(rules.classes.size).toBe(0);
    expect(rules.ids.size).toBe(0);
  });

  it('reads nothing out of a message with no style block', () => {
    const rules = extractRules('<p style="color: red">hi</p>');
    expect(rules.tags.size + rules.classes.size + rules.ids.size).toBe(0);
  });
});

describe('mergeDeclarations — cascade order', () => {
  const rules = extractRules(
    '<style>p { color: red } .box { color: green } #main { color: blue }</style>',
  );

  it('puts the inline style last, so the sender-written one wins', () => {
    const merged = mergeDeclarations('p', { class: 'box', id: 'main', style: 'color: black' }, rules);
    expect(merged).toBe('color: red;color: green;color: blue;color: black');
  });

  it('orders tag under class under id', () => {
    expect(mergeDeclarations('p', { class: 'box', id: 'main' }, rules)).toBe(
      'color: red;color: green;color: blue',
    );
  });

  it('applies every class an element lists, in order', () => {
    const two = extractRules('<style>.a { color: red } .b { font-size: 12px }</style>');
    expect(mergeDeclarations('div', { class: 'a b' }, two)).toBe('color: red;font-size: 12px');
  });

  it('returns undefined when nothing matches and there was no inline style', () => {
    expect(mergeDeclarations('span', {}, rules)).toBeUndefined();
  });

  it('strips !important rather than honouring it', () => {
    const important = extractRules('<style>p { color: red !important }</style>');
    expect(mergeDeclarations('p', {}, important)).toBe('color: red');
  });
});

describe('through the pipeline — a stylesheet buys no new powers', () => {
  it('applies a class rule to the element that names it', () => {
    const out = sanitizePipeline('<style>.lead { color: #ff0000 }</style><p class="lead">hi</p>');

    expect(out).toContain('color:#ff0000');
    expect(out).toContain('hi');
  });

  it('drops the style block itself, tag and CSS text both', () => {
    const out = sanitizePipeline('<style>.lead { color: #ff0000 }</style><p class="lead">hi</p>');

    expect(out).not.toContain('<style');
    expect(out).not.toContain('.lead');
    expect(out).not.toContain('{');
  });

  it('drops class and id from the output once they have been read', () => {
    const out = sanitizePipeline('<style>.lead { color: #ff0000 }</style><p class="lead" id="x">hi</p>');

    expect(out).not.toContain('class=');
    expect(out).not.toContain('id=');
  });

  it('rejects a property the inline allowlist does not carry', () => {
    // background-image is not in allowedStyles, so it cannot arrive by CSS
    // either — this is the remote-fetch-via-stylesheet case.
    const out = sanitizePipeline(
      '<style>.x { background-image: url(https://evil.example/pixel.png) }</style><p class="x">hi</p>',
    );

    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('background-image');
  });

  it('rejects a bad value for a property that is otherwise allowed', () => {
    const out = sanitizePipeline(
      '<style>.x { color: url(https://evil.example/p.png) }</style><p class="x">hi</p>',
    );

    expect(out).not.toContain('evil.example');
  });

  it('excludes an element a stylesheet tried to position over the page', () => {
    // The fixed-overlay trick, arriving by class rather than inline. The whole
    // element goes, exactly as exclusiveFilter does for an inline style.
    const out = sanitizePipeline(
      '<style>.overlay { position: fixed }</style><p class="overlay">gotcha</p><p>real</p>',
    );

    expect(out).not.toContain('gotcha');
    expect(out).toContain('real');
  });

  it('keeps an element a stylesheet positions absolutely, images included', () => {
    // The regression that showed up on the first real newsletter: Google lays
    // its hero art out with `position: absolute`, and excluding on that
    // deleted the images and the copy around them.
    const out = sanitizePipeline(
      '<style>.hero { position: absolute }</style><div class="hero">' +
        '<img src="https://cdn.example/hero.png"><p>real content</p></div>',
    );

    expect(out).toContain('real content');
    expect(out).toContain('cdn.example/hero.png');
  });

  it('keeps an element a stylesheet merely positions relatively', () => {
    // The regression that showed up the moment stylesheets were read at all:
    // real newsletters position half their layout, and treating that as an
    // overlay deleted their content wholesale.
    const out = sanitizePipeline(
      '<style>.card { position: relative; color: #ffffff }</style><p class="card">real content</p>',
    );

    expect(out).toContain('real content');
    expect(out).not.toContain('position');
  });

  it('leaves a message with no stylesheet exactly as it was', () => {
    const out = sanitizePipeline('<p style="color:#ffffff">hi</p>');
    expect(out).toBe('<p style="color:#ffffff">hi</p>');
  });
});
