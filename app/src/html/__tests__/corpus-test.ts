/**
 * Whole messages, in the shapes mail is actually built in.
 *
 * The other suites test one decision each. This one exists because every bug
 * in this pipeline so far was found by opening a real message and noticing it
 * looked wrong — the failures were never in a single declaration, they were in
 * what a page made of thousands of them added up to. A unit test for
 * `margin: auto` would have passed on the day an entire statement rendered as
 * a vertical bar.
 *
 * So these fixtures are structural: the Litmus-style table skeleton, the
 * centred body wrapper, the bulletproof button, the preheader, the
 * `<font>`-tag relic. And the assertions are invariants rather than exact
 * output — *content survives*, *layout intent survives*, *nothing executable
 * survives* — because the point is to catch a message being emptied or blown
 * up, which is what actually went wrong, and not to freeze the formatting of a
 * style attribute.
 */
import { droppedDeclarations, resetDroppedDeclarations } from '../properties';
import { sanitizePipeline } from '../sanitize';

const FACES = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
};

const render = (html: string) => sanitizePipeline(html, undefined, FACES, true);

/** The skeleton every template generator emits, in miniature. */
const TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your November statement</title>
  <style>
    html, body { margin: 0 auto !important; padding: 0 !important; height: 100% !important; }
    table { border-spacing: 0 !important; border-collapse: collapse !important; margin: 0 auto !important; }
    .mobile-only { display: none; }
    @media only screen and (max-width: 600px) {
      .desktop-only { display: none !important; }
      .mobile-only { display: block !important; }
    }
    .lead { font-size: 20px; font-weight: 700; color: #1a1a1a; }
    td.figure { font-weight: 600; text-align: right; }
  </style>
</head>
<body width="100%" bgcolor="#eeeeee" style="margin: 0;">
  <center style="width: 100%; background: #eeeeee;">
    <div style="max-width: 600px; margin: auto;">
      <div class="preheader" style="display:none;font-size:1px;color:transparent;max-height:0;overflow:hidden">
        Hidden preview line
      </div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width: 600px;">
        <tr>
          <td bgcolor="#ffffff" style="padding: 30px; font-family: sans-serif; font-size: 15px; line-height: 20px; color: #555555;">
            <div class="lead">Good evening</div>
            <p style="line-height:1.5">Here is where your account stands.</p>
            <table width="100%">
              <tr>
                <td style="border-bottom: 1px solid #dddddd">Rent</td>
                <td class="figure" style="border-bottom: 1px solid #dddddd">INR 25.00</td>
              </tr>
            </table>
            <font color="#ff5216" face="Georgia">A note in the old style.</font>
            <a href="https://example.com/statement">
              <span style="display:inline-block;border:1px solid #dadce0;border-radius:20px;padding:10px 16px;background-color:#ffffff;color:#4285f4;width:100%;height:100%">
                Review your spending
              </span>
            </a>
            <img src="https://cdn.example/logo.png" width="111" height="38" alt="Logo">
          </td>
        </tr>
      </table>
    </div>
  </center>
</body>
</html>
`;

describe('a whole templated message', () => {
  const out = render(TEMPLATE);

  it('keeps every piece of its content', () => {
    for (const text of [
      'Good evening',
      'Here is where your account stands.',
      'Rent',
      'INR 25.00',
      'A note in the old style.',
      'Review your spending',
    ]) {
      expect(out).toContain(text);
    }
  });

  it('shows neither the subject nor the preheader as body text', () => {
    // Both render above the greeting when their tags are merely discarded
    // rather than deleted with their contents.
    expect(out).not.toContain('Your November statement');
    expect(out).not.toContain('Hidden preview line');
  });

  it('does not collapse the body wrapper', () => {
    // `margin: auto` on the wrapper shrinks it to its content in React
    // Native, which renders an entire statement as a narrow vertical bar.
    expect(out).not.toContain('margin:auto');
    expect(out).toContain('max-width:600px');
  });

  it('does not let a percentage height stretch the button', () => {
    expect(out).not.toContain('height:100%');
  });

  it('gives the button a box it can draw an edge on', () => {
    // A styled span inside an anchor is inline, and React Native draws no
    // border on nested text — so the span becomes a div and says `block`.
    expect(out).toContain('display:block');
    expect(out).toContain('border-radius:20px');
    expect(out).toContain('border:1px solid');
  });

  it('resolves every weight to a face, since none of them synthesize', () => {
    expect(out).toContain('Manrope_700Bold');
    expect(out).toContain('Manrope_600SemiBold');
    expect(out).not.toContain('font-weight');
  });

  it('keeps the spacing shorthands that carry a bare zero', () => {
    expect(out).toContain('padding:30px');
  });

  it('turns the light palette dark and keeps what carries meaning', () => {
    expect(out).not.toContain('#ffffff');
    expect(out).not.toContain('#eeeeee');
    expect(out).not.toContain('#1a1a1a');
    // The brand orange from the <font> tag, and the link blue, both survive.
    expect(out).toContain('#ff5216');
    expect(out).toContain('#4285f4');
  });

  it('applies the stylesheet, including its compound selector', () => {
    expect(out).toContain('text-align:right');
  });

  it('skips @media whole rather than treating its rules as unconditional', () => {
    // `.desktop-only { display: none }` lives inside a max-width query. Taken
    // unconditionally it would hide the message on every screen.
    expect(out).toContain('Good evening');
  });

  it('reads the layout out of the presentational attributes', () => {
    expect(out).toContain('text-align:center');
    expect(out).toContain('max-width:100%');
  });

  it('lets nothing executable or fetchable through', () => {
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('!important');
    expect(out).not.toContain('class=');
  });
});

describe('a hostile message wearing the same skeleton', () => {
  const out = render(`
    <style>
      .card { background: url(https://tracker.example/pixel.png); position: fixed; }
      .bait { color: expression(alert(1)); }
    </style>
    <div class="card">overlay bait</div>
    <p class="bait" onclick="steal()">visible copy</p>
    <a href="javascript:alert(1)">tap me</a>
    <img src="data:image/svg+xml,<svg onload=alert(1)>">
    <p style="background:url('https://tracker.example/p.png')">tracked</p>
  `);

  it('drops the overlay and everything it was hiding', () => {
    expect(out).not.toContain('overlay bait');
  });

  it('keeps the copy that was only ever text', () => {
    expect(out).toContain('visible copy');
    expect(out).toContain('tracked');
  });

  it('lets no URL through by any of the routes that carry one', () => {
    expect(out).not.toContain('tracker.example');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:image');
    expect(out).not.toContain('expression');
    expect(out).not.toContain('onclick');
  });
});

describe('the dropped-declaration tally', () => {
  beforeEach(() => resetDroppedDeclarations());

  it('names what it could not read, so a gap is a log line and not a screenshot', () => {
    render('<p style="text-shadow:0 1px 2px #000;color:#111111">x</p>');
    expect(droppedDeclarations().map((d) => d.property)).toContain('text-shadow');
  });

  it('stays quiet on a message it understood completely', () => {
    render('<p style="color:#111111;padding:8px">x</p>');
    expect(droppedDeclarations()).toEqual([]);
  });

  it('counts a property once per declaration, so frequency is visible', () => {
    render('<p style="float:left">a</p><p style="float:right">b</p>');
    expect(droppedDeclarations()).toEqual([{ property: 'float', count: 2 }]);
  });
});
