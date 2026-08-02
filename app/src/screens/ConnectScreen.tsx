import { MotiView } from 'moti';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthError } from '../auth';
import { appMode, demoReason } from '../config';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, shadow, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { Callout, Glass, Muted, Title } from '../ui/primitives';

/** Onboarding: provider OAuth, least-privilege scopes. */
export function ConnectScreen() {
  const { signIn } = useApp();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (e) {
      if (!(e instanceof AuthError && e.code === 'cancelled')) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const reason = demoReason();

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}
    >
      <Reveal delay={0}>
        <View style={s.brand}>
          <View style={s.brandMark}>
            <Icon name="lock" size={18} color={color.brassInk} strokeWidth={2.1} />
          </View>
          <Text style={s.brandText}>
            Crypt<Text style={{ fontFamily: font.displayBold }}>Mail</Text>
          </Text>
        </View>

        <Text style={s.pitch}>
          Your inbox, <Text style={s.pitchAccent}>unreadable</Text> to everyone but the person you sent it to.
        </Text>
      </Reveal>

      <Reveal delay={90}>
      <Glass contentStyle={s.card}>
        <Title>Connect your inbox</Title>
        <Muted>Keep your address. We layer encryption on top.</Muted>

        <View style={{ height: 8 }} />
        <ProviderButton
          glyph="G"
          tint={color.coral}
          label={appMode === 'demo' ? 'Continue with demo mailbox' : 'Continue with Gmail'}
          onPress={connect}
          busy={busy}
        />
        <ProviderButton glyph="⊞" tint="#6DB0FF" label="Continue with Outlook" disabled note="Phase 1" />
        <ProviderButton glyph="@" tint={color.inkDim} label="Other (IMAP / SMTP)" disabled note="Phase 1" />

        <View style={s.reassure}>
          <Icon name="shield" size={17} color={color.mint} />
          <Text style={s.reassureText}>
            Sign-in uses OAuth — we never see your password, and your private key never leaves this device.
          </Text>
        </View>

        {reason ? (
          <View style={{ marginTop: 14 }}>
            <Callout>{reason}</Callout>
          </View>
        ) : null}

        {error ? (
          <View style={{ marginTop: 14 }}>
            <Callout>{error}</Callout>
          </View>
        ) : null}
      </Glass>
      </Reveal>

      <Reveal delay={180}>
        <View style={s.guarantees}>
          <Guarantee icon="key" text="Your private key is generated here and never leaves this device." />
          <Guarantee icon="mail" text="Encrypted mail lands in your normal mailbox — as ciphertext." />
          <Guarantee icon="alert" text="No key for a recipient? CryptMail refuses to send, never downgrades." />
        </View>
      </Reveal>

      <Reveal delay={240}>
        <Text style={s.foot}>
          Prototype · Phase 0 · Gmail only, manual key exchange, no backend.
        </Text>
      </Reveal>
    </ScrollView>
  );
}

/** A block of the onboarding entrance — fades and rises into place on mount. */
function Reveal({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <MotiView
      from={{ opacity: 0, translateY: 12 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 460, delay }}
    >
      {children}
    </MotiView>
  );
}

function ProviderButton({
  glyph,
  tint,
  label,
  onPress,
  disabled,
  busy,
  note,
}: {
  glyph: string;
  tint: string;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  note?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.provider, disabled && { opacity: 0.45 }, pressed && { opacity: 0.75 }]}
    >
      <View style={[s.glyph, { borderColor: `${tint}55`, backgroundColor: `${tint}22` }]}>
        <Text style={[s.glyphText, { color: tint }]}>{glyph}</Text>
      </View>
      <Text style={s.providerLabel}>{label}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={color.brass} />
      ) : note ? (
        <Text style={s.note}>{note}</Text>
      ) : (
        <Chevron />
      )}
    </Pressable>
  );
}

/** The three promises the product is actually making, stated before sign-in. */
function Guarantee({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={s.guarantee}>
      <Icon name={icon} size={14} color={color.inkFaint} />
      <Text style={s.guaranteeText}>{text}</Text>
    </View>
  );
}

const Chevron = () => <Icon name="chevron" size={14} color={color.inkFaint} />;

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  content: { paddingHorizontal: 20 },
  brand: { alignItems: 'center', flexDirection: 'row', gap: 10, marginBottom: 22 },
  brandMark: {
    alignItems: 'center',
    backgroundColor: color.brass,
    borderRadius: radius.sm,
    height: 34,
    justifyContent: 'center',
    width: 34,
    ...shadow.raised,
  },
  brandText: { color: color.ink, fontFamily: font.display, fontSize: 18, letterSpacing: -0.3 },

  pitch: { color: color.ink, fontFamily: font.displayBold, fontSize: 27, letterSpacing: -0.5, lineHeight: 34, marginBottom: 26 },
  pitchAccent: { color: color.brass },

  card: { padding: 18 },

  provider: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderColor: glass.hairline,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginTop: 10,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  glyph: { alignItems: 'center', borderRadius: 7, borderWidth: 1, height: 26, justifyContent: 'center', width: 26 },
  glyphText: { fontFamily: font.monoMedium, fontSize: 13 },
  providerLabel: { ...type.strong, color: color.ink, flex: 1 },
  note: { ...type.eyebrow, color: color.inkFaint },

  reassure: {
    backgroundColor: color.mintBg,
    borderColor: 'rgba(87,214,163,0.25)',
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
    padding: 13,
  },
  reassureText: { color: color.mintInk, flex: 1, fontFamily: font.sans, fontSize: 12.5, lineHeight: 18 },

  guarantees: { gap: 12, marginTop: space.xl, paddingHorizontal: 4 },
  guarantee: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  guaranteeText: { ...type.small, color: color.inkDim, flex: 1 },

  foot: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11, marginTop: 26, textAlign: 'center' },
});
