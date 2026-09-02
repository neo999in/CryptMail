/**
 * Whether a screen's top bar is covered by something opened over it.
 *
 * Opening a mail does not replace the inbox's bar — the message slides up into
 * the list area and the bar keeps drawing above it (`ui/expand.tsx`). Two
 * different things follow from that, and they do *not* switch at the same
 * moment, which is why this is three states rather than a boolean:
 *
 *   - **The bar's contents** (title, tabs, filter) fade out, because they
 *     describe a list that is not what is being read. They have to come back as
 *     the mail *starts* closing: the collapse reveals the list from the first
 *     frame, and a list under an empty bar is the bug this state was split to
 *     fix. So `'closing'` shows them again while the mail is still on its way
 *     home.
 *   - **The aurora keeps animating**, because the band is still on screen even
 *     though `useIsFocused()` has gone false. That must stay true for the whole
 *     close — `Aurora` restarts its loop from zero on re-activation, so a band
 *     allowed to stop mid-collapse jumps. It is released only once the inbox is
 *     focused again.
 *
 * So gate 3 is read as "on screen", not "focused". The other three are
 * untouched — foreground, reduced motion and battery saver still stop it — and
 * the cost is unchanged: the same one band, on screen either way. Nothing else
 * may use this to keep an animation running on a screen that is actually
 * covered.
 *
 * **Why the opening screen sets this itself, before it navigates.** Left to the
 * message screen's mount effect, the order is: inbox loses focus (band stops,
 * snaps to the static frame) → message mounts → band restarts from zero. Two
 * visible jumps. Setting it at the tap — synchronously, in the same commit as
 * the navigate — means the answer never goes false at all. The message screen
 * still holds it for its lifetime, and the inbox clears it whenever it is
 * focused again, so a navigation that never arrives cannot leave it stuck.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/** `open`: covered, contents hidden. `closing`: on its way back, contents shown. */
export type Overlay = 'none' | 'open' | 'closing';

const ChromeContext = createContext<{
  overlay: Overlay;
  setOverlay: (state: Overlay) => void;
}>({ overlay: 'none', setOverlay: () => {} });

export function ChromeProvider({ children }: { children: React.ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay>('none');
  const value = useMemo(() => ({ overlay, setOverlay }), [overlay]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

/**
 * For the screen with the bar: what is open above it, and the setter it arms at
 * the tap that opens one. For the screen on top: how it reports the close.
 */
export function useChrome() {
  return useContext(ChromeContext);
}

/** For the screen on top: holds "the bar under me is covered" while mounted. */
export function useKeepsBarBeneath(keeps: boolean) {
  const { setOverlay } = useChrome();
  useEffect(() => {
    if (!keeps) return undefined;
    setOverlay('open');
    return () => setOverlay('none');
  }, [keeps, setOverlay]);
}
