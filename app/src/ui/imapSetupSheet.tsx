/**
 * Connecting a mailbox over IMAP/SMTP — the one sign-in that is a form.
 *
 * The ordinary path is an address and a password. The servers are looked up
 * from the address (`mail/autoconfig.ts`) and stay folded away, with the row
 * saying where they came from ("Guessed — check these"); they open when
 * signing in fails, since then they are what the user can change.
 * Signing in *is* the test: `imapAuth` logs in to both servers before anything
 * is saved, so a wrong host is found here and not at the first send.
 *
 * A sheet rather than a route because the connect screen is shown before the
 * navigator exists (`App.tsx`), and this has to open from there as well as from
 * Accounts.
 *
 * Hostnames and ports are raw addresses, so they are set in JetBrains Mono.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthError } from '../auth';
import { DiscoverySource } from '../mail/autoconfig';
import { ImapAccount } from '../mail/imap';
import { Security, ServerEndpoint } from '../mail/socket';
import { useApp } from '../state/AppState';
import { color, font, space, type } from '../theme';
import { Icon } from './Icon';
import {
  Field,
  GroupHeading,
  Input,
  PressableRow,
  PrimaryButton,
  Segmented,
  Sheet,
  Toggle,
  useFocus,
} from './primitives';
import { userMessage } from '../lib/errors';

const SECURITY_OPTIONS: { key: Security; label: string }[] = [
  { key: 'tls', label: 'SSL/TLS' },
  { key: 'starttls', label: 'STARTTLS' },
];

/** The standard port for each protocol and mode, so flipping the mode moves a default port with it. */
const DEFAULT_PORT = { imap: { tls: 993, starttls: 143 }, smtp: { tls: 465, starttls: 587 } } as const;

type Phase = 'finding' | 'connecting' | null;

