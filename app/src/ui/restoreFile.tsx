import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isTransferFile } from '../core/transferFile';
import { userMessage } from '../lib/errors';
import { pickTextFile, TRANSFER_FILE_CAP } from '../lib/files';
import { color, radius, space, type } from '../theme';
import { Icon } from './Icon';
import { SecondaryButton } from './primitives';

/**
 * Loading the file a restore field takes: a recovery backup or a device
 * transfer, told apart by what is in it.
 *
 * A backup is a few kilobytes of armor and goes into the text field, where it
 * can be checked by eye or pasted over. A transfer can be megabytes, since it
 * carries every message read with quantum keys, and a string that size in a
 * text input is enough to stall the screen — so it is held here instead, shown
 * as a card, and handed to the restore in place of the field's text.
 */
export function useRestoreFile(onBackupText: (text: string) => void, onError: (message: string | null) => void) {
  const [transfer, setTransfer] = useState<string | null>(null);

  const load = async () => {
    onError(null);
    try {
      const result = await pickTextFile(TRANSFER_FILE_CAP);
      if (!result) return;
      if ('refused' in result) {
        onError(result.refused);
        return;
      }
      const text = result.text.trim();
      if (isTransferFile(text)) {
        setTransfer(text);
      } else {
        setTransfer(null);
        onBackupText(text);
      }
    } catch (e) {
      onError(`Couldn’t open that file. ${userMessage(e)}`);
    }
  };

  return { transfer, load, clear: () => setTransfer(null) };
}

/** The loaded transfer, in place of the text field. */
export function LoadedTransfer({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <View style={s.card} accessibilityLabel={`Transfer file loaded, ${sizeOf(text)}`}>
      <Icon name="file" size={20} color={color.inkDim} />
      <View style={s.words}>
        <Text style={s.title}>Transfer file loaded</Text>
        <Text style={s.hint}>
          {sizeOf(text)} · your key, your quantum key bank and mail read with quantum keys
        </Text>
      </View>
      <SecondaryButton title="Clear" icon="close" onPress={onClear} />
    </View>
  );
}

function sizeOf(text: string): string {
  const kb = text.length / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const s = StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: color.ground2,
    borderColor: color.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.md,
    padding: space.md,
  },
  words: { flex: 1, gap: 2 },
  title: { ...type.strong, color: color.ink },
  hint: { ...type.small, color: color.inkFaint },
});
