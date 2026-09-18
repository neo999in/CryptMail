/**
 * Settings → Mail → Labels.
 *
 * The active mailbox's local labels: make one, rename one, delete one. Putting
 * a label on mail happens where the mail is — the reader's overflow, or the
 * inbox's multi-select bar — and narrowing the list to one is the bar's Filter
 * sheet. This screen is only the set itself.
 *
 * It says, once and plainly, that labels stay on this device. That is a real
 * difference from every other mail app the reader has used, and finding it out
 * by opening Gmail on the web and seeing none of them would read as data loss.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Label, labelCounts, listLabels } from '../labels/labels';
import { back, RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { accountLabel } from '../store/accountScope';
import { color, space, type } from '../theme';
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
import { userMessage } from '../lib/errors';

type Props = NativeStackScreenProps<RootStackParamList, 'Labels'>;

export function LabelsScreen({ navigation }: Props) {
  const { labels, accounts, activeAccount, createLabel, renameLabel, deleteLabel } = useApp();
  const insets = useSafeAreaInsets();
  const list = useMemo(() => listLabels(labels), [labels]);
  const counts = useMemo(() => labelCounts(labels), [labels]);
  const activeRef = accounts.find((a) => a.id === activeAccount);

  const newFocus = useFocus();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const [editing, setEditing] = useState<Label | null>(null);
  const [rename, setRename] = useState('');
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const renameFocus = useFocus();

  const add = async () => {
    try {
      await createLabel(draft);
      setDraft('');
      setProblem(null);
    } catch (e) {
      setProblem(userMessage(e));
    }
  };

  const openEditor = (label: Label) => {
    setEditing(label);
    setRename(label.name);
    setRenameProblem(null);
  };

  const saveRename = async () => {
    if (!editing) return;
    try {
      await renameLabel(editing.id, rename);
      setEditing(null);
    } catch (e) {
      setRenameProblem(userMessage(e));
    }
  };

  const remove = (label: Label) => {
    const n = counts[label.id] ?? 0;
    confirmDialog(
      `Delete “${label.name}”?`,
      `${n === 0 ? 'No messages carry it.' : `It comes off ${n === 1 ? 'the 1 message' : `all ${n} messages`} that carry it.`} The mail itself is not touched, and any rule that filed under it keeps its other actions.`,
      [
        { label: 'Cancel' },
        {
          label: 'Delete',
          tone: 'destructive',
          onPress: () => void deleteLabel(label.id),
        },
      ],
    );
  };

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Labels</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.lede}>
          Labels are kept on this device{activeRef ? ` for ${accountLabel(activeRef)}` : ''}. Your mail provider never
          sees their names or which messages carry them — so they do not appear in other mail apps.
        </Text>

        <GroupHeading>New label</GroupHeading>
        <View style={s.create}>
          <Field focused={newFocus.focused} tone={problem ? 'warn' : 'default'} style={s.field}>
            <Input
              {...newFocus.bind}
              accessibilityLabel="New label name"
              maxLength={40}
              onChangeText={(text) => {
                setDraft(text);
                setProblem(null);
              }}
              onSubmitEditing={() => void add()}
              placeholder="Name"
              returnKeyType="done"
              value={draft}
            />
          </Field>
          <SecondaryButton title="Add" icon="plus" onPress={() => void add()} />
        </View>
        {problem ? <Text style={s.problem}>{problem}</Text> : null}

        {list.length === 0 ? (
          <EmptyState
            icon="file"
            title="No labels yet"
            hint="Make one here, or from a message’s More menu. Long-press mail in the inbox to label several at once."
          />
        ) : (
          <>
            <GroupHeading>Your labels</GroupHeading>
            <Group>
              {list.map((label) => {
                const n = counts[label.id] ?? 0;
                return (
                  <SettingsRow
                    key={label.id}
                    icon="file"
                    label={label.name}
                    value={n === 0 ? 'No messages' : `${n} ${n === 1 ? 'message' : 'messages'}`}
                    onPress={() => openEditor(label)}
                  />
                );
              })}
            </Group>
          </>
        )}
      </ScrollView>

      <Sheet bottomInset={insets.bottom} onClose={() => setEditing(null)} title="Edit label" visible={editing !== null}>
        <View style={s.sheetBody}>
          <Field focused={renameFocus.focused} tone={renameProblem ? 'warn' : 'default'}>
            <Input
              {...renameFocus.bind}
              accessibilityLabel="Label name"
              maxLength={40}
              onChangeText={(text) => {
                setRename(text);
                setRenameProblem(null);
              }}
              onSubmitEditing={() => void saveRename()}
              returnKeyType="done"
              value={rename}
            />
          </Field>
          {renameProblem ? <Text style={[s.problem, { paddingHorizontal: 0 }]}>{renameProblem}</Text> : null}
          <PrimaryButton title="Save" onPress={() => void saveRename()} />
          {editing ? (
            // The sheet closes before the dialog opens: two modals stacked is
            // a known way to strand one on iOS.
            <SecondaryButton
              title="Delete label"
              icon="trash"
              tone="danger"
              onPress={() => {
                setEditing(null);
                remove(editing);
              }}
            />
          ) : null}
        </View>
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
  create: { alignItems: 'center', flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  field: { flex: 1 },
  problem: { ...type.small, color: color.coralInk, paddingHorizontal: space.lg, paddingTop: space.sm },
  sheetBody: { gap: space.md, paddingHorizontal: space.lg },
});
