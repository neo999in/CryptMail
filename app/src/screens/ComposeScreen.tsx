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
import { Contact, searchContacts } from '../contacts/contacts';
import { useContacts } from '../contacts/useContacts';
import { isDraftEmpty } from '../drafts/drafts';
import { pickFiles, readPickedFile } from '../lib/files';
import { displayName, initials, isValidEmail } from '../lib/format';
import {
  Attachment,
  addAttachment,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  removeAttachment,
  splitForStorage,
  totalBytes,
} from '../mail/attachment';
import { RootStackParamList } from '../navigation';
import { RecipientState, useApp } from '../state/AppState';
import { color, font, glass, radius, shadow, type } from '../theme';
import { useDestination } from '../ui/destination';
import { confirmDialog } from '../ui/dialog';
import { AttachmentChip } from '../ui/attachments';
import { Icon } from '../ui/Icon';
import { Avatar, Badge, Field, Input, PrimaryButton, SecondaryButton, useFocus } from '../ui/primitives';
import { useToast } from '../ui/ToastContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

/**
 * Compose — the fail-safe moment.
 *
 * A recipient whose key *changed* blocks the send outright; one with no key yet
 * is invited and the message is held. Neither is ever resolved by sending in the
 * clear.
 *
 * ## The two modes, and why the choice sits at the top
 *
 * encryption.md permits exactly one unencrypted path, and specifies its shape:
 * "the independent 'send an unencrypted email' action, which the user picks **up
 * front** for a message they never believed was encrypted."
 *
 * Up front is the whole of it. An unencrypted option offered *after* encryption
 * has failed — next to "their key changed", or beside a queued message — is the
 * plaintext downgrade rule 1 exists to forbid, no matter that a human taps it.
 * So the mode is chosen before the message is written, it defaults to encrypted,
 * and it does not appear in any of the blocked branches below. Switching *into*
 * plaintext asks first; switching back is free.
 *
 * While the screen is in plaintext mode it makes no key lookups and reads no
 * recipient key state: there is no decision here that could depend on one.
 */
type SendMode = 'encrypted' | 'plain';

