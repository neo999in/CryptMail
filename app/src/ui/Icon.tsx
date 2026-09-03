import React from 'react';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import { color } from '../theme';

/** The icon set from the design doc's <symbol> sheet. */
export type IconName =
  | 'lock'
  | 'key'
  | 'shield'
  | 'mail'
  | 'alert'
  | 'check'
  | 'link'
  | 'refresh'
  | 'search'
  | 'plus'
  | 'back'
  | 'send'
  | 'copy'
  | 'close'
  | 'chevron'
  | 'signout'
  | 'inbox'
  | 'user'
  | 'users'
  | 'edit'
  | 'star'
  | 'archive'
  | 'clock'
  | 'reply'
  | 'reply-all'
  | 'forward'
  | 'paperclip'
  | 'image'
  | 'file'
  | 'download'
  | 'menu'
  | 'more'
  | 'junk'
  | 'trash'
  | 'settings'
  | 'bell'
  | 'palette'
  | 'signature'
  | 'accessibility'
  | 'globe'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'list-ul'
  | 'list-ol'
  | 'quote'
  | 'hr';

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Fill colour for solid glyphs (e.g. a starred star). Defaults to none (outline). */
  fill?: string;
};

export function Icon({ name, size = 16, color: stroke = color.inkDim, strokeWidth = 1.9, fill = 'none' }: Props) {
  const common = {
    stroke,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {glyph(name, common)}
    </Svg>
  );
}

