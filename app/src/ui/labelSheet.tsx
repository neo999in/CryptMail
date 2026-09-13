/**
 * The label picker — one sheet for one message, a conversation, or a selection.
 *
 * Each label shows how it sits across what was picked: a check when every
 * message carries it, a dash when some do, nothing when none do. A tap on a
 * label that is not yet on everything puts it on everything; a tap on one that
 * is takes it off. That is the rule every mail client's bulk labeller settles
 * on, because "some" has to resolve one way and adding is the safer guess.
 *
 * Changes apply as they are tapped — there is no Save. Labels are local
 * (`labels/labels.ts`), instant and reversible by the same tap, so a confirm
 * step would only be a second tap to do the same thing.
 *
 * A new label can be made from here, and is put on the selection at once:
 * wanting a label that does not exist yet is almost always wanting it *for
 * this mail*.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { labelCoverage, listLabels } from '../labels/labels';
import { useApp } from '../state/AppState';
import { color, space, type } from '../theme';
import { Icon } from './Icon';
import { useAccent } from './appearance';
import { Field, Input, PressableRow, SecondaryButton, Sheet, useFocus } from './primitives';

export function LabelSheet({
  visible,
  messageIds,
  onClose,
}: {
  visible: boolean;
  /** Every message the labels go on — a conversation or a selection is all of its messages. */
  messageIds: string[];
  onClose: () => void;
}) {
  const { labels, createLabel, setLabels } = useApp();
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const focus = useFocus();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const list = useMemo(() => listLabels(labels), [labels]);

  const close = () => {
    setName('');
    setProblem(null);
    onClose();
  };

  const toggle = (labelId: string) => {
    const coverage = labelCoverage(labels, messageIds, labelId);
    void setLabels(messageIds, coverage === 'all' ? { remove: [labelId] } : { add: [labelId] });
  };

  const add = async () => {
    try {
      const label = await createLabel(name);
      await setLabels(messageIds, { add: [label.id] });
      setName('');
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet bottomInset={insets.bottom} onClose={close} title="Labels" visible={visible}>
      <Text style={s.note}>
        Labels stay on this device. Your mail provider never sees them, or which messages carry them.
      </Text>
      <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
        {list.length === 0 ? <Text style={s.empty}>No labels yet. Make the first one below.</Text> : null}
        {list.map((label) => {
          const coverage = labelCoverage(labels, messageIds, label.id);
          return (
            <PressableRow
              accessibilityRole="checkbox"
              accessibilityState={{ checked: coverage === 'all' ? true : coverage === 'some' ? 'mixed' : false }}
              accessibilityLabel={coverage === 'some' ? `${label.name}, on some of these` : label.name}
              key={label.id}
              onPress={() => toggle(label.id)}
              style={s.row}
            >
              <Icon name="file" size={18} color={coverage === 'none' ? color.inkDim : accent} />
              <Text numberOfLines={1} style={s.label}>
                {label.name}
              </Text>
              {coverage === 'all' ? (
                <Icon name="check" size={19} color={accent} strokeWidth={2.4} />
              ) : coverage === 'some' ? (
                <View style={[s.dash, { backgroundColor: accent }]} />
              ) : null}
            </PressableRow>
          );
        })}
      </ScrollView>

      <View style={s.create}>
        <Field focused={focus.focused} tone={problem ? 'warn' : 'default'} style={s.field}>
          <Input
            {...focus.bind}
            accessibilityLabel="New label name"
            maxLength={40}
            onChangeText={(text) => {
              setName(text);
              setProblem(null);
            }}
            onSubmitEditing={() => void add()}
            placeholder="New label"
            returnKeyType="done"
            value={name}
          />
        </Field>
        <SecondaryButton title="Add" icon="plus" onPress={() => void add()} />
      </View>
      {problem ? <Text style={s.problem}>{problem}</Text> : null}
    </Sheet>
  );
}

const s = StyleSheet.create({
  note: { ...type.small, color: color.inkFaint, paddingBottom: space.sm, paddingHorizontal: space.lg },
  list: { maxHeight: 320 },
  empty: { ...type.small, color: color.inkDim, paddingHorizontal: space.lg, paddingVertical: space.md },
  row: { alignItems: 'center', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13 },
  label: { ...type.settingsRow, color: color.ink, flex: 1 },
  dash: { borderRadius: 1, height: 2.5, width: 14 },
  create: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  field: { flex: 1 },
  problem: { ...type.small, color: color.coralInk, paddingHorizontal: space.lg, paddingTop: space.sm },
});
