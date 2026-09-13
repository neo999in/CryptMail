/**
 * One rule — new, existing, or started from a message.
 *
 * Conditions on top ("when all of these are true"), actions under them ("do
 * this"), and Save. Everything a rule can hold is on one screen, because a rule
 * is short and reading it top to bottom is how a person checks it says what
 * they meant.
 *
 * Opened from a message, it arrives with that message's sender filled in, and
 * offers its subject as a one-tap extra condition rather than adding it: sender
 * *and* this exact subject matches one message, which is not a rule. The
 * subject is only offered at all when this device could read it — an unopened
 * encrypted message has none to offer (`rules/draftRuleFrom`).
 *
 * Saving validates through the same `ruleProblem` the state layer enforces, and
 * shows its sentence; a rule that would match everything cannot be saved from
 * here or anywhere else.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listLabels } from '../labels/labels';
import { back, RootStackParamList } from '../navigation';
import { NO_ACTIONS, RULE_FIELDS, RuleActions, RuleCondition, RuleField, ruleProblem } from '../rules/rules';
import { useApp } from '../state/AppState';
import { color, space, type } from '../theme';
import { confirmDialog } from '../ui/dialog';
import { Icon } from '../ui/Icon';
import { useAccent } from '../ui/appearance';
import {
  Field,
  Group,
  GroupHeading,
  IconButton,
  Input,
  PressableRow,
  PrimaryButton,
  SecondaryButton,
  Segmented,
  SettingsRow,
  Sheet,
  Toggle,
} from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'RuleEdit'>;

export function RuleEditScreen({ navigation, route }: Props) {
  const { rules, labels, saveRule, deleteRule } = useApp();
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const { id, from, subject } = route.params ?? {};
  const existing = id ? rules.rules.find((r) => r.id === id) : undefined;

  const [name, setName] = useState(existing?.name ?? (from ? `From ${from}` : ''));
  const [conditions, setConditions] = useState<RuleCondition[]>(
    existing?.conditions ?? [{ field: 'from', contains: from ?? '' }],
  );
  const [actions, setActions] = useState<RuleActions>(existing?.actions ?? NO_ACTIONS);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickingLabel, setPickingLabel] = useState(false);

  const labelList = useMemo(() => listLabels(labels), [labels]);
  const labelName = actions.labelId ? labels.labels[actions.labelId]?.name : undefined;
  const subjectOffered =
    !!subject && !conditions.some((c) => c.field === 'subject' && c.contains.trim() === subject.trim());

  const edit = (index: number, change: Partial<RuleCondition>) => {
    setProblem(null);
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...change } : c)));
  };

  const setAction = (change: Partial<RuleActions>) => {
    setProblem(null);
    setActions((prev) => ({ ...prev, ...change }));
  };

  const save = async () => {
    const draft = { id: existing?.id, name, enabled, conditions, actions };
    const why = ruleProblem(draft);
    if (why) {
      setProblem(why);
      return;
    }
    setSaving(true);
    try {
      await saveRule(draft);
      back(navigation);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!existing) return;
    confirmDialog(
      'Delete this rule?',
      'Mail it already acted on stays as it is — nothing is un-starred or moved back.',
      [
        { label: 'Cancel' },
        {
          label: 'Delete',
          tone: 'destructive',
          onPress: () => {
            void deleteRule(existing.id);
            back(navigation);
          },
        },
      ],
    );
  };

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>{existing ? 'Edit rule' : 'New rule'}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={s.block}>
          <Field label="NAME">
            <Input accessibilityLabel="Rule name" onChangeText={setName} placeholder="Optional" value={name} />
          </Field>
        </View>

        <GroupHeading>When all of these are true</GroupHeading>
        {conditions.map((condition, index) => (
          <View key={index} style={s.condition}>
            <View style={s.conditionHead}>
              {/* `stretch`: equal thirds. The thumb is drawn at the first tab's
                  width and scaled to each tab, so tabs of different widths
                  squash its rounded ends — the same fix Contacts' filter uses. */}
              <Segmented
                compact
                stretch
                style={s.fieldPicker}
                options={RULE_FIELDS}
                value={condition.field}
                onChange={(field: RuleField) => edit(index, { field })}
              />
              {conditions.length > 1 ? (
                <IconButton
                  icon="close"
                  label="Remove this condition"
                  onPress={() => setConditions((prev) => prev.filter((_, i) => i !== index))}
                />
              ) : null}
            </View>
            <Field>
              <Input
                accessibilityLabel={`${RULE_FIELDS.find((f) => f.key === condition.field)?.label} contains`}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(contains) => edit(index, { contains })}
                placeholder={
                  condition.field === 'from'
                    ? 'Name or address contains…'
                    : condition.field === 'content'
                      ? 'Subject or body contains…'
                      : 'Subject contains…'
                }
                value={condition.contains}
              />
            </Field>
          </View>
        ))}
        <View style={s.buttons}>
          <SecondaryButton
            title="Add condition"
            icon="plus"
            onPress={() => setConditions((prev) => [...prev, { field: 'subject', contains: '' }])}
          />
          {subjectOffered ? (
            <SecondaryButton
              title="Also match this subject"
              icon="plus"
              onPress={() => setConditions((prev) => [...prev, { field: 'subject', contains: subject ?? '' }])}
            />
          ) : null}
        </View>

        <GroupHeading>Do this</GroupHeading>
        <Group>
          <SettingsRow
            icon="star"
            label="Star it"
            onPress={() => setAction({ star: !actions.star })}
            trailing={<Toggle label="Star it" on={actions.star} onChange={(star) => setAction({ star })} />}
          />
          <SettingsRow
            icon="mail"
            label="Mark it read"
            onPress={() => setAction({ markRead: !actions.markRead })}
            trailing={
              <Toggle label="Mark it read" on={actions.markRead} onChange={(markRead) => setAction({ markRead })} />
            }
          />
          <SettingsRow
            icon="archive"
            label="Archive it"
            value="Skips the inbox. Nothing is deleted."
            onPress={() => setAction({ archive: !actions.archive })}
            trailing={
              <Toggle label="Archive it" on={actions.archive} onChange={(archive) => setAction({ archive })} />
            }
          />
          <SettingsRow
            icon="file"
            label="Label it"
            value={labelName ?? 'No label'}
            onPress={() => setPickingLabel(true)}
          />
        </Group>

        <Group style={s.separate}>
          <SettingsRow
            icon="check"
            label="Rule is on"
            onPress={() => setEnabled(!enabled)}
            trailing={<Toggle label="Rule is on" on={enabled} onChange={setEnabled} />}
          />
        </Group>

        <View style={[s.block, s.footer]}>
          {problem ? <Text style={s.problem}>{problem}</Text> : null}
          <PrimaryButton title="Save rule" onPress={() => void save()} busy={saving} />
          {existing ? <SecondaryButton title="Delete rule" icon="trash" tone="danger" onPress={remove} /> : null}
        </View>
      </ScrollView>

      <Sheet bottomInset={insets.bottom} onClose={() => setPickingLabel(false)} title="Label it" visible={pickingLabel}>
        <ScrollView style={s.labelScroll}>
          {[{ id: null as string | null, name: 'No label' }, ...labelList].map((label) => {
            const on = actions.labelId === label.id;
            return (
              <PressableRow
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                key={label.id ?? 'none'}
                onPress={() => {
                  setAction({ labelId: label.id });
                  setPickingLabel(false);
                }}
                style={s.labelRow}
              >
                <Text numberOfLines={1} style={s.labelText}>
                  {label.name}
                </Text>
                {on ? <Icon name="check" size={19} color={accent} strokeWidth={2.4} /> : null}
              </PressableRow>
            );
          })}
        </ScrollView>
        {labelList.length === 0 ? (
          <Text style={s.hint}>No labels yet. Make them in Settings → Mail → Labels, or from a message.</Text>
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
  block: { gap: space.md, paddingBottom: space.md, paddingHorizontal: space.lg },
  // Two cards and a button, each with air between them — the Group supplies no
  // outer margin of its own, so consecutive ones otherwise touch.
  separate: { marginTop: space.lg },
  footer: { paddingTop: space.lg },
  condition: { gap: space.sm, paddingBottom: space.md, paddingHorizontal: space.lg },
  conditionHead: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  fieldPicker: { flex: 1 },
  buttons: { alignItems: 'flex-start', gap: space.sm, paddingBottom: space.md, paddingHorizontal: space.lg },
  problem: { ...type.small, color: color.coralInk },
  labelScroll: { maxHeight: 360 },
  labelRow: { alignItems: 'center', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13 },
  labelText: { ...type.settingsRow, color: color.ink, flex: 1 },
  hint: { ...type.small, color: color.inkFaint, paddingHorizontal: space.lg, paddingTop: space.sm },
});
