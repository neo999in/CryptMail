/**
 * Display & Appearance.
 *
 * Two tabs: Theme (a preview, the light/dark/system choice, and the colour) and
 * Density.
 *
 * Colour is **one** control. It used to be two — six accent swatches and, below
 * them, the five aurora palettes — and nothing on the screen explained why the
 * band stayed cyan when the accent went red. A palette now sets the band and
 * the accent together, so there is one choice and it is whole.
 *
 * The reference also offers a header image; that is
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
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RootStackParamList } from '../navigation';
import { LIGHT_THEME_AVAILABLE, ThemeChoice } from '../store/prefsStore';
import {
  AURORA_PALETTES,
  AuroraPalette,
  color,
  Density,
  DENSITIES,
  font,
  radius,
  rowPadding,
  space,
  type,
} from '../theme';
import { useAppearance } from '../ui/appearance';
import { Icon } from '../ui/Icon';
import { Group, GroupHeading, IconButton, Radio, Segmented } from '../ui/primitives';

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

export function AppearanceScreen({ navigation }: Props) {
  const {
    accentColor,
    auroraColors,
    density,
    theme,
    setAuroraPalette,
    setDensity,
    setTheme,
  } = useAppearance();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('theme');

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <View style={s.headRow}>
          <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
          <Text style={s.title}>Display & Appearance</Text>
        </View>
        <Segmented compact stretch options={TABS} value={tab} onChange={setTab} style={s.tabs} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }} showsVerticalScrollIndicator={false}>
        <Preview accent={accentColor} density={density} />

        {tab === 'theme' ? (
          <>
            <Group style={[s.radiosGroup, s.noRing]}>
              <View style={s.radios}>
                {(Object.keys(THEME_LABEL) as ThemeChoice[]).map((choice) => (
                  <View key={choice} style={s.radioSlot}>
                    <Radio
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
                  </View>
                ))}
              </View>
            </Group>
            {/* Said plainly rather than left as a greyed-out control the user has
                to guess at. `system` is honoured as a preference and stored, but
                it resolves to dark until the palette exists — see prefsStore. */}
            {!LIGHT_THEME_AVAILABLE ? (
              <Text style={s.note}>
                Every screen is drawn for a dark ground today, so Light isn't available yet and System stays dark.
              </Text>
            ) : null}

            <GroupHeading>Colour</GroupHeading>
            <Group style={s.auroraGroup}>
              {AURORA_PALETTES.map((palette) => (
                <AuroraRow
                  key={palette.id}
                  palette={palette}
                  selected={auroraColors.id === palette.id}
                  onPress={() => setAuroraPalette(palette.id)}
                />
              ))}
            </Group>
            {/* The one thing the colour must never reach. */}
            <Text style={s.note}>
              One choice colours the light behind the inbox title and the app's own accent. Encryption state keeps its
              own colours whichever you pick, so a verified message never changes colour with a theme.
            </Text>
          </>
        ) : (
          <>
            <GroupHeading>Density</GroupHeading>
            <View style={[s.radiosGroup, s.radios]}>
              {DENSITIES.map((option) => (
                <View key={option} style={s.radioSlot}>
                  <Radio
                    label={CAPITALISED_DENSITY[option]}
                    selected={density === option}
                    onPress={() => setDensity(option)}
                  />
                </View>
              ))}
            </View>
            <Text style={s.note}>Density changes the space around a message, never the size of its text.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One aurora palette: its three ribbon hues as dots, then its name.
 *
 * The selection is drawn in the palette's *own* tint rather than the app accent
 * — this row is the one control on the screen that is not about the accent, and
 * showing the accent on it is exactly the confusion to avoid. The name carries
 * the state too, so the choice is never colour alone.
 */
function AuroraRow({
  palette,
  selected,
  onPress,
}: {
  palette: AuroraPalette;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={palette.name}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        s.auroraRow,
        selected && { borderColor: palette.accent },
        pressed && { backgroundColor: color.rowPress },
      ]}
    >
      <View style={s.auroraDots}>
        {palette.auroraColors.map((hex) => (
          <View key={hex} style={[s.auroraDot, { backgroundColor: hex }]} />
        ))}
      </View>
      <Text style={[s.auroraName, selected && { color: palette.accent }]}>{palette.name}</Text>
    </Pressable>
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
  const pad = Math.max(6, Math.round(rowPadding(density) * 0.5));
  return (
    <View accessibilityLabel="Preview of the inbox" style={s.preview}>
      <View style={s.previewBar}>
        <View style={s.previewAvatar} />
        <View style={{ flex: 1, gap: 5 }}>
          <View style={[s.previewPill, { backgroundColor: color.surfaceRaised, width: 60 }]} />
        </View>
        <View style={[s.previewChip, { borderColor: color.border }]} />
      </View>
      <View style={s.previewTabs}>
        <View style={[s.previewTab, { width: 44 }]}>
          <View style={[s.previewPill, { backgroundColor: color.ink, width: 44 }]} />
          <View style={[s.previewUnderline, { backgroundColor: accent }]} />
        </View>
        <View style={[s.previewTab, { width: 34 }]}>
          <View style={[s.previewPill, { backgroundColor: color.inkFaint, width: 34 }]} />
        </View>
      </View>
      {[0, 1].map((row) => (
        <View key={row} style={[s.previewRow, { paddingVertical: pad }]}>
          {row === 0 ? <View style={[s.previewUnreadDot, { backgroundColor: accent }]} /> : <View style={s.previewUnreadDot} />}
          <View style={s.previewRowAvatar} />
          <View style={{ flex: 1, gap: 5 }}>
            <View style={[s.previewLine, { width: '55%' }]} />
            <View style={[s.previewLine, { backgroundColor: color.inkFaint, width: '78%' }]} />
          </View>
        </View>
      ))}
      <View style={[s.previewFab, { backgroundColor: color.ink }]}>
        <Icon name="edit" size={11} color={color.ground} strokeWidth={2.4} />
        <View style={[s.previewPill, { backgroundColor: color.ground, width: 40, height: 6 }]} />
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
    backgroundColor: color.ground2,
    borderColor: color.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    marginHorizontal: space.lg,
    marginTop: space.xl,
    overflow: 'hidden',
    width: 300,
  },
  previewBar: {
    alignItems: 'center',
    backgroundColor: color.surface,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  previewAvatar: { backgroundColor: color.surfaceRaised, borderRadius: 11, height: 22, width: 22 },
  previewPill: { borderRadius: 4, height: 8 },
  previewChip: { borderRadius: 9, borderWidth: 1, height: 18, width: 18 },
  previewTabs: {
    borderBottomColor: color.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  previewTab: { alignItems: 'center', gap: 6, paddingBottom: 8 },
  previewUnderline: { borderRadius: 1, height: 2, width: '100%' },
  previewRow: {
    alignItems: 'center',
    borderColor: color.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 12,
    marginTop: 10,
    paddingHorizontal: 12,
  },
  previewUnreadDot: { backgroundColor: 'transparent', borderRadius: 3, height: 6, width: 6 },
  previewRowAvatar: { backgroundColor: color.surfaceRaised, borderRadius: 15, height: 30, width: 30 },
  previewLine: { backgroundColor: color.surfaceRaised, borderRadius: 3, height: 7 },
  previewFab: {
    alignItems: 'center',
    alignSelf: 'flex-end',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 6,
    height: 28,
    justifyContent: 'center',
    margin: 12,
    paddingHorizontal: 11,
  },

  noRing: { backgroundColor: 'transparent', borderWidth: 0 },
  radiosGroup: { marginTop: space.xl, paddingVertical: space.md },
  radios: { flexDirection: 'row', justifyContent: 'center' },
  // Equal, fixed-width columns so each ring centers evenly — a bare gap
  // between intrinsically-sized labels left the rings unevenly spaced, since
  // "Light"/"Dark"/"System" aren't the same width. Fixed rather than `flex: 1`
  // so the three cluster together at their own size instead of stretching to
  // the full width of the card.
  radioSlot: { alignItems: 'center', width: 84 },

  auroraGroup: { gap: space.sm, padding: space.md },
  auroraRow: {
    alignItems: 'center',
    borderColor: color.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  auroraDots: { flexDirection: 'row', gap: space.xs },
  auroraDot: { borderRadius: 999, height: 18, width: 18 },
  auroraName: { ...type.settingsValue, color: color.ink },


  note: {
    color: color.inkFaint,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
});
