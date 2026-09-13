/**
 * Settings → Mail → Canned replies.
 *
 * The saved snippets Compose offers from its overflow: make one, edit one,
 * delete one. Inserting happens in Compose, where the message is; this screen
 * is only the set.
 *
 * Kept on this device and shared by every mailbox — see
 * `store/cannedRepliesStore.ts` for why it is not per account, when the
 * signature is.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { back, RootStackParamList } from '../navigation';
import {
  CannedReply,
  cannedReplyLabel,
  MAX_CANNED_BODY_LENGTH,
  MAX_CANNED_TITLE_LENGTH,
} from '../store/cannedRepliesStore';
import { color, space, type } from '../theme';
import { useCannedReplies } from '../ui/cannedReplies';
import { confirmDialog } from '../ui/dialog';
import {
  EmptyState,
  Field,
  Group,
  GroupHeading,
  IconButton,
  Input,
  PrimaryButton,
  SecondaryButton,
  SettingsRow,
  Sheet,
  useFocus,
} from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'CannedReplies'>;

/** What the editor sheet holds; `id` is absent for a reply not saved yet. */
type Editing = { id?: string; title: string; body: string };

export function CannedRepliesScreen({ navigation }: Props) {
  const { replies, saveReply, deleteReply } = useCannedReplies();
  const insets = useSafeAreaInsets();
  const titleFocus = useFocus();
  const bodyFocus = useFocus();

  const [editing, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const open = (reply?: CannedReply) => {
    setEditing(reply ? { id: reply.id, title: reply.title, body: reply.body } : { title: '', body: '' });
    setProblem(null);
  };

  const save = async () => {
    if (!editing) return;
    try {
      await saveReply({
        id: editing.id ?? `canned-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: editing.title,
        body: editing.body,
        updatedAt: new Date().toISOString(),
      });
      setEditing(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (id: string, label: string) =>
    confirmDialog(`Delete “${label}”?`, 'Messages you already wrote with it are not changed.', [
      { label: 'Cancel' },
      { label: 'Delete', tone: 'destructive', onPress: () => void deleteReply(id) },
    ]);

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Canned replies</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.lede}>
          Text you write often, ready to drop into a message from Compose’s options. Kept on this device for every
          mailbox. Once inserted it is part of the message, and encrypted with it.
        </Text>

        <View style={s.add}>
          <SecondaryButton title="New canned reply" icon="plus" onPress={() => open()} />
        </View>

        {replies.length === 0 ? (
          <EmptyState icon="reply" title="No canned replies yet" hint="Save a reply you send again and again." />
        ) : (
          <>
            <GroupHeading>Your replies</GroupHeading>
            <Group>
              {replies.map((reply) => (
                <SettingsRow
                  key={reply.id}
                  icon="reply"
                  label={cannedReplyLabel(reply)}
                  value={reply.title.trim() ? reply.body.trim().split('\n')[0] : undefined}
                  onPress={() => open(reply)}
                />
              ))}
            </Group>
          </>
        )}
      </ScrollView>

      <Sheet
        bottomInset={insets.bottom}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit canned reply' : 'New canned reply'}
        visible={editing !== null}
      >
        {editing ? (
          <View style={s.sheetBody}>
            <Field focused={titleFocus.focused} label="NAME">
              <Input
                {...titleFocus.bind}
                maxLength={MAX_CANNED_TITLE_LENGTH}
                onChangeText={(title) => setEditing({ ...editing, title })}
                placeholder="Optional — shown in the picker"
                returnKeyType="next"
                value={editing.title}
              />
            </Field>
            <Field focused={bodyFocus.focused} label="TEXT" tone={problem ? 'warn' : 'default'}>
              <Input
                {...bodyFocus.bind}
                maxLength={MAX_CANNED_BODY_LENGTH}
                multiline
                onChangeText={(body) => {
                  setEditing({ ...editing, body });
                  setProblem(null);
                }}
                placeholder="What gets inserted"
                style={s.bodyInput}
                value={editing.body}
              />
            </Field>
            {problem ? <Text style={s.problem}>{problem}</Text> : null}
            <PrimaryButton title="Save" onPress={() => void save()} />
            {editing.id ? (
              // The sheet closes before the dialog opens: two stacked modals can
              // strand one on iOS (see LabelsScreen).
              <SecondaryButton
                title="Delete canned reply"
                icon="trash"
                tone="danger"
                onPress={() => {
                  const id = editing.id!;
                  setEditing(null);
                  remove(id, cannedReplyLabel(editing));
                }}
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  topbar: {
    alignItems: 'center',
    backgroundColor: color.surface,
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.md,
    paddingHorizontal: space.md,
  },
  title: { ...type.display, color: color.ink },
  lede: { ...type.small, color: color.inkDim, paddingBottom: space.sm, paddingHorizontal: space.lg },
  add: { alignItems: 'flex-start', paddingHorizontal: space.lg, paddingBottom: space.sm },
  problem: { ...type.small, color: color.coralInk },
  sheetBody: { gap: space.md, paddingHorizontal: space.lg },
  bodyInput: { maxHeight: 220, minHeight: 110, textAlignVertical: 'top' },
});
