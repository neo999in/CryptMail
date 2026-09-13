/**
 * Settings → Mail → Rules.
 *
 * The active mailbox's filters & rules, in the order they run, each with a
 * switch. A rule is edited on its own screen (`RuleEditScreen`); this one lists
 * them, turns them on and off, and starts a new one.
 *
 * The lede carries the one thing about these rules that is unlike a provider's
 * filters and that a reader would otherwise discover as "my rule is broken":
 * a rule reads an encrypted message's subject and body only after that message
 * has been opened on this device.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { back, RootStackParamList } from '../navigation';
import { describeActions, describeConditions, Rule } from '../rules/rules';
import { useApp } from '../state/AppState';
import { accountLabel } from '../store/accountScope';
import { color, space, type } from '../theme';
import { useToast } from '../ui/ToastContext';
import { EmptyState, Group, GroupHeading, IconButton, SettingsRow, Toggle } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Rules'>;

export function RulesScreen({ navigation }: Props) {
  const { rules, labels, accounts, activeAccount, saveRule } = useApp();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const activeRef = accounts.find((a) => a.id === activeAccount);
  const labelName = (id: string) => labels.labels[id]?.name;

  const setEnabled = (rule: Rule, enabled: boolean) =>
    void saveRule({ ...rule, enabled }).catch((e: unknown) =>
      // Only a rule that could never have been saved fails here, but the switch
      // must not pretend it moved.
      showToast({ message: e instanceof Error ? e.message : String(e), icon: 'alert', durationMs: 5000 }),
    );

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Rules</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.lede}>
          Rules run on this device{activeRef ? ` for ${accountLabel(activeRef)}` : ''}, over mail as it reaches your
          inbox — each rule acts on a message once. Your provider cannot filter encrypted mail, so a rule reads an
          encrypted message’s subject and body only after you have opened it here. The sender always counts.
        </Text>

        <Group>
          <SettingsRow icon="plus" label="New rule" onPress={() => navigation.navigate('RuleEdit', {})} />
        </Group>

        {rules.rules.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No rules yet"
            hint="Make one here, or open a message and choose “Create rule from this message” in its More menu."
          />
        ) : (
          <>
            <GroupHeading>Your rules</GroupHeading>
            <Group>
              {rules.rules.map((rule) => (
                <SettingsRow
                  key={rule.id}
                  icon="settings"
                  label={rule.name || describeConditions(rule.conditions)}
                  value={`${describeConditions(rule.conditions)} → ${describeActions(rule.actions, labelName)}`}
                  onPress={() => navigation.navigate('RuleEdit', { id: rule.id })}
                  tint={rule.enabled ? undefined : color.inkFaint}
                  trailing={
                    <Toggle
                      label={`${rule.name || 'Rule'} ${rule.enabled ? 'on' : 'off'}`}
                      on={rule.enabled}
                      onChange={(next) => setEnabled(rule, next)}
                    />
                  }
                />
              ))}
            </Group>
          </>
        )}
      </ScrollView>
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
  lede: { ...type.small, color: color.inkDim, paddingBottom: space.md, paddingHorizontal: space.lg },
});
