/**
 * Adapting a sender's palette to a black ground.
 *
 * The rule under test is one distinction: greys are structure and get
 * inverted, saturated colours are meaning and are left alone. The fixtures are
 * taken from a real market-digest newsletter, which is where the need showed
 * up — its white card, near-black headings and orange brand band all landed
 * wrong in different ways.
 */
import { adaptBackground, adaptBorder, adaptForeground, colorInShorthand, parseColor } from '../colors';
import { sanitizePipeline } from '../sanitize';

const dark = (html: string) => sanitizePipeline(html, undefined, undefined, true);

describe('parseColor', () => {
  it('reads the notations email actually uses', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('returns null for anything it does not understand', () => {
    expect(parseColor('rebeccapurple')).toBeNull();
    expect(parseColor('inherit')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('backgrounds', () => {
  it('darkens a white card without collapsing it into the page', () => {
    const adapted = adaptBackground('#ffffff');
    expect(adapted).not.toBeNull();
    // Dark, but not the ground itself — a card has to still read as a card.
    expect(parseColor(adapted!)!.r).toBeGreaterThan(0);
    expect(parseColor(adapted!)!.r).toBeLessThan(60);
  });

  it('keeps an off-white distinguishable from white', () => {
    expect(adaptBackground('#f4f4f5')).not.toBe(adaptBackground('#ffffff'));
  });

  it('leaves a brand colour exactly as the sender wrote it', () => {
    // The digest's orange. This is the message, not the structure.
    expect(adaptBackground('#d97706')).toBeNull();
    expect(adaptBackground('#16a34a')).toBeNull();
  });

  it('leaves an already-dark background alone, so a second pass is a no-op', () => {
    expect(adaptBackground('#111111')).toBeNull();
    expect(adaptBackground('#000000')).toBeNull();
  });
});

describe('foregrounds', () => {
  it('lifts near-black body text off a black ground', () => {
    const adapted = adaptForeground('#1a1a1a');
    expect(parseColor(adapted!)!.r).toBeGreaterThan(180);
  });

  it('lifts a mid-grey caption to a legible floor', () => {
    // #78716c is a fine caption on white and murky on black — the floor is
    // what matters here, not the inversion.
    const adapted = adaptForeground('#78716c');
    expect(parseColor(adapted!)!.r).toBeGreaterThan(140);
  });

  it('leaves a colour that carries meaning', () => {
    expect(adaptForeground('#dc2626')).toBeNull();
    expect(adaptForeground('#16a34a')).toBeNull();
  });

  it('leaves text that is already light', () => {
    expect(adaptForeground('#f5f5f5')).toBeNull();
  });
});

describe('borders', () => {
  it('holds a rule well below body text, so it separates without shouting', () => {
    const border = parseColor(adaptBorder('#e5e5e5')!)!;
    const text = parseColor(adaptForeground('#1a1a1a')!)!;
    expect(border.r).toBeLessThan(text.r);
  });
});

describe('the background shorthand', () => {
  it('lifts the first stop out of a gradient', () => {
    expect(colorInShorthand('linear-gradient(135deg,#f59e0b 0%,#d97706 100%)')).toBe('#f59e0b');
  });

  it('finds a plain colour, keyword or hex', () => {
    expect(colorInShorthand('#d97706')).toBe('#d97706');
    expect(colorInShorthand('white')).toBe('white');
  });

  it('finds nothing in a url(), which is the point of not allowing the shorthand', () => {
    expect(colorInShorthand('url(https://evil.example/pixel.png) no-repeat')).toBeNull();
  });
});

describe('through the pipeline', () => {
  it('renders a gradient header as a flat band of its own colour', () => {
    const out = dark(
      '<style>.header { background: linear-gradient(135deg,#f59e0b 0%,#d97706 100%) }</style>' +
        '<div class="header">Good evening</div>',
    );

    expect(out).toContain('background-color:#f59e0b');
    expect(out).toContain('Good evening');
  });

  it('never lets a background url() through as a colour', () => {
    const out = dark('<p style="background: url(https://evil.example/p.png)">hi</p>');

    expect(out).not.toContain('evil.example');
    expect(out).toContain('hi');
  });

  it('turns the white card dark and the near-black heading light', () => {
    const out = dark(
      '<style>.wrap { background:#ffffff } .title { color:#1a1a1a }</style>' +
        '<div class="wrap"><h1 class="title">Heading</h1></div>',
    );

    expect(out).not.toContain('#ffffff');
    expect(out).not.toContain('#1a1a1a');
    expect(out).toContain('Heading');
  });

  it('leaves a gain green and a loss red', () => {
    const out = dark('<span style="color:#16a34a">+3.98%</span><span style="color:#dc2626">-0.30%</span>');

    expect(out).toContain('#16a34a');
    expect(out).toContain('#dc2626');
  });

  it('changes nothing when the reader is not dark', () => {
    const out = sanitizePipeline('<p style="color:#1a1a1a">hi</p>');
    expect(out).toContain('#1a1a1a');
  });
});