export function ImapSetupSheet({
  visible,
  onClose,
  email: initialEmail,
}: {
  visible: boolean;
  onClose: () => void;
  /**
   * Signing an existing mailbox in again: the address is fixed, and its saved
   * servers are filled in. Only the password has to be typed.
   */
  email?: string;
}) {
  const { signIn, discoverImapSettings, savedImapSettings } = useApp();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [account, setAccount] = useState<ImapAccount | null>(null);
  const [source, setSource] = useState<DiscoverySource | 'saved' | 'manual' | null>(null);
  const [showServers, setShowServers] = useState(false);
  const [phase, setPhase] = useState<Phase>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh each time it opens: a half-typed password must not be waiting in a
  // sheet the next person to pick up the phone opens.
  useEffect(() => {
    if (!visible) return;
    setEmail(initialEmail ?? '');
    setPassword('');
    setAccount(null);
    setSource(null);
    setShowServers(false);
    setError(null);
    if (!initialEmail) return;
    let live = true;
    void savedImapSettings(initialEmail).then((saved) => {
      if (live && saved) {
        setAccount(saved);
        setSource('saved');
      }
    });
    return () => {
      live = false;
    };
  }, [visible, initialEmail, savedImapSettings]);

  const busy = phase !== null;
  const canSubmit = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && password.length > 0 && !busy;

  const connect = async () => {
    if (!canSubmit) return;
    setError(null);
    let servers = account;
    try {
      if (!servers) {
        setPhase('finding');
        const found = await discoverImapSettings(email.trim());
        servers = found.account;
        setAccount(servers);
        setSource(found.source);
      }
      setPhase('connecting');
      await signIn('imap', { email: email.trim(), password, account: servers });
      setPassword('');
      onClose();
    } catch (e) {
      if (e instanceof AuthError && e.code === 'cancelled') return;
      setError(userMessage(e));
      // Whatever went wrong, the servers are the thing the user can change.
      setShowServers(true);
    } finally {
      setPhase(null);
    }
  };

  const edit = (patch: Partial<ImapAccount>) => {
    setAccount((prev) => (prev ? { ...prev, ...patch } : prev));
    setSource('manual');
  };

  const openServers = async () => {
    if (showServers) {
      setShowServers(false);
      return;
    }
    setShowServers(true);
    if (!account && email.includes('@')) {
      setPhase('finding');
      try {
        const found = await discoverImapSettings(email.trim());
        setAccount(found.account);
        setSource(found.source);
      } finally {
        setPhase(null);
      }
    }
  };

  return (
    <Sheet bottomInset={insets.bottom} onClose={busy ? () => undefined : onClose} title={initialEmail ? 'Sign in again' : 'Other mailbox'} visible={visible}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: height * 0.72 }}>
        <View style={s.body}>
          <Text style={s.note}>
            For iCloud, Yahoo, Fastmail or your own server. Your password stays in this device's keystore and is
            only ever sent to the servers below, encrypted.
          </Text>

          <EmailField
            value={email}
            editable={!initialEmail && !busy}
            onChange={(text) => {
              setEmail(text);
              // Servers found for the old address say nothing about the new
              // one; servers the user typed are theirs to keep.
              if (source !== 'manual') {
                setAccount(null);
                setSource(null);
              }
            }}
          />
          <PasswordField value={password} onChange={setPassword} onSubmit={() => void connect()} disabled={busy} />
          <Text style={s.hint}>
            Use an app-specific password if your provider offers one — you can revoke it without changing your real
            password.
          </Text>

          <PressableRow
            accessibilityLabel={showServers ? 'Hide server settings' : 'Show server settings'}
            accessibilityRole="button"
            accessibilityState={{ expanded: showServers }}
            onPress={() => void openServers()}
            style={s.disclosure}
          >
            <Icon name="settings" size={17} color={color.inkDim} />
            <Text style={s.disclosureLabel}>Server settings</Text>
            <Text style={s.disclosureValue}>{describeSource(source)}</Text>
          </PressableRow>

          {showServers && account ? (
            <View>
              <ServerFields
                heading="Incoming · IMAP"
                endpoint={account.imap}
                defaults={DEFAULT_PORT.imap}
                disabled={busy}
                onChange={(imap) => edit({ imap })}
              />
              <ServerFields
                heading="Outgoing · SMTP"
                endpoint={account.smtp}
                defaults={DEFAULT_PORT.smtp}
                disabled={busy}
                onChange={(smtp) => edit({ smtp })}
              />
              <Field label="USERNAME">
                <Input
                  accessibilityLabel="Username"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  onChangeText={(username) => edit({ username })}
                  style={s.mono}
                  value={account.username}
                />
              </Field>
              <View style={s.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.toggleLabel}>Save a copy in Sent</Text>
                  <Text style={s.hint}>Off for servers that file their own copy, where it would appear twice.</Text>
                </View>
                <Toggle
                  label="Save a copy in Sent"
                  on={account.saveSentCopy}
                  onChange={(saveSentCopy) => edit({ saveSentCopy })}
                  disabled={busy}
                />
              </View>
            </View>
          ) : null}

          {error ? (
            <View accessibilityLiveRegion="polite" style={s.error}>
              <Icon name="alert" size={16} color={color.coral} />
              <Text style={s.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={s.action}>
            <PrimaryButton
              busy={busy}
              disabled={!canSubmit}
              onPress={() => void connect()}
              title={initialEmail ? 'Sign in' : 'Connect'}
            />
            {phase ? (
              <Text accessibilityLiveRegion="polite" style={s.progress}>
                {phase === 'finding' ? 'Looking up your mail servers…' : 'Signing in to both servers…'}
              </Text>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}

function describeSource(source: DiscoverySource | 'saved' | 'manual' | null): string {
  switch (source) {
    case 'provider':
      return 'From your provider';
    case 'ispdb':
      return 'From Thunderbird’s list';
    case 'guess':
      return 'Guessed — check these';
    case 'saved':
      return 'As saved';
    case 'manual':
      return 'Edited';
    default:
      return 'Automatic';
  }
}

function EmailField({
  value,
  editable,
  onChange,
}: {
  value: string;
  editable: boolean;
  onChange: (next: string) => void;
}) {
  const focus = useFocus();
  return (
    <Field focused={focus.focused} label="EMAIL ADDRESS">
      <Input
        {...focus.bind}
        accessibilityLabel="Email address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        editable={editable}
        inputMode="email"
        onChangeText={onChange}
        placeholder="you@example.com"
        style={editable ? undefined : { color: color.inkDim }}
        value={value}
      />
    </Field>
  );
}

function PasswordField({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  const focus = useFocus();
  return (
    <Field focused={focus.focused} label="PASSWORD">
      <Input
        {...focus.bind}
        accessibilityLabel="Password"
        autoCapitalize="none"
        autoComplete="password"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        placeholder="App-specific password"
        returnKeyType="go"
        secureTextEntry
        textContentType="password"
        value={value}
      />
    </Field>
  );
}

function ServerFields({
  heading,
  endpoint,
  defaults,
  disabled,
  onChange,
}: {
  heading: string;
  endpoint: ServerEndpoint;
  defaults: Record<Security, number>;
  disabled: boolean;
  onChange: (next: ServerEndpoint) => void;
}) {
  return (
    <View style={s.server}>
      {/* The heading brings a screen's gutter; this body already has one. */}
      <View style={s.heading}>
        <GroupHeading>{heading}</GroupHeading>
      </View>
      <View style={s.hostRow}>
        <Field label="SERVER" style={s.host}>
          <Input
            accessibilityLabel={`${heading} server`}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            inputMode="url"
            onChangeText={(host) => onChange({ ...endpoint, host: host.trim() })}
            style={s.mono}
            value={endpoint.host}
          />
        </Field>
        <Field label="PORT" style={s.port}>
          <Input
            accessibilityLabel={`${heading} port`}
            editable={!disabled}
            inputMode="numeric"
            maxLength={5}
            onChangeText={(text) => onChange({ ...endpoint, port: Number(text.replace(/\D/g, '')) || 0 })}
            style={s.mono}
            value={endpoint.port ? String(endpoint.port) : ''}
          />
        </Field>
      </View>
      {/* Two choices and no third: plaintext is not offered, so it cannot be
          picked by accident or talked into (docs/providers.md). */}
      <Segmented
        compact
        stretch
        options={SECURITY_OPTIONS}
        value={endpoint.security}
        onChange={(security) => {
          const other: Security = security === 'tls' ? 'starttls' : 'tls';
          const port = endpoint.port === defaults[other] ? defaults[security] : endpoint.port;
          onChange({ ...endpoint, security, port });
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: space.lg },
  note: { ...type.small, color: color.inkDim, paddingBottom: space.md },
  hint: { ...type.small, color: color.inkFaint },

  disclosure: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    marginHorizontal: -space.lg,
    marginTop: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  disclosureLabel: { ...type.settingsRow, color: color.ink, flex: 1 },
  disclosureValue: { ...type.small, color: color.inkFaint },

  server: { marginBottom: space.sm },
  heading: { marginHorizontal: -(space.lg + 2) },
  hostRow: { flexDirection: 'row', gap: space.sm },
  host: { flex: 1 },
  port: { width: 88 },
  mono: { fontFamily: font.mono, fontSize: 14 },

  toggleRow: { alignItems: 'center', flexDirection: 'row', gap: space.md, paddingVertical: space.sm },
  toggleLabel: { ...type.strong, color: color.ink },

  error: { alignItems: 'flex-start', flexDirection: 'row', gap: space.sm, paddingTop: space.md },
  errorText: { ...type.small, color: color.coralInk, flex: 1 },

  action: { gap: space.sm, paddingTop: space.lg },
  progress: { ...type.small, color: color.inkDim, textAlign: 'center' },
});
