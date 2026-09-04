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

/**
 * The other skeleton: MJML's, which is what a transactional email is built from
 * now — nested `div`/`table` pairs, a decorative chip drawn entirely in CSS, and
 * a footer link that takes its colour from the cascade.
 *
 * This one is here because it did not survive. Two of its declarations named a
 * value React Native cannot parse as a colour — `background: url(...)` read for
 * its first word, and `color: inherit` — and a colour it cannot parse does not
 * fail alone: everything after it stopped drawing, so the message was a logo
 * and a screen of black with the sign-in button somewhere inside it.
 */
const TRANSACTIONAL = `
<!doctype html><html lang="und" dir="auto"><head><title></title>
<!--[if !mso]><!--><meta http-equiv="X-UA-Compatible" content="IE=edge"><!--<![endif]-->
<style type="text/css">
  .footer-link { color: inherit; text-decoration: underline }
</style></head>
<body style="word-spacing:normal;background-color:#faf9f5">
  <div style="background-color:#faf9f5">
    <div style="margin:0px auto;max-width:640px">
      <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%">
        <tbody><tr><td style="direction:ltr;font-size:0px;padding:20px 0;padding-top:48px;text-align:center">
          <div style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%">
            <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody>
              <tr><td align="left" style="font-size:0px;padding:0;word-break:break-word">
                <div aria-hidden="true" style="width:146px;height:146px;margin:0 auto;background:url('https://cdn.example/wave.gif') center / contain no-repeat;border-radius:20px;overflow:hidden"></div>
              </td></tr>
              <tr><td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word">
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:28px;font-weight:bold;line-height:1.2;color:#141413;text-align:center">Sign in to Example</div>
              </td></tr>
              <tr><td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word">
                <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;line-height:100%">
                  <tr><td align="center" bgcolor="#141413" role="presentation" style="border:none;border-radius:10px;cursor:auto;mso-padding-alt:10px 25px;background:#141413" valign="middle">
                    <p style="display:inline-block;background:#141413;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:normal;line-height:120%;margin:0;text-decoration:none;text-transform:none;padding:0;mso-padding-alt:0px;border-radius:10px">
                      <a href="https://example.com/magic-link" style="text-decoration:none;line-height:20px;color:white;font-size:18px;display:inline-block;padding:14px 36px">Sign in</a>
                    </p>
                  </td></tr>
                </table>
              </td></tr>
              <tr><td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word">
                <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:24px;color:#7B7974;text-align:center">
                  If you didn't request this email, you can safely ignore it.<br>
                  Need a hand? Contact <a class="footer-link" href="https://example.com/support">Support</a>.
                </div>
              </td></tr>
            </tbody></table>
          </div>
        </td></tr></tbody>
      </table>
    </div>
  </div>
</body></html>
`;

describe('a transactional message, MJML-shaped', () => {
  const out = render(TRANSACTIONAL);

  it('keeps every piece of its content', () => {
    for (const text of [
      'Sign in to Example',
      'Sign in',
      "If you didn't request this email",
      'Support',
    ]) {
      expect(out).toContain(text);
    }
  });

  it('emits no colour the renderer cannot parse', () => {
    // Either of these blanked the body from that point down.
    expect(out).not.toContain('background-color:url');
    expect(out).not.toContain(':inherit');
    expect(out).not.toContain('currentcolor');
  });

  it('takes the decorative chip away with the picture it was there to show', () => {
    // A 146-point box holding a GIF this reader cannot draw is a 146-point
    // hole between the logo and the headline once the GIF is gone.
    expect(out).not.toContain('146px');
    expect(out).not.toContain('cdn.example/wave.gif');
  });

  it('keeps the button its colour, its radius and its link', () => {
    expect(out).toContain('background-color:#141413');
    expect(out).toContain('border-radius:10px');
    expect(out).toContain('https://example.com/magic-link');
  });

  it('gives the headline a line box taller than its type', () => {
    // `line-height:1.2` under `font-size:28px` is 33.6px. Resolved as `em`
    // against the engine's fixed 16px root it was 19.2, and the words in a
    // two-line headline printed over each other.
    expect(out).toContain('line-height:33.6px');
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
