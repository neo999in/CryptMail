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

  it('keeps ex, the unit Gmail quotes every reply in', () => {
    // `margin:0 0 0 .8ex;padding-left:1ex` is what Gmail writes on its
    // blockquote, and one unreadable component took the whole shorthand with
    // it — so a quoted thread rendered flush against the rule beside it.
    const quote = out(
      '<blockquote style="margin:0px 0px 0px 0.8ex;padding-left:1ex">q</blockquote>',
    );
    expect(quote).toContain('margin:0px 0px 0px 0.8ex');
    expect(quote).toContain('padding-left:1ex');
  });

  it('keeps the absolute units Word measures in', () => {
    expect(out('<p style="margin:0in;padding:2mm">x</p>')).toContain('margin:0in');
    expect(out('<p style="margin:0in;padding:2mm">x</p>')).toContain('padding:2mm');
  });

  it('still drops the viewport units the engine computes nothing for', () => {
    // It knows the spellings and returns null, so these would be dropped one
    // layer further down, silently. The two lists are kept the same.
    expect(out('<p style="width:50vw;font-size:2ch">x</p>')).not.toContain('width');
    expect(out('<p style="width:50vw;font-size:2ch">x</p>')).not.toContain('font-size');
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

describe('words that are not colours', () => {
  it('takes no background-colour out of a background image', () => {
    // `background:url(...) no-repeat` was read for its first bare word and
    // emitted as `background-color:url`. React Native cannot parse that, and
    // the body after it stopped rendering — a logo and a screen of black.
    const result = out(
      `<div style="background:url('https://x.example/a.png') center / cover no-repeat;height:146px">x</div>`,
    );

    expect(result).not.toContain('background-color');
    expect(result).toContain('height:146px');
  });

  it('still takes the colour written beside the image', () => {
    expect(out('<div style="background:#223344 url(https://x.example/a.png)">x</div>')).toContain(
      'background-color:#223344',
    );
  });

  it('drops inherit and currentColor, which are cascade words and not colours', () => {
    expect(out('<a style="color:inherit">x</a>')).not.toContain('color');
    expect(out('<p style="border-color:currentColor">x</p>')).not.toContain('border-color');
    expect(out('<p style="color:initial">x</p>')).not.toContain('color');
  });

  it('keeps transparent, and every real name whether or not it is adapted', () => {
    expect(out('<p style="background:transparent">x</p>')).toContain('transparent');
    expect(out('<p style="color:crimson">x</p>')).toContain('color:crimson');
  });
});

describe('line height, which the engine resolves against a fixed root', () => {
  it('resolves a ratio against the size declared beside it', () => {
    // `em` is computed from a 16px root, not from the element's own size, so a
    // 38px headline at 1.15 was given an 18.4px line and printed on itself.
    expect(out('<h1 style="font-size:38px;line-height:1.15">x</h1>')).toContain('line-height:43.7px');
    expect(out('<p style="font-size:11pt;line-height:150%">x</p>')).toContain('line-height:22px');
  });

  it('leaves em where the element states no size of its own', () => {
    // Nothing here can see the inherited size, and 16 is within half a point
    // of the reader's own body text.
    expect(out('<p style="line-height:1.5">x</p>')).toContain('line-height:1.5em');
  });

  it('still refuses a collapsed line', () => {
    expect(out('<p style="font-size:20px;line-height:0">x</p>')).not.toContain('line-height');
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

describe('auto margins, which centre in CSS and collapse in React Native', () => {
  it('drops margin:auto but keeps the max-width beside it', () => {
    // The standard email body wrapper. With `auto` honoured, React Native
    // shrinks the box to its content and a whole statement renders as a
    // narrow vertical bar.
    const result = out('<div style="max-width:600px;margin:auto">content</div>');

    expect(result).not.toContain('margin');
    expect(result).toContain('max-width:600px');
    expect(result).toContain('content');
  });

  it('keeps the half of `margin:0 auto` that does translate', () => {
    // The same declaration is both the centred wrapper and the reset that
    // takes a heading's default margin off. Refusing it whole threw the reset
    // away with the centring, and every heading in the message kept a margin
    // its author had removed.
    const result = out('<h1 style="margin:0 auto 24px">x</h1>');

    expect(result).toContain('margin-top:0');
    expect(result).toContain('margin-bottom:24px');
    expect(result).not.toContain('auto');
  });

  it('keeps ordinary margins', () => {
    expect(out('<div style="margin:16px 0">x</div>')).toContain('margin:16px 0');
    expect(out('<div style="margin-top:8px">x</div>')).toContain('margin-top:8px');
  });
});

describe('<center>', () => {
  it('keeps its own attributes, not just its meaning', () => {
    // It is both the wrapper and the instruction; dropping the wrapper's half
    // loses a background the rest of the pipeline would have adapted.
    const result = dark('<center style="background:#ffffff">hi</center>');

    expect(result).toContain('text-align:center');
    expect(result).toContain('background-color');
    expect(result).not.toContain('#ffffff');
  });

  it('lets the element own text-align win over the implied centring', () => {
    const result = out('<center style="text-align:left">hi</center>');
    expect(result.indexOf('text-align:center')).toBeLessThan(result.indexOf('text-align:left'));
  });
});

describe('shorthand components', () => {
  it('takes a bare 0 among units, which is how shorthands are written', () => {
    // A pattern demanding a unit on every component rejected the whole
    // declaration, so these elements lost their spacing entirely.
    expect(out('<div style="margin:16px 0">x</div>')).toContain('margin:16px 0');
    expect(out('<div style="padding:0 40px 60px">x</div>')).toContain('padding:0 40px 60px');
    expect(out('<div style="padding:6px 12px">x</div>')).toContain('padding:6px 12px');
    expect(out('<div style="margin:0 0 0 0">x</div>')).toContain('margin:0 0 0 0');
  });

  it('takes a negative margin', () => {
    expect(out('<div style="margin-top:-4px">x</div>')).toContain('-4px');
  });

  it('still refuses a value that is not a length', () => {
    expect(out('<div style="padding:calc(100% - 10px)">x</div>')).not.toContain('padding');
    expect(out('<div style="margin:16px 0 0 0 0 0">x</div>')).not.toContain('margin');
  });
});

describe('values React Native refuses outright', () => {
  it('drops font-size:0, which is a spacer trick in CSS and a crash here', () => {
    // The renderer computes letter spacing as a ratio of the font size and
    // throws rather than divide by zero, taking the whole screen with it —
    // a valid, safe, extremely common declaration that crashed the reader.
    expect(out('<p style="font-size:0;letter-spacing:1px">x</p>')).not.toContain('font-size');
    expect(out('<td style="font-size:0px;line-height:0">x</td>')).not.toContain('font-size');
    expect(out('<p style="font-size:0.0em">x</p>')).not.toContain('font-size');
  });

  it('drops a zero line-height for the same reason', () => {
    expect(out('<p style="line-height:0">x</p>')).not.toContain('line-height');
    expect(out('<p style="line-height:0px">x</p>')).not.toContain('line-height');
  });

  it('keeps a real font-size', () => {
    expect(out('<p style="font-size:15px">x</p>')).toContain('font-size:15px');
  });

  it('refuses a negative size but keeps a negative margin', () => {
    // Negative margins are used deliberately; a negative width is not a width.
    expect(out('<div style="width:-10px">x</div>')).not.toContain('width');
    expect(out('<div style="padding:-4px">x</div>')).not.toContain('padding');
    expect(out('<div style="font-size:-2px">x</div>')).not.toContain('font-size');
    expect(out('<div style="margin-top:-4px">x</div>')).toContain('margin-top:-4px');
  });

  it('still allows zero where zero is a real value', () => {
    expect(out('<div style="padding:0">x</div>')).toContain('padding:0');
    expect(out('<div style="border-width:0">x</div>')).toContain('border-width:0');
    expect(out('<div style="width:0">x</div>')).toContain('width:0');
  });

  it('refuses a bare number that is not zero, since 12 is not 12px', () => {
    expect(out('<div style="width:12">x</div>')).not.toContain('width');
  });
});

describe('boxes that existed to show a picture', () => {
  it('removes an empty one along with the picture it cannot draw', () => {
    // A 146-point hole between a logo and a headline, with nothing in it and
    // no way for a reader to tell anything was meant to be there.
    const result = out(
      '<p>a</p><div aria-hidden="true" style="width:146px;height:146px;' +
        `background:url('https://x.example/w.gif') center / contain no-repeat"></div><p>b</p>`,
    );

    expect(result).not.toContain('146px');
    expect(result).toContain('<p>a</p>');
    expect(result).toContain('<p>b</p>');
  });

  it('keeps a box that has text of its own', () => {
    const result = out('<div style="background:url(https://x.example/a.png);height:80px">Hi</div>');
    expect(result).toContain('Hi');
    expect(result).toContain('height:80px');
  });

  it('keeps an empty box that was only ever a colour', () => {
    // A spacer or a divider, which this reader can draw exactly.
    expect(out('<div style="height:20px;background-color:#eeeeee"></div>')).toContain('height:20px');
  });

  it('keeps a picture cell in its row, and takes its sizing', () => {
    // Removing the cell would renumber the columns beside it.
    const result = out(
      '<table><tr><td style="background:url(https://x.example/a.png);height:80px"></td><td>b</td></tr></table>',
    );
    expect(result).toContain('<td></td>');
    expect(result).not.toContain('80px');
  });
});

describe('siblings that asked to share a line', () => {
  const icon = (name: string) =>
    `<table style="float:none;display:inline-table"><tbody><tr><td style="padding:0 6px">` +
    `<a href="https://x.example/${name}"><img src="https://x.example/${name}.png" alt=""></a>` +
    `</td></tr></tbody></table>`;

  it('wraps a run of them in a box that gives them one', () => {
    // A footer's social icons are each a table of their own, held side by side
    // by `display:inline-table` alone. React Native has no inline display, so
    // all four came down the left margin as a ladder.
    const result = out(`<td>${icon('x')}${icon('in')}${icon('yt')}${icon('ig')}</td>`);
    expect(result.match(/class="cm-inline"/g)).toHaveLength(1);
    // And each member marked, since the separation between them has to come
    // from somewhere the renderer will honour.
    expect(result.match(/cm-inline-item/g)).toHaveLength(4);
  });

  it('leaves a single one alone, since it shares a line with nothing', () => {
    expect(out(`<td>${icon('x')}</td>`)).not.toContain('cm-inline');
  });

  it('leaves the columns of a desktop template stacked', () => {
    // The other common inline-block: a column holding a paragraph. Two of them
    // do not fit across a phone, and a responsive template stacks them at this
    // width anyway.
    const column = (text: string) =>
      `<div style="display:inline-block;width:50%"><p>${text}</p></div>`;
    const result = out(
      column('A paragraph long enough that it could not share a line with another.') +
        column('And a second one beside it, just as long as the first.'),
    );

    expect(result).not.toContain('cm-inline');
  });

  it('finds the end of an element that contains its own kind', () => {
    // Each icon is a table inside a table, so the first `</table>` after the
    // opening one is not the end of it.
    const nested = (n: string) =>
      `<table style="display:inline-table"><tbody><tr><td><table><tbody><tr><td>${n}</td></tr></tbody></table></td></tr></tbody></table>`;
    const result = out(nested('a') + nested('b'));

    expect(result.match(/class="cm-inline"/g)).toHaveLength(1);
    expect(result).toContain('a');
    expect(result).toContain('b');
  });
});

describe('rows too crowded to stay rows', () => {
  const buttons = (cells: string) => `<table><tr>${cells}</tr></table>`;
  const CTAS =
    '<td>Microsoft Services Agreement</td><td>Microsoft Privacy Statement</td>' +
    '<td>Frequently Asked Questions</td>';

  it('marks a row of three text columns to be read downwards', () => {
    // Three call-to-action cells written for a 600px column get a third of a
    // phone each, and the label breaks mid-word inside the button.
    expect(out(buttons(CTAS))).toContain('class="cm-stack"');
  });

  it('leaves a label-and-figure pair alone', () => {
    // Two cells read correctly side by side, and that pairing is what a
    // statement is made of.
    const row = buttons('<td>Institutional flows, net</td><td>+4,231 Cr</td>');
    expect(row).not.toContain('cm-stack');
    expect(out(row)).not.toContain('cm-stack');
  });

  it('leaves three short labels alone, since they fit across the column', () => {
    // A name, an amount and an avatar are a line, not a layout.
    const row = buttons(
      '<td><img src="https://x.example/a.png" alt=""></td>' +
        '<td>Hardik Rathod</td><td>owes you INR25.00</td>',
    );
    expect(out(row)).not.toContain('cm-stack');
  });

  it('does not count the indentation a template generator leaves behind', () => {
    // The same row, written the way a generator writes it. Measuring the
    // source rather than the words stacked a name and an amount that fit.
    const row = `<table><tr>
      <td>
        <img src="https://x.example/a.png" alt="">
      </td>
      <td>
        <a href="https://x.example/f">Hardik Rathod</a>
      </td>
      <td>
        <div>
          <span>owes you</span>

          <strong>INR25.00</strong>
        </div>
      </td>
    </tr></table>`;
    expect(out(row)).not.toContain('cm-stack');
  });

  it('leaves a row of icons alone, however many there are', () => {
    // Stacking a footer's social row turns it into a ladder.
    const icons = ['x', 'in', 'yt', 'ig']
      .map((n) => `<td><img src="https://x.example/${n}.png" alt="${n}"></td>`)
      .join('');
    expect(out(buttons(icons))).not.toContain('cm-stack');
  });

  it('marks the innermost row, not the wrapper around it', () => {
    const result = out(`<table><tr><td><table><tr>${CTAS}</tr></table></td></tr></table>`);
    expect(result.match(/cm-stack/g)).toHaveLength(1);
  });

  it('drops the share-of-the-row widths from a row that stacks', () => {
    // `width:33%` is a third *of the row*, which means nothing once the row is
    // a column — it left three buttons in a narrow strip down one side.
    const result = out(
      buttons(
        '<td width="33%">Microsoft Services Agreement</td>' +
          '<td style="width:33%;padding:7px">Microsoft Privacy Statement</td>' +
          '<td style="width:33%">Frequently Asked Questions</td>',
      ),
    );

    expect(result).not.toContain('33%');
    expect(result).toContain('padding:7px');
  });

  it('keeps a pixel width, which is a measurement and not a share', () => {
    const result = out(
      buttons(
        '<td style="width:120px">Microsoft Services Agreement</td>' +
          '<td>Microsoft Privacy Statement</td><td>Frequently Asked Questions</td>',
      ),
    );
    expect(result).toContain('max-width:120px');
  });

  it('lets no class through but its own', () => {
    const result = out(`<table><tr class="sender">${CTAS}</tr></table>`);
    expect(result).not.toContain('sender');
    expect(result).toContain('cm-stack');
  });
});

describe('desktop widths on a phone', () => {
  it('reads a pixel width as a maximum, so the message cannot run off the side', () => {
    // Email is written for a 600px column and says so in a hundred places.
    // Honoured literally, a Microsoft notification rendered with its banner
    // and every paragraph cut off at the right edge — and unlike a browser,
    // the reader has no way to scale.
    const result = out('<table style="width:600px"><tr><td>x</td></tr></table>');
    expect(result).toContain('max-width:600px');
    expect(result).not.toContain('width:600px;');
  });

  it('leaves a percentage width alone, since it is already relative', () => {
    expect(out('<div style="width:100%">x</div>')).toContain('width:100%');
    expect(out('<div style="width:50%">x</div>')).toContain('width:50%');
  });
});
