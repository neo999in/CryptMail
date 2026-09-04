/**
 * The presentational attributes email lays itself out with.
 *
 * HTML email is table markup that means `align="center"` and `bgcolor`
 * sincerely, and a reader that ignores them renders a centred layout flush
 * left with its cards gone. The fixtures here come from a Google notification
 * mail, which is built entirely this way.
 */
import { sanitizePipeline } from '../sanitize';

const out = (html: string) => sanitizePipeline(html);
const dark = (html: string) => sanitizePipeline(html, undefined, undefined, true);

describe('align', () => {
  it('centres a cell the sender centred', () => {
    expect(out('<table><tr><td align="center">Hero</td></tr></table>')).toContain('text-align:center');
  });

  it('takes left and right too, and nothing else', () => {
    expect(out('<div align="right">x</div>')).toContain('text-align:right');
    expect(out('<div align="justify-all-wrong">x</div>')).not.toContain('text-align');
  });

  it('drops the attribute once it has been read', () => {
    expect(out('<div align="center">x</div>')).not.toContain('align=');
  });
});

describe('bgcolor', () => {
  it('paints the cell', () => {
    expect(out('<td bgcolor="#d97706">x</td>')).toContain('background-color:#d97706');
  });

  it('goes through the same dark adaptation as a CSS background', () => {
    // White by attribute must not stay white just because it arrived as an
    // attribute rather than a declaration.
    expect(dark('<td bgcolor="#ffffff">x</td>')).not.toContain('#ffffff');
  });

  it('ignores a value that is not a colour', () => {
    expect(out('<td bgcolor="url(https://evil.example/p.png)">x</td>')).not.toContain('evil.example');
  });
});

describe('width', () => {
  it('becomes a maximum, not a fixed size', () => {
    // 600 is the desktop column every one of these mails is written for.
    // Honouring it literally pushes the message off the side of a phone.
    const result = out('<img src="https://cdn.example/hero.png" width="600">');
    expect(result).toContain('max-width:600px');
    expect(result).not.toContain('width:600px;');
  });

  it('keeps a percentage as a percentage', () => {
    expect(out('<table width="100%"><tr><td>x</td></tr></table>')).toContain('max-width:100%');
  });

  it('drops height, so the renderer keeps the intrinsic ratio', () => {
    const result = out('<img src="https://cdn.example/a.png" width="600" height="400">');
    expect(result).not.toContain('height');
  });
});

describe('<center>', () => {
  it('becomes a centred div, since the tag itself carries the meaning', () => {
    const result = out('<center><p>Hero</p></center>');
    expect(result).toContain('text-align:center');
    expect(result).toContain('Hero');
    expect(result).not.toContain('<center');
  });
});

describe('precedence', () => {
  it('lets the element own style beat the attribute, as a browser would', () => {
    const result = out('<td align="center" style="text-align:left">x</td>');
    // Both present, the author's own declaration last and therefore winning.
    expect(result.indexOf('text-align:center')).toBeLessThan(result.indexOf('text-align:left'));
  });

  it('lets a stylesheet rule beat the attribute too', () => {
    const result = out('<style>.c { text-align:right }</style><td align="center" class="c">x</td>');
    expect(result.indexOf('text-align:center')).toBeLessThan(result.indexOf('text-align:right'));
  });
});

describe('display', () => {
  it('turns inline-block into block, so a button becomes a box', () => {
    // The exact span Google wraps every button in. React Native draws no
    // border, radius or background on a *nested inline* element, so left
    // inline this arrives as bare blue text with its outline gone.
    const button =
      '<a href="https://example.com"><span style="display:inline-block;' +
      'border:1px solid #dadce0;border-radius:20px;padding:10px 16px">Go</span></a>';

    const result = out(button);
    expect(result).toContain('display:block');
    expect(result).toContain('border-radius:20px');
    expect(result).toContain('border:1px solid #dadce0');
  });

  it('keeps display:none, which is how a preheader stays hidden', () => {
    expect(out('<div style="display:none">preview text</div>')).toContain('display:none');
  });

  it('applies either way, dark or not — it is layout, not colour', () => {
    const span = '<span style="display:inline-block">x</span>';
    expect(out(span)).toContain('display:block');
    expect(dark(span)).toContain('display:block');
  });

  it('refuses a display value that is not on the list', () => {
    expect(out('<div style="display:grid">x</div>')).not.toContain('display');
  });
});

describe('percentage heights', () => {
  it('drops height:100%, which does not survive the translation', () => {
    // An Xbox promotional mail put this on its call-to-action, meaning "fill
    // this table cell". CSS resolves the percentage against a parent whose
    // height is known; React Native resolves it against one that here is
    // unbounded, and the button came out several screens tall.
    const result = out('<a href="https://example.com" style="display:block;height:100%;padding:6px 12px">Go</a>');

    expect(result).not.toContain('height:100%');
    expect(result).toContain('padding:6px 12px');
    expect(result).toContain('display:block');
  });

  it('keeps an absolute height, which means the same thing in both models', () => {
    expect(out('<div style="height:44px">x</div>')).toContain('height:44px');
  });

  it('keeps a percentage width, which does mean the same thing', () => {
    expect(out('<div style="width:100%">x</div>')).toContain('width:100%');
  });

  it('drops a percentage max-height for the same reason', () => {
    expect(out('<div style="max-height:50%">x</div>')).not.toContain('max-height');
  });
});
