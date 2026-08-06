/**
 * Simple UI — compose.
 *
 * The one screen in this UI with a real security decision in it. The user picks
 * **encrypted** or **unencrypted** explicitly; the app never picks for them, and
 * a blocked encrypted send never becomes a plaintext one (CLAUDE.md rule 1, and
 * the reasoning in docs/simple-ui-plan.md).
 *
 * The availability logic lives in `simple/sendMode.ts` so it can be tested
 * without mounting a screen.
 */
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { appMode, hasNativeCore } from '../../config';
import { isValidEmail } from '../../lib/format';
import { RootStackParamList } from '../../navigation';
import { defaultSendMode, evaluateSendModes, SendModeName } from '../../simple/sendMode';
import { useApp } from '../../state/AppState';
import { color, radius, space, type } from '../../theme';
import {
  Badge,
  Callout,
  Card,
  Field,
  Input,
  Mono,
  PressableRow,
  PrimaryButton,
  SecondaryButton,
  useFocus,
} from '../../ui/primitives';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Split "a@x.com, b@y.com" into addresses, keeping only well-formed ones. */
function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && isValidEmail(s));
}

export function SimpleComposeScreen() {
  const nav = useNavigation<Nav>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'SimpleCompose'>>();
  const { resolveRecipients, sendEncrypted, sendPlain } = useApp();

  const [to, setTo] = useState(params?.to ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** null until the user picks — never defaulted to `plain`. */
  const [chosen, setChosen] = useState<SendModeName | null>(null);

  const toFocus = useFocus();
  const subjectFocus = useFocus();
  const bodyFocus = useFocus();

  const addresses = useMemo(() => parseRecipients(to), [to]);
  const recipients = useMemo(() => resolveRecipients(addresses), [addresses, resolveRecipients]);
  const modes = useMemo(
    () => evaluateSendModes({ recipients, hasNativeCore, appMode }),
    [recipients],
  );

  // Encrypted is preselected whenever it works. When it doesn't, this is null
  // and the user has to make the plaintext decision deliberately.
  const mode = chosen ?? defaultSendMode(modes);
  const active = mode ? modes[mode] : null;
  const canSend = !!mode && !!active?.available && addresses.length > 0 && !sending;

  async function send() {
    if (!mode || !canSend) return;
    setSending(true);
    setFailure(null);
    try {
      const payload = { to: addresses, subject, body };
      // Two calls, never one with a flag — there is no path from a failed
      // encrypted send into the plaintext one.
      if (mode === 'encrypted') await sendEncrypted(payload);
      else await sendPlain(payload);
      nav.goBack();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Field label="To" focused={toFocus.focused}>
        <Input
          {...toFocus.bind}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={setTo}
          placeholder="name@example.com"
          value={to}
        />
      </Field>

      {addresses.length > 0 ? (
        <Card style={{ marginTop: space.sm }}>
          <Text style={styles.eyebrow}>Recipient keys</Text>
          {recipients.map((r) => (
            <View key={r.email} style={styles.rcpt}>
              <Mono style={styles.rcptAddr}>{r.email}</Mono>
              <Badge
                tone={r.status === 'missing' || r.status === 'changed' ? 'warn' : 'enc'}
                icon={r.status === 'missing' ? 'alert' : r.status === 'changed' ? 'alert' : 'lock'}
              >
                {r.status === 'verified'
                  ? 'Verified'
                  : r.status === 'ok'
                    ? 'Key on file'
                    : r.status === 'changed'
                      ? 'Key changed'
                      : 'No key'}
              </Badge>
            </View>
          ))}
        </Card>
      ) : null}

      <Field label="Subject" focused={subjectFocus.focused} style={{ marginTop: space.sm }}>
        <Input {...subjectFocus.bind} onChangeText={setSubject} placeholder="Subject" value={subject} />
      </Field>

      <Field label="Message" focused={bodyFocus.focused} style={{ marginTop: space.sm }}>
        <Input
          {...bodyFocus.bind}
          big
          multiline
          onChangeText={setBody}
          placeholder="Write your message"
          style={styles.bodyInput}
          value={body}
        />
      </Field>

      <Text style={[styles.eyebrow, { marginTop: space.lg }]}>How to send</Text>

      <ModeOption
        name="encrypted"
        title="Send encrypted"
        detail="Only the recipient can read this. Gmail stores ciphertext."
        selected={mode === 'encrypted'}
        state={modes.encrypted}
        onPress={() => setChosen('encrypted')}
      />
      <ModeOption
        name="plain"
        title="Send unencrypted"
        detail="A normal email. Anyone handling it can read it."
        selected={mode === 'plain'}
        state={modes.plain}
        onPress={() => setChosen('plain')}
      />

      {mode === null && addresses.length > 0 ? (
        <Callout>
          Encrypted send is not available for these recipients. Choose deliberately — CryptMail will
          not downgrade this message for you.
        </Callout>
      ) : null}

      {active?.warning ? (
        <View style={{ marginTop: space.md }}>
          <Callout>{active.warning}</Callout>
        </View>
      ) : null}

      {failure ? (
        <View style={{ marginTop: space.md }}>
          <Callout>{failure}</Callout>
        </View>
      ) : null}

      <View style={styles.actions}>
        <PrimaryButton
          busy={sending}
          disabled={!canSend}
          icon={mode === 'plain' ? 'mail' : 'lock'}
          onPress={() => void send()}
          title={mode === 'plain' ? 'Send unencrypted' : 'Send encrypted'}
        />
        <SecondaryButton title="Cancel" icon="close" onPress={() => nav.goBack()} />
      </View>
    </ScrollView>
  );
}

function ModeOption({
  title,
  detail,
  selected,
  state,
  onPress,
}: {
  name: SendModeName;
  title: string;
  detail: string;
  selected: boolean;
  state: { available: boolean; blockedReason?: string };
  onPress: () => void;
}) {
  return (
    <PressableRow
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !state.available }}
      disabled={!state.available}
      onPress={onPress}
      style={StyleSheet.flatten([
        styles.option,
        selected && styles.optionOn,
        !state.available && styles.optionOff,
      ])}
    >
      <View style={styles.optionHead}>
        <View style={[styles.dot, selected && styles.dotOn]} />
        <Text style={[styles.optionTitle, selected && { color: color.ink }]}>{title}</Text>
      </View>
      <Text style={styles.optionDetail}>{state.blockedReason ?? detail}</Text>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  body: { padding: space.lg, paddingBottom: space.xl * 2 },
  bodyInput: { minHeight: 140, textAlignVertical: 'top' },
  dot: {
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 2,
    height: 14,
    width: 14,
  },
  dotOn: { backgroundColor: color.brass, borderColor: color.brass },
  eyebrow: { ...type.eyebrow, color: color.inkFaint },
  option: {
    borderColor: color.lineSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: space.sm,
    padding: space.md,
  },
  optionDetail: { ...type.small, color: color.inkDim, marginTop: space.xs, paddingLeft: 22 },
  optionHead: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  optionOff: { opacity: 0.45 },
  optionOn: { borderColor: color.brass },
  optionTitle: { ...type.strong, color: color.inkDim },
  rcpt: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  rcptAddr: { ...type.meta, color: color.inkDim, flex: 1 },
});
