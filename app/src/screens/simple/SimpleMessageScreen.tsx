/**
 * Simple UI — read one message.
 *
 * Opens via `openMessage`, which decrypts, verifies the signature, harvests any
 * Autocrypt key and indexes the plaintext. All of that already lives in
 * AppState; this screen only renders the result.
 */
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { displayName, relativeTime } from '../../lib/format';
import { RootStackParamList } from '../../navigation';
import { OpenedMessage, useApp } from '../../state/AppState';
import { color, space, type } from '../../theme';
import { Badge, BadgeTone, Callout, Card, Divider, Mono, SecondaryButton } from '../../ui/primitives';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function SimpleMessageScreen() {
  const nav = useNavigation<Nav>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'SimpleMessage'>>();
  const { messages, openMessage } = useApp();

  const [opened, setOpened] = useState<OpenedMessage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const summary = messages.find((m) => m.id === params.id);

  useEffect(() => {
    let cancelled = false;
    if (!summary) return;
    (async () => {
      try {
        const result = await openMessage(summary);
        if (!cancelled) setOpened(result);
      } catch (e) {
        if (!cancelled) setFailure(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the message id: openMessage's identity changes as the keyring and
    // search index update, and re-running on that would refetch on every open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!summary) {
    return (
      <View style={styles.center}>
        <Text style={styles.gone}>That message is no longer in the list.</Text>
        <View style={{ height: space.md }} />
        <SecondaryButton title="Back" icon="back" onPress={() => nav.goBack()} />
      </View>
    );
  }

  if (failure) {
    return (
      <View style={styles.pad}>
        <Callout>{failure}</Callout>
      </View>
    );
  }

  if (!opened) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.brass} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.subject}>{opened.subject}</Text>

      <View style={styles.meta}>
        <Text style={styles.from}>{displayName(summary.from.address, summary.from.name)}</Text>
        <Text style={styles.time}>{relativeTime(summary.date)}</Text>
      </View>
      <Mono style={styles.address}>{summary.from.address}</Mono>

      <View style={styles.badges}>
        <TrustBadge opened={opened} />
      </View>

      {opened.error ? <Callout>{opened.error}</Callout> : null}

      <Card style={{ marginTop: space.lg }}>
        <Text style={styles.text}>{opened.body || '(no readable content)'}</Text>
      </Card>

      <View style={{ marginTop: space.lg }}>
        <SecondaryButton
          title={showRaw ? 'Hide what Gmail sees' : 'Show what Gmail sees'}
          icon={showRaw ? 'close' : 'search'}
          onPress={() => setShowRaw((v) => !v)}
        />
      </View>

      {showRaw ? (
        <Card style={{ marginTop: space.md }}>
          <Text style={styles.rawLabel}>Raw source stored by the provider</Text>
          <Divider />
          <Mono style={styles.raw}>{opened.raw}</Mono>
        </Card>
      ) : null}
    </ScrollView>
  );
}

/** One badge that states the whole security outcome, matching MessageScreen's vocabulary. */
function TrustBadge({ opened }: { opened: OpenedMessage }) {
  if (opened.encryption.kind === 'plain') {
    return (
      <Badge tone="plain" icon="mail">
        Not encrypted
      </Badge>
    );
  }

  const { trust, own } = opened.encryption;
  if (own) {
    return (
      <Badge tone="enc" icon="lock">
        Encrypted · your own copy
      </Badge>
    );
  }

  const label: Record<typeof trust, string> = {
    verified: 'Encrypted · verified sender',
    seen: 'Encrypted · sender trusted on first use',
    changed: 'Encrypted · sender key CHANGED',
    unknown: 'Encrypted · unknown sender key',
  };
  const tone: BadgeTone = trust === 'verified' ? 'enc' : trust === 'changed' ? 'warn' : 'plain';

  return (
    <Badge tone={tone} icon={trust === 'changed' ? 'alert' : 'lock'}>
      {label[trust]}
    </Badge>
  );
}

const styles = StyleSheet.create({
  address: { ...type.meta, color: color.inkFaint, marginTop: 2 },
  badges: { flexDirection: 'row', marginTop: space.md },
  body: { padding: space.lg, paddingBottom: space.xl * 2 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: space.lg },
  from: { ...type.strong, color: color.ink, flex: 1 },
  gone: { ...type.body, color: color.inkDim, textAlign: 'center' },
  meta: { alignItems: 'center', flexDirection: 'row', gap: space.sm, marginTop: space.md },
  pad: { padding: space.lg },
  raw: { color: color.inkFaint, fontSize: 10, lineHeight: 15, marginTop: space.sm },
  rawLabel: { ...type.eyebrow, color: color.inkFaint, marginBottom: space.sm },
  subject: { ...type.display, color: color.ink },
  text: { ...type.body, color: color.body },
  time: { ...type.meta, color: color.inkFaint },
});
