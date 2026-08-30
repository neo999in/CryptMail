import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { Attachment, dataUri, formatBytes, isImage } from '../mail/attachment';
import { color, radius, space, type } from '../theme';
import { Icon } from './Icon';

/**
 * How an attachment looks, in the two places one appears: as a chip while it is
 * being written, and as a row once it has arrived.
 *
 * Shared rather than written twice because the two have to agree about one
 * thing in particular — an image is shown, everything else is named. A reader
 * who has to tap a file to find out whether it is a picture is being asked to
 * open an attachment blind, which is the habit encryption.md is careful not to
 * teach anywhere else in this app.
 */

/** The glyph for a file, by type. Only images get their own; the rest are files. */
const iconFor = (a: Attachment) => (isImage(a) ? 'image' : 'file');

/* ------------------------------------------------------------- compose ---- */

/** One attached file in the composer, with the control that removes it. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  return (
    <View style={s.chip}>
      <Icon name={iconFor(attachment)} size={13} color={color.mint} />
      <Text numberOfLines={1} style={s.chipName}>
        {attachment.name}
      </Text>
      <Text style={s.chipSize}>{formatBytes(attachment.size)}</Text>
      <Pressable accessibilityLabel={`Remove ${attachment.name}`} hitSlop={8} onPress={onRemove}>
        <Icon name="close" size={12} color={color.inkFaint} />
      </Pressable>
    </View>
  );
}

/* -------------------------------------------------------------- reader ---- */

/**
 * The files on an opened message.
 *
 * An image is shown at size — a picture that has to be downloaded to be seen is
 * a picture nobody looks at — and everything else is a named row. Either one
 * saves the file on tap.
 *
 * `decrypted` is the label under the name: it is the one fact that makes this
 * different from any other mail client's attachment list, so it is stated on
 * every file rather than implied by the lock at the top of the screen.
 */
export function AttachmentList({
  attachments,
  decrypted,
  onSave,
  busyId,
}: {
  attachments: Attachment[];
  decrypted: boolean;
  onSave: (attachment: Attachment) => void;
  /** The file currently being written out, so its row can say so. */
  busyId?: string | null;
}) {
  if (attachments.length === 0) return null;

  return (
    <View style={s.list}>
      <View style={s.listHead}>
        <Icon name="paperclip" size={13} color={color.inkDim} />
        <Text style={s.listHeadText}>
          {attachments.length === 1 ? '1 attachment' : `${attachments.length} attachments`}
        </Text>
      </View>

      {attachments.map((a) => (
        <Pressable
          key={a.id}
          onPress={() => onSave(a)}
          style={({ pressed }) => [s.row, isImage(a) && s.rowImage, pressed && s.rowPressed]}
        >
          {isImage(a) ? (
            <Image
              accessibilityLabel={a.name}
              source={{ uri: dataUri(a) }}
              style={s.preview}
              resizeMode="cover"
            />
          ) : null}

          <View style={s.rowBody}>
            {isImage(a) ? null : (
              <View style={s.rowIcon}>
                <Icon name="file" size={18} color={color.inkDim} />
              </View>
            )}
            <View style={s.rowText}>
              <Text numberOfLines={1} style={s.rowName}>
                {a.name}
              </Text>
              <Text style={s.rowMeta}>
                {formatBytes(a.size)} · {decrypted ? 'decrypted on this device' : 'sent in the clear'}
              </Text>
            </View>

            <Icon
              name={busyId === a.id ? 'clock' : 'download'}
              size={16}
              color={busyId === a.id ? color.ink : color.inkDim}
            />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: '100%',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.mintLine,
    backgroundColor: color.mintBg,
  },
  chipName: { ...type.small, color: color.ink, flexShrink: 1 },
  chipSize: { ...type.meta, color: color.inkFaint },

  list: { marginTop: space.lg, gap: space.sm },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  listHeadText: { ...type.eyebrow, color: color.inkDim },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.lineSoft,
    backgroundColor: color.ground2,
  },
  rowImage: { flexDirection: 'column', alignItems: 'stretch', gap: space.sm },
  rowBody: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowPressed: { backgroundColor: color.rowPress },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceRaised,
  },
  preview: { width: '100%', height: 180, borderRadius: radius.xs, backgroundColor: color.surfaceRaised },
  rowText: { flex: 1, gap: 2 },
  rowName: { ...type.strong, color: color.ink },
  rowMeta: { ...type.meta, color: color.inkFaint },
});
