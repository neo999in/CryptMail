import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CODE_LENGTH, normaliseRecoveryCode, typedRecoveryCode } from '../core/recoveryCode';
import { color, font, radius, space, type } from '../theme';
import { Icon } from './Icon';
import { Field, Input, Label, useFocus } from './primitives';

/**
 * A recovery code laid out for copying onto paper: eight groups, four to a row,
 * each numbered.
 *
 * The numbers are the point. Unnumbered, two rows of four read just as well
 * down the columns as across the rows — the columns are further apart than the
 * rows, so the eye pairs each group with the one beneath it. Someone copied a
 * code that way, typed it back in that order, and was told it was wrong, with
 * every character correct. Numbering makes the order part of what is copied.
 */
export function RecoveryCodeGrid({ code, label = 'Recovery code' }: { code: string; label?: string }) {
  const groups = code.split('-');
  return (
    <View style={s.box} accessibilityLabel={`${label}: ${groups.join(', ')}`}>
      <View style={s.grid}>
        {groups.map((group, i) => (
          <View key={`${group}-${i}`} style={s.cell}>
            <Text style={s.index}>{i + 1}</Text>
            <Text style={s.group} selectable>
              {group}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * The one way a recovery code is typed in — setup's check, setup's restore and
 * the recovery screen's restore all use it, so they group, count and complain
 * identically.
 *
 * The count is shown from the first character rather than an error after the
 * fact: "24 of 32" says how far along you are, where "a recovery code is 32
 * characters" only says you are wrong.
 */
export function RecoveryCodeField({
  value,
  onChange,
  label = 'Recovery code',
  autoFocus,
}: {
  value: string;
  onChange: (code: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const focus = useFocus();
  const typed = normaliseRecoveryCode(value).length;
  const complete = typed === CODE_LENGTH;

  return (
    <View>
      <Label>{label}</Label>
      <Field focused={focus.focused} style={s.field}>
        <Input
          accessibilityLabel={label}
          accessibilityHint="Eight groups of four. Dashes are added for you."
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect={false}
          autoFocus={autoFocus}
          importantForAutofill="no"
          // Multiline so a whole code is visible — 39 characters of mono is
          // wider than a phone, and a single line scrolls its start out of
          // sight. Enter still submits; `typedRecoveryCode` drops line breaks.
          multiline
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
          onChangeText={(text) => onChange(typedRecoveryCode(text))}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          style={s.input}
          value={twoLines(value)}
          {...focus.bind}
        />
      </Field>
      <View style={s.status} accessibilityLiveRegion="polite">
        {complete ? <Icon name="check" size={13} color={color.inkDim} /> : null}
        <Text style={s.statusText}>
          {complete ? 'All 32 characters' : typed === 0 ? 'Dashes are added as you type' : `${typed} of ${CODE_LENGTH} characters`}
        </Text>
      </View>
    </View>
  );
}

/**
 * The field's text, broken after group 4 so each line is four whole groups.
 * Left to wrap on its own, Android broke inside a group ("…-K7" / "M2-…"), which
 * is the one place a code must not be split. Display only: the break is a
 * newline `typedRecoveryCode` strips, so the value callers hold stays clean.
 */
function twoLines(code: string): string {
  return code.replace(/^((?:[^-]{4}-){3}[^-]{4})-/, '$1-\n');
}

const s = StyleSheet.create({
  box: {
    backgroundColor: color.ground2,
    borderColor: color.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: space.md,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.sm },
  cell: { alignItems: 'center', paddingVertical: space.xs, width: '25%' },
  index: { ...type.meta, color: color.inkFaint, fontSize: 10.5, marginBottom: 2 },
  group: { color: color.ink, fontFamily: font.mono, fontSize: 17, letterSpacing: 2 },

  field: { marginBottom: 0 },
  input: { fontFamily: font.mono, fontSize: 16, letterSpacing: 1, lineHeight: 24, textAlignVertical: 'top' },
  status: { alignItems: 'center', flexDirection: 'row', gap: space.xs, marginTop: space.sm },
  statusText: { ...type.small, color: color.inkFaint },
});
