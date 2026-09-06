/**
 * How many images a message would fetch if it were allowed to.
 *
 * A mailbox that blocks remote images (`store/accountScope.ts`) renders every
 * one as a placeholder, and the reader is then owed two things the placeholders
 * alone cannot give: a count, and one control that loads them. Without the
 * count the strip would have to say "some images", which is exactly the
 * vagueness that makes people turn the setting off.
 *
 * **Nothing here touches the network** — the same rule `spam/urls.ts` works
 * under, and for the same reason. This is a bounded scan of markup that has
 * already been through the sanitizer, reading `src` attributes and counting
 * them. No URL is fetched, resolved or previewed, not even to check it exists.
 *
 * It counts what the reader would actually *request*: an `http(s)` source.
 * A `data:` image carries its own bytes and discloses nothing, and `cid:` is
 * the message's own attached part — neither is a beacon, and counting them
 * would make the strip offer to "load" images that are already on screen.
 */

/** Every `src` on an `img` tag, however the attribute is quoted. */
const IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * The number of distinct remote images in this HTML.
 *
 * Distinct, because a tracking pixel repeated in a footer and a header is one
 * disclosure to one host, and a strip that said "14 images" for a newsletter
 * built from one spacer gif would be counting markup rather than what it costs
 * the reader.
 */
export function countRemoteImages(html: string): number {
  return remoteImageSources(html).size;
}

/** The distinct http(s) sources, for the count and for anything that tests it. */
export function remoteImageSources(html: string): Set<string> {
  const found = new Set<string>();
  // `exec` in a loop rather than `matchAll`, so the regex's own `lastIndex` is
  // the only cursor and a pathological input cannot make this quadratic.
  IMG_SRC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMG_SRC.exec(html)) !== null) {
    const src = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (isRemote(src)) found.add(src);
  }
  return found;
}

/**
 * Whether fetching this source would tell someone the message was opened.
 *
 * Only `http` and `https` do. A protocol-relative `//host/pixel.gif` does too —
 * it resolves to one of them — so it counts, even though the sanitizer's
 * `allowedSchemes` has no opinion on a URL with no scheme at all.
 */
function isRemote(src: string): boolean {
  return /^(https?:)?\/\//i.test(src);
}