export function ComposeScreen({ route, navigation }: Props) {
  const {
    resolveRecipients,
    discoverRecipients,
    discovering,
    undiscoverable,
    directoryName,
    sendEncrypted,
    sendPlain,
    canSendEncrypted,
    drafts,
    saveDraft,
    deleteDraft,
    scheduleSend,
    cancelScheduled,
  } = useApp();
  const contacts = useContacts();
  const { setDestination } = useDestination();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();

  // Resume an existing draft, or mint a fresh id for this compose session.
  const existing = route.params?.draftId ? drafts[route.params.draftId] : undefined;
  const draftId = useRef(route.params?.draftId ?? makeDraftId()).current;

  const [to, setTo] = useState<string[]>(existing?.to ?? route.params?.to ?? []);
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState(existing?.subject ?? route.params?.subject ?? '');
  const [body, setBody] = useState(existing?.body ?? route.params?.quotedBody ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(
    existing?.attachments ?? route.params?.attachments ?? [],
  );
  /** Set while the picker is open or a chosen file is being read off disk. */
  const [attaching, setAttaching] = useState(false);
  // Threading metadata for a reply/forward. Read-only for the life of this
  // compose session — a reply's conversation is fixed the moment it opens — so
  // it is derived, not state: from a resumed draft first, then the route params.
  // It rides onto the wire (In-Reply-To/References) so the response threads.
  const inReplyTo = existing?.inReplyTo ?? route.params?.inReplyTo;
  const references = existing?.references ?? route.params?.references;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Encrypted unless the user says otherwise, every time this screen opens. */
  const [mode, setMode] = useState<SendMode>('encrypted');
  /** Set when the message was held for a key rather than delivered. */
  const [queued, setQueued] = useState<string[] | null>(null);
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
      if (isDraftEmpty({ to, subject, body, attachments })) void deleteDraftRef.current(draftId);
      else {
        // A draft is sealed JSON in AsyncStorage, which cannot take a 25 MB
        // file — so the big ones stay in this screen's memory and the draft
        // records their names. `unsaved` below is what tells the user.
        const { stored, omitted } = splitForStorage(attachments);
        void saveDraftRef.current({
          id: draftId,
          to,
          subject,
          body,
          attachments: stored,
          attachmentsOmitted: omitted.length > 0 ? omitted : undefined,
          inReplyTo,
          references,
          updatedAt: new Date().toISOString(),
        });
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [to, subject, body, attachments, draftId]);

  // Look up anyone we hold no key for. The result lands in the keyring, which
  // re-runs the memo below — so the "no key" state is what remains *after*
  // asking the directory, not before.
  const discoverRef = useRef(discoverRecipients);
  discoverRef.current = discoverRecipients;
  const addressKey = to.join(',');
  const plain = mode === 'plain';
  useEffect(() => {
    // Nothing about a recipient's keys can change what a plaintext send does, so
    // asking would be a keyserver query — one that tells a third party who is
    // about to be written to — placed entirely for nothing. Switching back to
    // encrypted re-runs this and looks them up then.
    if (plain) return;
    if (addressKey.length === 0) return;
    void discoverRef.current(addressKey.split(','));
  }, [addressKey, plain]);

  // Files too large to ride in the autosaved draft: held for this session only.
  // Read from the draft on resume (they are gone, and it says which), and from
  // the live list while composing (they are here, but will not survive leaving).
  const unsaved = useMemo(() => splitForStorage(attachments).omitted, [attachments]);
  const lost = existing?.attachmentsOmitted ?? [];

  /**
   * Address-book suggestions for what is being typed into the To field.
   *
   * Sourced from `contacts/contacts.ts`, so it offers everyone this device has
   * seen — not only the addresses that have a key. Suggesting only the latter
   * would quietly steer the user towards the contacts encryption already works
   * for, and away from the people the invite-and-hold path exists for.
   *
   * Anyone already on the message is dropped: they are on screen as a chip, and
   * picking them again does nothing.
   */
  const suggestions = useMemo(
    () => searchContacts(contacts, draft).filter((c) => !to.includes(c.email)),
    [contacts, draft, to],
  );

  const recipients = useMemo(() => resolveRecipients(to), [resolveRecipients, to]);
  const missing = recipients.filter((r) => r.status === 'missing');
  const changed = recipients.filter((r) => r.status === 'changed');
  const looking = discovering.length > 0;
  const gate = canSendEncrypted();

  // A missing key no longer blocks: the message is held and an invite goes out.
  // A *changed* key still does — waiting cannot resolve a possible substitution.
  //
  // None of that applies in plaintext mode, and deliberately so: this is the one
  // path that must not consult a recipient's key state, because a send that
  // *becomes* possible when a key is absent is the downgrade wearing a hat. The
  // only thing that can block it is having nobody to send to.
  const blocked = plain ? to.length === 0 : to.length === 0 || changed.length > 0 || looking || !gate.allowed;
  // Only a real problem is coloured like one. Waiting on a lookup, or on a
  // recipient who has yet to install anything, is not a warning — an
  // unencrypted message is, for as long as it is on screen.
  const alarming = plain || changed.length > 0 || !gate.allowed;

  /**
   * Change mode, asking before the one direction that costs the user something.
   *
   * The prompt is the "explicit, logged action" encryption.md requires, and it
   * happens here rather than at the send button on purpose: the point is that
   * the message is written *knowing* it is not private, not that a warning is
   * dismissed once it already exists.
   */
  const chooseMode = (next: SendMode) => {
    if (next === mode) return;
    if (next === 'encrypted') {
      setMode('encrypted');
      return;
    }
    confirmDialog(
      'Write this one unencrypted?',
      'It will leave as an ordinary email. Your provider, theirs, and anyone who ' +
        'handles it in between can read the subject and every word of it.\n\n' +
        'Your public key still goes with it, so they can answer you encrypted.',
      [
        { label: 'Keep it encrypted' },
        { label: 'Write unencrypted', tone: 'destructive', onPress: () => setMode('plain') },
      ],
    );
  };

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

  /**
   * Pick files and read them in.
   *
   * A refusal is shown and the rest of the selection still lands: picking four
   * files and losing all of them because one was too big would make the user
   * repeat the whole selection to find out which. Cancelling shows nothing —
   * it is not an error.
   */
  const attach = async () => {
    setAttaching(true);
    try {
      const picked = await pickFiles();
      // Accumulated locally rather than read back from state: each file is
      // checked against the total *including* the ones added a moment ago in
      // this same loop, and a re-render cannot land between the two.
      let next = attachments;
      let refusal: string | null = null;
      for (const file of picked) {
        const result = await readPickedFile(file, next);
        if ('refused' in result) {
          refusal = result.refused;
          continue;
        }
        next = addAttachment(next, result.attachment);
        setAttachments(next);
      }
      setError(refusal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  };

  const detach = (id: string) => setAttachments((prev) => removeAttachment(prev, id));

  /** How long the undo-send window lasts (ms). */
  const UNDO_DELAY_MS = 5_000;

  const send = async () => {
    setSending(true);
    setError(null);
    closingRef.current = true;
    try {
      // Recipient state decides whether there is an undo window at all. A
      // message that is *held* — no key yet, or a key that changed — never
      // reaches the wire on a timer, so delaying it would only misreport what
      // happened. Those go straight through sendEncrypted, which is the one
      // place rule 1 is enforced.
      const states = await discoverRecipients(to);
      const held = states.some((r) => r.status === 'missing' || r.status === 'changed');

      if (held) {
        const outcome = await sendEncrypted({
          id: draftId,
          to,
          subject: subject.trim() || '(no subject)',
          body,
          attachments,
          inReplyTo,
          references,
        });
        await deleteDraft(draftId);
        // A held message has *not* been sent, and the screen does not get to
        // close as if it had. It stays put and says what actually happened.
        if (outcome.status === 'queued') setQueued(outcome.pending);
        else navigation.goBack();
        return;
      }

      // Everyone has a key: schedule the send a few seconds out so the toast
      // has something to cancel. It still leaves through the same encrypted
      // path — the delay is the only difference.
      const sendAt = new Date(Date.now() + UNDO_DELAY_MS).toISOString();
      await scheduleSend({
        id: draftId,
        to,
        subject: subject.trim() || '(no subject)',
        body,
        attachments,
        inReplyTo,
        references,
        sendAt,
      });
      await deleteDraft(draftId);
      navigation.goBack();

      // Capture what we need for the undo closure — the screen is about to
      // unmount, so no setState is possible after this.
      const undoData = { id: draftId, to: [...to], subject, body, attachments, inReplyTo, references };
      showToast({
        message: 'Sending message…',
        actionLabel: 'Undo',
        durationMs: UNDO_DELAY_MS,
        onAction: () => {
          void (async () => {
            await cancelScheduled(undoData.id);
            await saveDraft({
              id: undoData.id,
              to: undoData.to,
              subject: undoData.subject,
              body: undoData.body,
              attachments: undoData.attachments,
              inReplyTo: undoData.inReplyTo,
              references: undoData.references,
              updatedAt: new Date().toISOString(),
            });
          })();
        },
      });
    } catch (e) {
      closingRef.current = false;
      setSending(false);
    }
  };

  /**
   * The unencrypted send. Reached only from the mode the user chose up front —
   * never from `send`, and never from a failure of it (rule 1).
   */
  const sendUnencrypted = async () => {
    setSending(true);
    setError(null);
    closingRef.current = true;
    try {
      await sendPlain({ to, subject: subject.trim() || '(no subject)', body, attachments, inReplyTo, references });
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
    setSending(true);
    setError(null);
    closingRef.current = true;
    try {
      await scheduleSend({
        id: draftId,
        to,
        subject: subject.trim() || '(no subject)',
        body,
        attachments,
        inReplyTo,
        references,
        sendAt: sendAt.toISOString(),
      });
      await deleteDraft(draftId);
      navigation.goBack();
    } catch (e) {
      closingRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={s.screen}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        // `flexGrow` so the message below can take whatever height the header
        // and the attachment row leave, rather than the screen ending in a
        // void with the body a 120px box at the top of it.
        contentContainerStyle={{ flexGrow: 1, padding: 16, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/*
          Above everything, because it decides what the rest of the screen means.
          Hidden once a message has been queued: that one is already encrypted
          and waiting, and offering to rewrite it in the clear at that point is
          the downgrade this control is arranged to avoid.
        */}
        {queued ? null : (
          <View style={s.modes}>
            <ModeTab
              active={!plain}
              icon="lock"
              label="Encrypted"
              onPress={() => chooseMode('encrypted')}
            />
            <ModeTab
              active={plain}
              icon="alert"
              label="Not encrypted"
              onPress={() => chooseMode('plain')}
              tone="warn"
            />
          </View>
        )}

        <Field
          label="To"
          focused={toFocus.focused}
          style={s.headField}
          tone={changed.length > 0 && !plain ? 'warn' : 'default'}
        >
          {recipients.length > 0 ? (
            <View style={s.chips}>
              {recipients.map((r) => (
                <RecipientChip
                  key={r.email}
                  state={r}
                  // No key badge in plaintext mode: it is not consulted, it does
                  // not change what happens, and showing it would invite reading
                  // "they have no key" as a reason to send in the clear.
                  showKeyState={!plain}
                  onRemove={() => setTo(to.filter((t) => t !== r.email))}
                />
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

        {/*
          The address book, offered as you type — and with each contact's trust
          state on the row, so it is known *before* the message is written
          rather than at the send button. Under the field rather than inside it:
          the field already grows with chips, and a list that pushed them around
          as it appeared would move the ✕ out from under a finger.

          The list itself shows in both modes — an address book is useful either
          way — but the trust badge is dropped in plaintext mode, exactly as the
          chips drop theirs: a key state that changes nothing about what happens
          must not be read as a reason to send in the clear.
        */}
        {suggestions.length > 0 ? (
          <View style={s.suggestions}>
            {suggestions.map((contact) => (
              <SuggestionRow
                key={contact.email}
                contact={contact}
                showKeyState={!plain}
                onPick={() => {
                  add([contact.email]);
                  setDraft('');
                  setError(null);
                }}
              />
            ))}
          </View>
        ) : null}

        {/* The placeholders describe what will actually happen to this text.
            Left unchanged they would promise privacy to a plaintext message. */}
        <Field label="Subject" focused={subjectFocus.focused} style={s.headField}>
          <Input
            onChangeText={setSubject}
            placeholder={plain ? 'Sent in the clear, like any email' : 'Encrypted inside the payload'}
            value={subject}
            {...subjectFocus.bind}
          />
        </Field>

        {/*
          No "Message" label. To and Subject need theirs — two single-line boxes
          are otherwise indistinguishable — but the body is the one field on the
          screen that cannot be mistaken for anything else, and its placeholder
          already says what will happen to the text. Dropping it gives the
          writing back a line and breaks the three-identical-slabs stack.

          It opens taller than the primitive's 120px floor so a short message
          does not sit in a box a third the size of the empty screen under it —
          but it still grows with its text and the page scrolls, rather than
          taking a fixed share and scrolling inside itself. A body that scrolls
          within a page that also scrolls puts the attachment row behind a
          nested gesture, which is how "Attach a file" ends up unreachable on a
          forwarded message.
        */}
        <Field focused={bodyFocus.focused} style={s.bodyField}>
          <Input
            big
            multiline
            onChangeText={setBody}
            placeholder={plain ? 'Anyone who handles this can read it.' : 'Only the recipients can read this.'}
            style={s.bodyInput}
            value={body}
            {...bodyFocus.bind}
          />
        </Field>

        {/* Takes up whatever the message does not, so the attachment row rests
            just above the send bar instead of floating in the middle of an
            empty screen. It collapses to nothing as the message grows. */}
        <View style={s.spacer} />

        <View style={s.attachments}>
          <View style={s.attachHead}>
            <Pressable
              accessibilityRole="button"
              disabled={attaching}
              onPress={() => void attach()}
              style={s.attachButton}
            >
              <Icon name="paperclip" size={14} color={color.inkDim} />
              <Text style={s.attachButtonText}>{attaching ? 'Reading file…' : 'Attach a file'}</Text>
            </Pressable>
            {attachments.length > 0 ? (
              <Text style={s.attachTotal}>{formatBytes(totalBytes(attachments))}</Text>
            ) : null}
          </View>

          {attachments.length > 0 ? (
            <View style={s.attachChips}>
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={() => detach(a.id)} />
              ))}
            </View>
          ) : null}

          {/* Said once, before a file is picked rather than after one is refused. */}
          <Text style={s.attachNote}>
            {plain
              ? `Attachments on an unencrypted message travel in the clear, filenames included. Up to ${formatBytes(MAX_ATTACHMENT_BYTES)} a message.`
              : `Files are sealed inside the message with the subject and body — even their names. Up to ${formatBytes(MAX_ATTACHMENT_BYTES)} a message.`}
          </Text>

          {/* Two different facts, and neither may be left unsaid: a file that
              will not survive leaving this screen, and one that already did
              not. Both name the file — "some attachments" would be useless. */}
          {lost.length > 0 ? (
            <Text style={[s.attachNote, s.attachWarn]}>
              {lost.join(', ')} {lost.length > 1 ? 'were' : 'was'} attached to this draft but too
              large to save with it. Attach {lost.length > 1 ? 'them' : 'it'} again before sending.
            </Text>
          ) : null}
          {unsaved.length > 0 ? (
            <Text style={[s.attachNote, s.attachWarn]}>
              {unsaved.join(', ')} {unsaved.length > 1 ? 'are' : 'is'} too large to keep in a saved
              draft. Send this message before leaving, or {unsaved.length > 1 ? 'they' : 'it'} will
              need attaching again.
            </Text>
          ) : null}
        </View>

        {error ? (
          <View style={s.errorRow}>
            <Icon name="alert" size={14} color={color.coral} />
            <Text style={s.error}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View
        style={[
          s.sendbar,
          alarming && s.sendbarWarn,
          s.sendbarInner,
          { paddingBottom: insets.bottom + 14 },
        ]}
      >
        <View style={s.status}>
          <Icon
            name={alarming ? 'alert' : queued || missing.length > 0 ? 'clock' : 'lock'}
            size={17}
            color={alarming ? color.coral : color.mint}
          />
          <Text style={[s.statusText, { color: alarming ? color.coral : color.mintInk }]}>{statusLine()}</Text>
        </View>

        {plain ? (
          <PrimaryButton
            busy={sending}
            disabled={blocked}
            icon="mail"
            onPress={() => void sendUnencrypted()}
            title={`Send unencrypted${to.length > 1 ? ` to ${to.length}` : ''}`}
          />
        ) : queued ? (
          <View style={s.fallbacks}>
            <SecondaryButton title="Done" icon="check" onPress={() => navigation.goBack()} />
            <SecondaryButton title="See queued messages" icon="clock" onPress={() => {
                  // A destination on the home screen, not a screen of its own.
                  setDestination('scheduled');
                  navigation.navigate('Home');
                }} />
          </View>
        ) : changed.length > 0 ? (
          <View style={s.fallbacks}>
            <SecondaryButton title="Check their key" icon="key" onPress={() => navigation.navigate('Keys')} />
            <SecondaryButton
              title={`Remove ${changed[0].email}`}
              onPress={() => setTo(to.filter((t) => t !== changed[0].email))}
            />
          </View>
        ) : (
          <>
            <PrimaryButton
              busy={sending}
              disabled={blocked}
              icon={missing.length > 0 ? 'clock' : 'send'}
              onPress={() => void send()}
              title={
                missing.length > 0
                  ? 'Encrypt and queue'
                  : `Send encrypted${to.length > 1 ? ` to ${to.length}` : ''}`
              }
            />
            {!blocked && missing.length === 0 ? (
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

        {/* The demo-crypto note describes what happens to an *encrypted* send.
            A plaintext one is not encoded-instead-of-encrypted; it is exactly
            what it says, in demo mode and live alike. */}
        {gate.reason && gate.allowed && !plain ? <Text style={s.gateNote}>{gate.reason}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );

  function statusLine(): string {
    // First, and with no reference to keys: in this mode there is nothing to
    // report about them, and the one fact worth stating is the one the rest of
    // the app exists to avoid.
    if (plain) {
      if (to.length === 0) return 'Add a recipient. This message will not be encrypted.';
      return (
        'Not encrypted. Your provider, theirs, and anyone who handles it in between can read the ' +
        'subject and the body. Your public key goes with it, so they can answer you encrypted.'
      );
    }
    if (queued) {
      return `Encrypted and queued for ${queued.join(', ')}. They have been invited; it sends itself the moment they have a key.`;
    }
    if (to.length === 0) return 'Add a recipient. CryptMail encrypts every message it sends.';
    if (looking) return `Looking up keys for ${discovering.join(', ')}…`;
    if (changed.length > 0) {
      return `${changed[0].email}'s key changed since you last saw it. Verify it before sending.`;
    }
    if (missing.length > 0) {
      // "We could not ask" is not "they have no key". Saying the second when the
      // first is true tells the user this person does not use encryption on the
      // strength of a failed request — and the message waits on a key that may
      // have been published all along.
      const stranded = missing.filter((r) => undiscoverable.includes(r.email));
      if (stranded.length > 0) {
        const names = stranded.map((r) => r.email).join(', ');
        return `Couldn't get a usable key for ${names} from ${directoryName}. CryptMail keeps trying, and will hold this message — encrypted, undelivered — rather than send it in the clear.`;
      }
      const names = missing.map((r) => r.email).join(', ');
      return `No key published for ${names} yet. CryptMail will invite them and hold this message — encrypted, undelivered — until there is a key to send it to.`;
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

/** One half of the encrypted / not-encrypted choice at the top of the screen. */
function ModeTab({
  active,
  icon,
  label,
  onPress,
  tone,
}: {
  active: boolean;
  icon: 'lock' | 'alert';
  label: string;
  onPress: () => void;
  tone?: 'warn';
}) {
  const tint = active ? (tone === 'warn' ? color.coral : color.ground) : color.inkDim;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        s.mode,
        active && (tone === 'warn' ? s.modeActiveWarn : s.modeActive),
        pressed && !active && { backgroundColor: color.rowPress },
      ]}
    >
      <Icon name={icon} size={14} color={tint} />
      <Text style={[s.modeText, { color: tint }, active && s.modeTextActive]}>{label}</Text>
    </Pressable>
  );
}

/**
 * One autocomplete suggestion: who they are, and how far they are trusted.
 *
 * `onPressIn`, not `onPress`. Picking a suggestion blurs the To field, and the
 * blur handler commits and clears the draft — which empties this list and
 * unmounts the row before a press could land on it. `onPressIn` fires first, so
 * the tap is never lost.
 */
function SuggestionRow({
  contact,
  showKeyState,
  onPick,
}: {
  contact: Contact;
  /** False in plaintext mode, where a contact's key changes nothing. */
  showKeyState: boolean;
  onPick: () => void;
}) {
  const name = displayName(contact.email, contact.name);
  const badge = SUGGESTION_BADGE[contact.trust];

  return (
    <Pressable
      accessibilityLabel={showKeyState ? `${name}, ${contact.email}, ${badge.label}` : `${name}, ${contact.email}`}
      accessibilityRole="button"
      onPressIn={onPick}
      style={({ pressed }) => [s.suggestion, pressed && { backgroundColor: color.rowPress }]}
    >
      <Avatar seed={contact.email} label={initials(name)} size={28} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={s.suggestionName}>
          {name}
        </Text>
        <Text numberOfLines={1} style={s.suggestionEmail}>
          {contact.email}
        </Text>
      </View>
      {showKeyState ? (
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      ) : null}
    </Pressable>
  );
}

/**
 * The trust wording, shortened for a row this narrow.
 *
 * "no key yet" rather than "will be invited": this is a statement about the
 * contact, and only a message actually being sent turns it into an invite —
 * which is what the chip says once they are on the message.
 */
const SUGGESTION_BADGE: Record<
  Contact['trust'],
  { tone: 'enc' | 'warn' | 'plain'; icon?: 'lock' | 'alert' | 'clock'; label: string }
> = {
  verified: { tone: 'enc', icon: 'lock', label: 'verified' },
  seen: { tone: 'enc', icon: 'lock', label: 'key found' },
  changed: { tone: 'warn', icon: 'alert', label: 'key changed' },
  none: { tone: 'plain', icon: 'clock', label: 'no key yet' },
};

function RecipientChip({
  state,
  showKeyState,
  onRemove,
}: {
  state: RecipientState;
  /** False in plaintext mode, where a recipient's key changes nothing. */
  showKeyState: boolean;
  onRemove: () => void;
}) {
  const badge =
    state.status === 'verified'
      ? { tone: 'enc' as const, icon: 'lock' as const, label: 'verified' }
      : state.status === 'ok'
        ? { tone: 'enc' as const, icon: 'lock' as const, label: 'key found' }
        : state.status === 'changed'
          ? { tone: 'warn' as const, icon: 'alert' as const, label: 'key changed' }
          : { tone: 'plain' as const, icon: 'clock' as const, label: 'will be invited' };

  const warn = showKeyState && state.status === 'changed';

  return (
    <View style={[s.chip, warn && s.chipWarn]}>
      <Text style={s.chipText}>{state.email}</Text>
      {showKeyState ? (
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      ) : null}
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

  modes: { flexDirection: 'row', gap: 7, marginBottom: 14 },
  mode: {
    alignItems: 'center',
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  modeActive: { backgroundColor: color.ink, borderColor: color.ink },
  // Not the brass fill: the unencrypted mode is the one state on this screen
  // that should never look like the app's primary, endorsed action.
  modeActiveWarn: { backgroundColor: color.coralBg, borderColor: color.coralLine },
  modeText: { fontFamily: font.sansSemibold, fontSize: 12.5 },
  modeTextActive: { fontFamily: font.sansBold },

  suggestions: {
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginBottom: 14,
    marginTop: -6,
    overflow: 'hidden',
  },
  suggestion: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: 11, paddingVertical: 8 },
  suggestionName: { color: color.ink, fontFamily: font.sansSemibold, fontSize: 13.5 },
  suggestionEmail: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11 },

  // The two single-line fields, kept lighter than the body they sit above.
  headField: { marginBottom: 8, paddingVertical: 9 },
  bodyField: { marginBottom: 14 },
  bodyInput: { minHeight: 200 },
  spacer: { flexGrow: 1 },

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

  attachments: { gap: 10, marginTop: 4, marginBottom: 14 },
  attachHead: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  attachButton: {
    alignItems: 'center',
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachButtonText: { color: color.ink, fontFamily: font.sansSemibold, fontSize: 13 },
  attachTotal: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11.5 },
  attachChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  attachNote: { color: color.inkFaint, fontFamily: font.sans, fontSize: 12, lineHeight: 17 },
  attachWarn: { color: color.coral },

  errorRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 4 },
  error: { color: color.coral, flex: 1, fontFamily: font.sans, fontSize: 13 },

  sendbar: {
    backgroundColor: color.surface,
    borderTopColor: color.line,
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