function glyph(name: IconName, p: object) {
  switch (name) {
    case 'lock':
      return (
        <>
          <Rect x={4} y={11} width={16} height={10} rx={2} {...p} />
          <Path d="M8 11V7a4 4 0 0 1 8 0v4" {...p} />
        </>
      );
    case 'key':
      return (
        <>
          <Circle cx={8} cy={16} r={4} {...p} />
          <Path d="M11 13 21 3m-3 0 3 3-3 3" {...p} />
        </>
      );
    case 'shield':
      return (
        <>
          <Path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3z" {...p} />
          <Path d="M9 12l2 2 4-4" {...p} />
        </>
      );
    case 'mail':
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={2} {...p} />
          <Path d="m3 7 9 6 9-6" {...p} />
        </>
      );
    case 'alert':
      return (
        <>
          <Path d="M12 4 3 20h18L12 4z" {...p} />
          <Path d="M12 10v4" {...p} />
          <Path d="M12 17.5v.01" {...p} />
        </>
      );
    case 'check':
      return <Path d="M20 6 9 17l-5-5" {...p} />;
    case 'link':
      return (
        <>
          <Path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" {...p} />
          <Path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" {...p} />
        </>
      );
    case 'refresh':
      return (
        <>
          <Path d="M21 12a9 9 0 1 1-3-6.7L21 8" {...p} />
          <Path d="M21 3v5h-5" {...p} />
        </>
      );
    case 'search':
      return (
        <>
          <Circle cx={11} cy={11} r={7} {...p} />
          <Path d="m21 21-4-4" {...p} />
        </>
      );
    case 'plus':
      return <Path d="M12 5v14M5 12h14" {...p} />;
    case 'back':
      return <Path d="M19 12H5m6-7-7 7 7 7" {...p} />;
    case 'send':
      return (
        <>
          <Path d="M21 3 10.5 13.5" {...p} />
          <Path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3z" {...p} />
        </>
      );
    case 'copy':
      return (
        <>
          <Rect x={9} y={9} width={12} height={12} rx={2} {...p} />
          <Path d="M5 15V5a2 2 0 0 1 2-2h10" {...p} />
        </>
      );
    case 'close':
      return <Path d="M18 6 6 18M6 6l12 12" {...p} />;
    case 'chevron':
      return <Path d="m9 5 7 7-7 7" {...p} />;
    case 'signout':
      return (
        <>
          <Path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" {...p} />
          <Path d="M10 8 6 12l4 4M6 12h9" {...p} />
        </>
      );
    case 'inbox':
      return (
        <>
          <Rect x={3} y={4} width={18} height={16} rx={2} {...p} />
          <Path d="M3 13h4l2 3h6l2-3h4" {...p} />
        </>
      );
    case 'user':
      return (
        <>
          <Circle cx={12} cy={8.5} r={3.5} {...p} />
          <Path d="M5 20a7 7 0 0 1 14 0" {...p} />
        </>
      );
    // Two figures, the second half-hidden behind the first — the address book,
    // told apart from the single `user` that means the account.
    case 'users':
      return (
        <>
          <Circle cx={9.5} cy={8.5} r={3.2} {...p} />
          <Path d="M3.5 20a6 6 0 0 1 12 0" {...p} />
          <Path d="M16 5.6a3.2 3.2 0 0 1 0 5.8" {...p} />
          <Path d="M17.5 14.4A6 6 0 0 1 20.5 20" {...p} />
        </>
      );
    case 'edit':
      return (
        <>
          <Path d="M5 19h4L19 9a2 2 0 0 0-3-3L6 16l-1 3z" {...p} />
          <Path d="m14 8 3 3" {...p} />
        </>
      );
    case 'star':
      return <Path d="M12 3.5l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.75-5.2 2.75 1-5.8-4.2-4.1 5.8-.85L12 3.5z" {...p} />;
    case 'archive':
      return (
        <>
          <Rect x={3} y={4} width={18} height={4} rx={1} {...p} />
          <Path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" {...p} />
          <Path d="M10 12h4" {...p} />
        </>
      );
    case 'clock':
      return (
        <>
          <Circle cx={12} cy={12} r={9} {...p} />
          <Path d="M12 7.5V12l3 2" {...p} />
        </>
      );
    case 'reply':
      return (
        <>
          <Path d="M9 17 4 12l5-5" {...p} />
          <Path d="M20 18v-2a4 4 0 0 0-4-4H4" {...p} />
        </>
      );
    case 'reply-all':
      return (
        <>
          <Path d="M7 17 2 12l5-5" {...p} />
          <Path d="M12 17 7 12l5-5" {...p} />
          <Path d="M22 18v-2a4 4 0 0 0-4-4H7" {...p} />
        </>
      );
    case 'forward':
      return (
        <>
          <Path d="M15 17 20 12l-5-5" {...p} />
          <Path d="M4 18v-2a4 4 0 0 1 4-4h12" {...p} />
        </>
      );
    case 'paperclip':
      return <Path d="M20 11.5 12.4 19a4.5 4.5 0 0 1-6.4-6.4l7.6-7.6a3 3 0 0 1 4.2 4.2l-7.5 7.6a1.5 1.5 0 0 1-2.2-2.1l6.8-6.9" {...p} />;
    case 'image':
      return (
        <>
          <Rect x={3} y={5} width={18} height={14} rx={2} {...p} />
          <Circle cx={8.5} cy={10} r={1.5} {...p} />
          <Path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" {...p} />
        </>
      );
    case 'file':
      return (
        <>
          <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" {...p} />
          <Path d="M14 3v5h5" {...p} />
        </>
      );
    case 'download':
      return (
        <>
          <Path d="M12 4v11" {...p} />
          <Path d="m7.5 11 4.5 4.5 4.5-4.5" {...p} />
          <Path d="M5 19h14" {...p} />
        </>
      );
    case 'menu':
      return <Path d="M4 7h16M4 12h16M4 17h16" {...p} />;
    // Filled, not stroked: three 1.1-radius rings read as smudges at 20px, and
    // this is the one glyph in the set that is dots rather than a drawing.
    case 'more':
      return (
        <>
          <Circle cx={12} cy={5} r={1.85} fill={(p as { stroke: string }).stroke} stroke="none" />
          <Circle cx={12} cy={12} r={1.85} fill={(p as { stroke: string }).stroke} stroke="none" />
          <Circle cx={12} cy={19} r={1.85} fill={(p as { stroke: string }).stroke} stroke="none" />
        </>
      );
    case 'junk':
      return (
        <>
          <Path d="M3 7V6a2 2 0 0 1 2-2h3.5l2 2H15" {...p} />
          <Path d="M3 9h9" {...p} />
          <Path d="M3 9v9a2 2 0 0 0 2 2h8" {...p} />
          <Circle cx={17.5} cy={15.5} r={4.5} {...p} />
          <Path d="m14.3 18.7 6.4-6.4" {...p} />
        </>
      );
    case 'trash':
      return (
        <>
          <Path d="M4 6h16" {...p} />
          <Path d="M9 6V4h6v2" {...p} />
          <Path d="M6 6v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" {...p} />
          <Path d="M10 11v6M14 11v6" {...p} />
        </>
      );
    // A cog, not a sunburst. This used to be a circle with eight straight
    // spokes radiating off it, which is the standard brightness glyph — beside
    // `palette` in the drawer it read as a second display control rather than
    // as Settings. The teeth are joined to the rim so the ring closes.
    case 'settings':
      return (
        <>
          <Path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            {...p}
          />
          <Circle cx={12} cy={12} r={3} {...p} />
        </>
      );
    case 'bell':
      return (
        <>
          <Path d="M18 16V11a6 6 0 1 0-12 0v5l-1.5 2.5h15L18 16z" {...p} />
          <Path d="M10 21h4" {...p} />
        </>
      );
    case 'palette':
      return (
        <>
          <Path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-1.6-1.3-1.8-1.3-3 0-.9.8-1.7 1.8-1.7H16a5 5 0 0 0 5-5c0-3.6-4-6.5-9-6.5z" {...p} />
          <Circle cx={8} cy={11} r={1.2} {...p} />
          <Circle cx={12} cy={8} r={1.2} {...p} />
          <Circle cx={16} cy={10.5} r={1.2} {...p} />
        </>
      );
    case 'signature':
      return (
        <>
          <Path d="M3 17c3 0 3.5-9 6-9s1.5 9 4 9c1.6 0 2.4-2.5 4-2.5" {...p} />
          <Path d="M4 21h16" {...p} />
        </>
      );
    case 'accessibility':
      return (
        <>
          <Circle cx={12} cy={4.5} r={1.8} {...p} />
          <Path d="M5 9h14" {...p} />
          <Path d="M12 8.5V15" {...p} />
          <Path d="m9 21 3-6 3 6" {...p} />
        </>
      );
    case 'globe':
      return (
        <>
          <Circle cx={12} cy={12} r={9} {...p} />
          <Path d="M3 12h18" {...p} />
          <Path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" {...p} />
        </>
      );
    case 'bold':
      return (
        <>
          <Path d="M7 4h6.5a3.5 3.5 0 0 1 0 7H7z" {...p} />
          <Path d="M7 11h7.5a3.5 3.5 0 0 1 0 7H7z" {...p} />
        </>
      );
    case 'italic':
      return (
        <>
          <Path d="M10 4h7" {...p} />
          <Path d="M7 20h7" {...p} />
          <Path d="m14 4-4 16" {...p} />
        </>
      );
    case 'strike':
      return (
        <>
          <Path d="M16 4H9a3 3 0 0 0-2.8 4.2" {...p} />
          <Path d="M8 20h7a3 3 0 0 0 2.6-4.5" {...p} />
          <Path d="M4 12h16" {...p} />
        </>
      );
    case 'list-ul':
      return (
        <>
          <Circle cx={4.5} cy={6} r={1} {...p} />
          <Circle cx={4.5} cy={12} r={1} {...p} />
          <Circle cx={4.5} cy={18} r={1} {...p} />
          <Path d="M9 6h11M9 12h11M9 18h11" {...p} />
        </>
      );
    case 'list-ol':
      return (
        <>
          <Path d="M4 5h1v3M3.5 8h2" {...p} />
          <Path d="M4 10c1 0 1.5.5 1.5 1.5S4 14 3 15c1 0 2.5.5 2.5 1.5S4.5 18 3.5 18" {...p} />
          <Path d="M9 6h11M9 12h11M9 18h11" {...p} />
        </>
      );
    case 'quote':
      return (
        <>
          <Path d="M4 20V10a6 6 0 0 1 6-6" {...p} />
          <Path d="M14 20v-6a6 6 0 0 1 6-6" {...p} />
        </>
      );
    case 'hr':
      return <Path d="M3 12h18" {...p} />;
    default:
      return <Ellipse cx={12} cy={12} rx={8} ry={8} {...p} />;
  }
}
