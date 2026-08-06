import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInputKeyPressEventData,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { isDraftEmpty } from '../drafts/drafts';
import { isValidEmail } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { RecipientState, useApp } from '../state/AppState';
import { color, font, glass, radius, shadow, type } from '../theme';
import { Icon } from '../ui/Icon';
import { Badge, Field, Glass, Input, PrimaryButton, SecondaryButton, useFocus } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

/**
 * Compose — the fail-safe moment.
 *
 * A recipient with no key blocks the send outright. The prototype has no
 * secure-link or plaintext fallback (out of scope), so the only honest options
 * are: add their key, or remove them.
 */
export function ComposeScreen({ route, navigation }: Props) {
  const { resolveRecipients, sendEncrypted, canSendEncrypted, drafts, saveDraft, deleteDraft, scheduleSend } = useApp();
  const insets = useSafeAreaInsets();

  // Resume an existing draft, or mint a fresh id for this compose session.
  const existing = route.params?.draftId ? drafts[route.params.draftId] : undefined;
  const draftId = useRef(route.params?.draftId ?? makeDraftId()).current;

  const [to, setTo] = useState<string[]>(existing?.to ?? (route.params?.to ? [route.params.to] : []));
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState(existing?.subject ?? route.params?.subject ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toFocus = useFocus();
  const subjectFocus = useFocus();
  const bodyFocus = useFocus();

  // Autosave (debounced): persist the in-progress message so it survives leaving
  // the screen, and drop it once it's empty. The store callbacks are read through
  // refs so that saving — which updates drafts state — never re-fires this effect;
  // only real edits (to/subject/body) reschedule it.
  const saveDraftRef = useRef(saveDraft);
  const deleteDraftRef = useRef(deleteDraft);
  saveDraftRef.current = saveDraft;
  deleteDraftRef.current = deleteDraft;
  // Set while leaving after a send or schedule, so a late autosave tick can't
  // resurrect a message that has already left the drafts.
  const closingRef = useRef(false);
  const [showSchedule, setShowSchedule] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (closingRef.current) return;
      if (isDraftEmpty({ to, subject, body })) void deleteDraftRef.current(draftId);
      else void saveDraftRef.current({ id: draftId, to, subject, body, updatedAt: new Date().toISOString() });
    }, 600);
    return () => clearTimeout(handle);
  }, [to, subject, body, draftId]);

  const recipients = useMemo(() => resolveRecipients(to), [resolveRecipients, to]);
  const missing = recipients.filter((r) => r.status === 'missing');
  const changed = recipients.filter((r) => r.status === 'changed');
  const gate = canSendEncrypted();

  const blocked = to.length === 0 || missing.length > 0 || changed.length > 0 || !gate.allowed;

  const add = (candidates: string[]) =>
    setTo((prev) => {
      const next = [...prev];
      for (const c of candidates) if (!next.includes(c)) next.push(c);
      return next;
    });

  /**
   * Split a blob of text into chips, keeping the trailing fragment in the field.
   * Used for pastes like "a@b.com, c@d.com" — a controlled react-native-web
   * TextInput never delivers a lone separator keystroke to `onChangeText`
   * (it swallows it), so typed separators are handled by `onKeyPress` instead.
   */
  const onChangeTo = (text: string) => {
    if (!/[,;\s]/.test(text)) {
      setDraft(text);
      return;
    }
    const parts = text.split(/[,;\s]+/);
    const remainder = parts.pop() ?? '';

    const accepted: string[] = [];
    let rejected: string | null = null;
    for (const part of parts) {
      const candidate = normalize(part);
      if (!candidate) continue;
      if (isValidEmail(candidate)) accepted.push(candidate);
      else rejected = candidate;
    }

    if (accepted.length > 0) add(accepted);
    setError(rejected ? `"${rejected}" is not a valid address.` : null);
    setDraft(remainder);
  };

  /** Space, comma and semicolon commit the current draft as a chip. */
  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if ([' ', ',', ';'].includes(e.nativeEvent.key)) {
      // Web: stop the separator from ever entering the (controlled) field.
      (e as unknown as { preventDefault?: () => void }).preventDefault?.();
      commitDraft();
    }
  };

  /** Enter, blur and separator keys commit whatever is left in the field. */
  const commitDraft = () => {
    const candidate = normalize(draft);
    if (!candidate) {
      setDraft('');
      return;
    }
    if (!isValidEmail(candidate)) {
      setError(`"${candidate}" is not a valid address.`);
      return;
    }
    add([candidate]);
    setDraft('');
    setError(null);
  };

  const send = async () => {
    setSending(true);
    setError(null);
    closingRef.current = true;
    try {
      await sendEncrypted({ to, subject: subject.trim() || '(no subject)', body });
      await deleteDraft(draftId);
      navigation.goBack();
    } catch (e) {
      closingRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const schedule = async (sendAt: Date) => {
    setError(null);
    closingRef.current = true;
    try {
      await scheduleSend({ id: draftId, to, subject: subject.trim() || '(no subject)', body, sendAt: sendAt.toISOString() });
      await deleteDraft(draftId);
      navigation.goBack();
    } catch (e) {
      closingRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={s.screen}
      keyboardVerticalOffset={90}
    >
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Field label="To" focused={toFocus.focused} tone={missing.length + changed.length > 0 ? 'warn' : 'default'}>
          {recipients.length > 0 ? (
            <View style={s.chips}>
              {recipients.map((r) => (
                <RecipientChip key={r.email} state={r} onRemove={() => setTo(to.filter((t) => t !== r.email))} />
              ))}
            </View>
          ) : null}
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            blurOnSubmit={false}
            keyboardType="email-address"
            onChangeText={onChangeTo}
            onKeyPress={onKeyPress}
            onSubmitEditing={commitDraft}
            placeholder="name@example.com"
            returnKeyType="done"
            value={draft}
            {...toFocus.bind}
            onBlur={() => {
              commitDraft();
              toFocus.bind.onBlur();
            }}
          />
        </Field>

        <Field label="Subject" focused={subjectFocus.focused}>
          <Input
            onChangeText={setSubject}
            placeholder="Encrypted inside the payload"
            value={subject}
            {...subjectFocus.bind}
          />
        </Field>

        <Field label="Message" focused={bodyFocus.focused}>
          <Input
            big
            multiline
            onChangeText={setBody}
            placeholder="Only the recipients can read this."
            value={body}
            {...bodyFocus.bind}
          />
        </Field>

        {error ? (
          <View style={s.errorRow}>
            <Icon name="alert" size={14} color={color.coral} />
            <Text style={s.error}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <Glass
        radius={0}
        border="transparent"
        intensity={glass.blur.strong}
        fill={blocked ? glass.fillWarn : glass.fillStrong}
        style={[s.sendbar, blocked && s.sendbarWarn]}
        contentStyle={[s.sendbarInner, { paddingBottom: insets.bottom + 14 }]}
      >
        <View style={s.status}>
          <Icon
            name={blocked ? 'alert' : 'lock'}
            size={17}
            color={blocked ? color.coral : color.mint}
          />
          <Text style={[s.statusText, { color: blocked ? color.coral : color.mintInk }]}>{statusLine()}</Text>
        </View>

        {missing.length > 0 ? (
          <View style={s.fallbacks}>
            <SecondaryButton title="Add their key" icon="key" onPress={() => navigation.navigate('Keys')} />
            <SecondaryButton
              title={`Remove ${missing[0].email}`}
              onPress={() => setTo(to.filter((t) => t !== missing[0].email))}
            />
          </View>
        ) : (
          <>
            <PrimaryButton
              busy={sending}
              disabled={blocked}
              icon="send"
              onPress={() => void send()}
              title={`Send encrypted${to.length > 1 ? ` to ${to.length}` : ''}`}
            />
            {!blocked ? (
              <View style={s.schedule}>
                <Pressable accessibilityRole="button" onPress={() => setShowSchedule((v) => !v)} style={s.scheduleToggle}>
                  <Icon name="clock" size={14} color={color.inkDim} />
                  <Text style={s.scheduleToggleText}>
                    {showSchedule ? 'Hide schedule options' : 'Schedule for later'}
                  </Text>
                </Pressable>
                {showSchedule ? (
                  <View style={s.presets}>
                    {SCHEDULE_PRESETS.map((preset) => (
                      <SecondaryButton
                        key={preset.label}
                        title={preset.label}
                        icon="clock"
                        onPress={() => void schedule(preset.at())}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        )}

        {gate.reason && gate.allowed ? <Text style={s.gateNote}>{gate.reason}</Text> : null}
      </Glass>
    </KeyboardAvoidingView>
  );

  function statusLine(): string {
    if (to.length === 0) return 'Add a recipient. CryptMail only sends to people you hold a key for.';
    if (missing.length > 0) {
      const names = missing.map((r) => r.email).join(', ');
      return `${names} ${missing.length > 1 ? 'have' : 'has'} no key — CryptMail will not send this as plaintext.`;
    }
    if (changed.length > 0) {
      return `${changed[0].email}'s key changed since you last saw it. Verify it before sending.`;
    }
    if (!gate.allowed) return gate.reason ?? 'Sending is disabled.';
    const verified = recipients.filter((r) => r.status === 'verified').length;
    return `Encrypted for ${recipients.length} recipient${recipients.length > 1 ? 's' : ''}${
      verified ? ` · ${verified} verified` : ''
    }${cryptoMode === 'demo' ? ' (demo)' : ''}`;
  }
}

const normalize = (value: string) => value.trim().replace(/^[<]|[>,;]+$/g, '').toLowerCase();

const makeDraftId = () => `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const SCHEDULE_PRESETS: { label: string; at: () => Date }[] = [
  { label: 'In 1 hour', at: () => new Date(Date.now() + 60 * 60 * 1000) },
  { label: 'In 3 hours', at: () => new Date(Date.now() + 3 * 60 * 60 * 1000) },
  {
    label: 'Tomorrow 9 AM',
    at: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
];

function RecipientChip({ state, onRemove }: { state: RecipientState; onRemove: () => void }) {
  const badge =
    state.status === 'verified'
      ? { tone: 'enc' as const, icon: 'lock' as const, label: 'verified' }
      : state.status === 'ok'
        ? { tone: 'enc' as const, icon: 'lock' as const, label: 'key found' }
        : state.status === 'changed'
          ? { tone: 'warn' as const, icon: 'alert' as const, label: 'key changed' }
          : { tone: 'warn' as const, icon: 'alert' as const, label: 'no key' };

  const warn = state.status === 'missing' || state.status === 'changed';

  return (
    <View style={[s.chip, warn && s.chipWarn]}>
      <Text style={s.chipText}>{state.email}</Text>
      <Badge tone={badge.tone} icon={badge.icon}>
        {badge.label}
      </Badge>
      <Pressable
        accessibilityLabel={`Remove ${state.email}`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onRemove}
        style={({ pressed }) => [s.chipRemove, pressed && { backgroundColor: color.line }]}
      >
        <Icon name="close" size={11} color={color.inkDim} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 9 },
  chip: {
    alignItems: 'center',
    backgroundColor: color.panel2,
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingLeft: 11,
    paddingRight: 4,
    paddingVertical: 4,
  },
  chipWarn: { borderColor: color.coralLine },
  chipText: { color: color.ink, fontFamily: font.sans, fontSize: 12.5 },
  chipRemove: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },

  errorRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 4 },
  error: { color: color.coral, flex: 1, fontFamily: font.sans, fontSize: 13 },

  sendbar: {
    borderTopColor: glass.hairline,
    borderTopWidth: 1,
    ...shadow.sheet,
  },
  sendbarInner: { paddingHorizontal: 16, paddingTop: 15 },
  sendbarWarn: { borderTopColor: color.coralLine },
  status: { alignItems: 'flex-start', flexDirection: 'row', gap: 9, marginBottom: 12 },
  statusText: { flex: 1, fontFamily: font.sansMedium, fontSize: 13, lineHeight: 18 },
  fallbacks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gateNote: { ...type.eyebrow, color: color.inkFaint, marginTop: 10, textAlign: 'center', textTransform: 'none' },

  schedule: { marginTop: 10 },
  scheduleToggle: { alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: 6, paddingVertical: 6 },
  scheduleToggleText: { ...type.meta, color: color.inkDim },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 8 },
});
