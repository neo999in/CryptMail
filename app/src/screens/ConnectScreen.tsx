import { MotiView } from 'moti';
import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthError, Provider } from '../auth';
import { canConnectGmail, canConnectImap, canConnectOutlook, degradedReason } from '../config';
import { useApp } from '../state/AppState';
import { color, font, motion, radius, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { ImapSetupSheet } from '../ui/imapSetupSheet';
import { Banner, Callout, Group, PressableRow } from '../ui/primitives';
import { useAccent } from '../ui/appearance';
import { GoogleLogo, MicrosoftLogo } from '../ui/providerLogos';
import { userMessage } from '../lib/errors';

/** Onboarding: provider OAuth with least-privilege scopes, or IMAP/SMTP with a password. */
export function ConnectScreen() {
  const { signIn } = useApp();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  /** Which provider is mid-sign-in, so only its button spins. */
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imapOpen, setImapOpen] = useState(false);

  const connect = async (provider: Provider) => {
    setBusy(provider);
    setError(null);
    try {
      await signIn(provider);
    } catch (e) {
      if (!(e instanceof AuthError && e.code === 'cancelled')) {
        setError(userMessage(e));
      }
    } finally {
      setBusy(null);
    }
  };

  const reason = degradedReason();

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + space.xl }]}
      showsVerticalScrollIndicator={false}
    >
      <Reveal step={0}>
        <View style={s.brand}>
          <View style={s.brandMark}>
            <Icon name="lock" size={18} color={color.ink} strokeWidth={2.1} />
          </View>
          <Text style={s.brandText}>
            Crypt<Text style={{ fontFamily: font.displayBold }}>Mail</Text>
          </Text>
        </View>

        <Text style={s.pitch}>
          Your inbox, <Text style={{ color: accent }}>unreadable</Text> to everyone but the person you sent it to.
        </Text>
        <Text style={s.lede}>Keep your address. CryptMail layers end-to-end encryption on top of it.</Text>
      </Reveal>

      <Reveal step={1}>
        <Text style={s.heading}>Connect your inbox</Text>
        {/* With no OAuth client there is nothing to sign in to. The button is
            disabled rather than hidden, so the reason below it has something to
            explain — and so nobody goes looking for a mailbox that was never
            going to appear. */}
        <Group style={s.flush}>
          <ProviderRow
            glyph={<GoogleLogo size={18} />}
            label="Continue with Gmail"
            onPress={() => void connect('gmail')}
            busy={busy === 'gmail'}
            disabled={!canConnectGmail || (busy !== null && busy !== 'gmail')}
            note={canConnectGmail ? undefined : 'Not configured'}
          />
          <ProviderRow
            glyph={<MicrosoftLogo size={16} />}
            label="Continue with Outlook"
            onPress={() => void connect('outlook')}
            busy={busy === 'outlook'}
            disabled={!canConnectOutlook || (busy !== null && busy !== 'outlook')}
            note={canConnectOutlook ? undefined : 'Not configured'}
          />
          <ProviderRow
            glyph="@"
            label="Other (IMAP / SMTP)"
            onPress={() => setImapOpen(true)}
            disabled={!canConnectImap || busy !== null}
            note={canConnectImap ? undefined : 'Needs a dev build'}
          />
        </Group>

        {error ? (
          <View style={s.stack}>
            <Callout>{error}</Callout>
          </View>
        ) : null}
        {reason ? (
          <View style={s.stack}>
            <Callout>{reason}</Callout>
          </View>
        ) : null}

        <View style={s.stack}>
          {/* Two sentences because there are two cases, and the second is the
              one that must not be hidden: an IMAP mailbox *does* hand this app
              a password. Where it goes is the promise that can be kept. */}
          <Banner tone="ok" icon="shield">
            Gmail and Outlook sign in with OAuth — CryptMail never sees those passwords. An IMAP password stays in
            this device's keystore and is only sent to your mail server, encrypted.
          </Banner>
        </View>
      </Reveal>

      <Reveal step={2}>
        <Text style={s.heading}>What CryptMail promises</Text>
        <Group style={s.flush}>
          <Guarantee icon="key" title="Your key stays here" text="Your private key is generated on this device and never leaves it." />
          <Guarantee icon="mail" title="Same mailbox" text="Encrypted mail lands in your normal inbox — as ciphertext to anyone else." />
          {/* Rule 1, said the way it actually behaves: held in the outbox while
              an invite goes out, never sent in the clear. */}
          <Guarantee icon="lock" title="Never downgraded" text="No key for a recipient yet? The message waits in your outbox — it is never sent unencrypted." />
        </Group>
      </Reveal>

      <Reveal step={3}>
        <Text style={s.foot}>Prototype · Phase 0</Text>
      </Reveal>

      <ImapSetupSheet visible={imapOpen} onClose={() => setImapOpen(false)} />
    </ScrollView>
  );
}

