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
  | 'menu';

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
    default:
      return <Ellipse cx={12} cy={12} rx={8} ry={8} {...p} />;
  }
}
