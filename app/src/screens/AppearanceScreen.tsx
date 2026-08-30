/**
 * Display & Appearance.
 *
 * Two tabs: Theme (a preview, the light/dark/system choice, and the accent
 * swatches) and Density. The reference also offers a header image; that is
 * deliberately absent — a photo behind the top bar lights every pixel of it, and
 * the true-black ground is a considered decision this rework does not undo. See
 * docs/design/ui-rework.md.
 *
 * The preview is built from the same tokens the inbox uses, so it cannot drift
 * away from what the app actually looks like — a preview that lies is worse than
 * no preview.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RootStackParamList } from '../navigation';
import { LIGHT_THEME_AVAILABLE, ThemeChoice } from '../store/prefsStore';
import { accents, ACCENT_NAMES, color, Density, DENSITIES, font, ON_ACCENT, radius, rowPadding, space, type } from '../theme';
import { useAppearance } from '../ui/appearance';
import { Icon } from '../ui/Icon';
import { GroupHeading, IconButton, Radio, Segmented, Swatch } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Appearance'>;

type Tab = 'theme' | 'density';

const TABS: { key: Tab; label: string }[] = [
  { key: 'theme', label: 'Theme' },
  { key: 'density', label: 'Density' },
];

/** Shown on the Settings row's value line, so both screens agree on the words. */
export const THEME_LABEL: Record<ThemeChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export const CAPITALISED_DENSITY: Record<Density, string> = {
  compact: 'Compact',
  cosy: 'Cosy',
  roomy: 'Roomy',
};

const DENSITY_HINT: Record<Density, string> = {
  compact: 'The most mail on screen at once.',
  cosy: 'A middle setting.',
  roomy: 'The most room around each message.',
};

export function AppearanceScreen({ navigation }: Props) {
  const { accent, accentColor, density, theme, setAccent, setDensity, setTheme } = useAppearance();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('theme');

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <View style={s.headRow}>
          <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
          <Text style={s.title}>Display & Appearance</Text>
        </View>
        <Segmented options={TABS} value={tab} onChange={setTab} style={s.tabs} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <Preview accent={accentColor} density={density} />

        {tab === 'theme' ? (
          <>
            <View style={s.radios}>
              {(Object.keys(THEME_LABEL) as ThemeChoice[]).map((choice) => (
                <Radio
                  key={choice}
                  label={THEME_LABEL[choice]}
                  selected={theme === choice}
                  disabled={choice === 'light' && !LIGHT_THEME_AVAILABLE}
                  hint={
                    choice === 'light' && !LIGHT_THEME_AVAILABLE
                      ? 'A light palette is not built yet'
                      : undefined
                  }
                  onPress={() => setTheme(choice)}
                />
              ))}
            </View>
            {/* Said plainly rather than left as a greyed-out control the user has
                to guess at. `system` is honoured as a preference and stored, but
                it resolves to dark until the palette exists — see prefsStore. */}
            {!LIGHT_THEME_AVAILABLE ? (
              <Text style={s.note}>
                Every screen is drawn for a dark ground today, so Light isn't available yet and System stays dark.
              </Text>
            ) : null}

            <GroupHeading>Colours</GroupHeading>
            <View style={s.swatches}>
              {ACCENT_NAMES.map((name) => (
                <Swatch
                  key={name}
                  label={name}
                  onPress={() => setAccent(name)}
                  selected={accent === name}
                  tint={accents[name]}
                />
              ))}
            </View>
            {/* The one thing the accent must never reach. */}
            <Text style={s.note}>
              The accent colours menus and controls. Encryption state keeps its own colours at every accent, so a
              verified message never changes colour with a theme.
            </Text>
          </>
        ) : (
          <>
            <GroupHeading>Density</GroupHeading>
            {DENSITIES.map((option) => (
              <View key={option} style={s.densityRow}>
                <Radio
                  label={CAPITALISED_DENSITY[option]}
                  selected={density === option}
                  onPress={() => setDensity(option)}
                />
                <Text style={s.densityHint}>{DENSITY_HINT[option]}</Text>
              </View>
            ))}
            <Text style={s.note}>Density changes the space around a message, never the size of its text.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * A miniature of the inbox: the top bar, two rows, and the compose button.
 *
 * Deliberately built from the live tokens and the live density rather than a
 * static image, so changing a swatch or a density changes the picture the same
 * way it changes the app.
 */
function Preview({ accent, density }: { accent: string; density: Density }) {
  const pad = Math.round(rowPadding(density) * 0.6);
  return (
    <View accessibilityLabel="Preview of the inbox" style={s.preview}>
      <View style={[s.previewBar, { backgroundColor: accent }]}>
        <View style={s.previewAvatar} />
        <View style={[s.previewPill, { width: 66 }]} />
        <View style={{ flex: 1 }} />
        <View style={[s.previewPill, { width: 34 }]} />
      </View>
      {[0, 1].map((row) => (
        <View key={row} style={[s.previewRow, { paddingVertical: pad }]}>
          <View style={s.previewRowAvatar} />
          <View style={{ flex: 1, gap: 5 }}>
            <View style={[s.previewLine, { width: '55%' }]} />
            <View style={[s.previewLine, { width: '78%' }]} />
            <View style={[s.previewLine, { backgroundColor: color.lineSoft, width: '64%' }]} />
          </View>
          <View style={[s.previewDate, { backgroundColor: accent }]} />
        </View>
      ))}
      <View style={[s.previewFab, { backgroundColor: accent }]}>
        <Icon name="edit" size={13} color={ON_ACCENT} strokeWidth={2.2} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  topbar: { backgroundColor: color.surface, paddingBottom: space.md },
  headRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm, paddingHorizontal: space.md },
  title: { ...type.display, color: color.ink, flex: 1 },
  tabs: { marginHorizontal: space.lg, marginTop: space.md },

  preview: {
    alignSelf: 'center',
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: space.xl,
    overflow: 'hidden',
    width: 260,
  },
  previewBar: { alignItems: 'center', flexDirection: 'row', gap: 8, padding: 12 },
  previewAvatar: { backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 9, height: 18, width: 18 },
  previewPill: { backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 4, height: 8 },
  previewRow: {
    alignItems: 'center',
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
  },
  previewRowAvatar: { backgroundColor: color.surfaceRaised, borderRadius: 13, height: 26, width: 26 },
  previewLine: { backgroundColor: color.surfaceRaised, borderRadius: 3, height: 6 },
  previewDate: { borderRadius: 3, height: 6, width: 18 },
  previewFab: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    borderRadius: 13,
    height: 26,
    justifyContent: 'center',
    margin: 10,
    width: 26,
  },

  radios: { flexDirection: 'row', gap: space.xl, justifyContent: 'center', paddingTop: space.xl },

  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },

  densityRow: { paddingHorizontal: space.lg, paddingVertical: space.md },
  densityHint: { ...type.settingsValue, color: color.inkFaint, marginTop: 4, textAlign: 'center' },

  note: {
    color: color.inkFaint,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
});