/**
 * A block of the onboarding entrance — fades and rises into place on mount.
 *
 * Discrete motion, so it answers to reduced motion alone, and honouring it
 * means arriving in place rather than staying hidden.
 */
function Reveal({ step, children }: { step: number; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return <View>{children}</View>;
  return (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: motion.base, delay: step * 60 }}
    >
      {children}
    </MotiView>
  );
}

function ProviderRow({
  glyph,
  label,
  onPress,
  disabled,
  busy,
  note,
}: {
  /** A provider's mark, or a character standing in where there is none. */
  glyph: React.ReactNode;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Why the row is unavailable — shown, and read out. */
  note?: string;
}) {
  return (
    <PressableRow
      accessibilityHint={note}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={s.provider}
    >
      {/* The provider's own mark on a neutral tile — never a letter tinted in a
          trust colour, which read as the colour of a blocked send. */}
      <View style={[s.glyph, disabled && { opacity: 0.5 }]}>
        {typeof glyph === 'string' ? <Text style={s.glyphText}>{glyph}</Text> : glyph}
      </View>
      <Text style={[s.providerLabel, disabled && { color: color.inkFaint }]}>{label}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={color.ink} />
      ) : note ? (
        <Text style={s.note}>{note}</Text>
      ) : (
        <Icon name="chevron" size={16} color={color.inkDim} />
      )}
    </PressableRow>
  );
}

/** The promises the product is actually making, stated before sign-in. */
function Guarantee({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <View style={s.guarantee}>
      <Icon name={icon} size={20} color={color.inkDim} />
      <View style={{ flex: 1 }}>
        <Text style={s.guaranteeTitle}>{title}</Text>
        <Text style={s.guaranteeText}>{text}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  content: { paddingHorizontal: space.lg },

  brand: { alignItems: 'center', flexDirection: 'row', gap: space.sm, marginBottom: space.xl },
  brandMark: {
    alignItems: 'center',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  brandText: { color: color.ink, fontFamily: font.display, fontSize: 18, letterSpacing: -0.3 },

  pitch: { color: color.ink, fontFamily: font.displayBold, fontSize: 28, letterSpacing: -0.5, lineHeight: 35 },
  lede: { ...type.body, color: color.inkDim, marginTop: space.md },

  heading: { ...type.heading, color: color.ink, marginBottom: space.md, marginTop: space.xl + space.sm },
  // The screen already carries the gutter; `Group` brings its own for
  // full-width settings lists.
  flush: { marginHorizontal: 0 },
  stack: { marginTop: space.md },

  provider: { alignItems: 'center', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 15 },
  glyph: {
    alignItems: 'center',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.pill,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  glyphText: { color: color.ink, fontFamily: font.sansBold, fontSize: 14 },
  providerLabel: { ...type.settingsRow, color: color.ink, flex: 1 },
  note: { ...type.small, color: color.inkFaint },

  guarantee: { alignItems: 'flex-start', flexDirection: 'row', gap: space.lg, padding: space.lg },
  guaranteeTitle: { ...type.strong, color: color.ink },
  guaranteeText: { ...type.small, color: color.inkDim, marginTop: 2 },

  foot: { ...type.small, color: color.inkFaint, marginTop: space.xl, textAlign: 'center' },
});
