/**
 * The one screen behind the drawer: **one bar, and a body that swaps under it.**
 *
 * Every row in the drawer — Inbox, Sent, Archive, Drafts, Scheduled, and the
 * categories — is a `Destination` (`ui/destination.tsx`), and choosing one
 * changes only what is rendered below the bar. None of them navigates.
 *
 * The bar lives *here*, not in the bodies, and that is the whole point rather
 * than a tidiness preference. A `MailTopBar` per body meant switching
 * destinations unmounted and remounted it: the aurora canvas restarted from a
 * zero height (a flat frame, then the band fading back in), the bar re-measured,
 * and the search text and tab were thrown away — a visible blink on a gesture
 * that is supposed to be a filter. Mounted once up here, the bar simply
 * re-renders with a different title, exactly as it always has when the category
 * changes. The same goes for the compose button and the filter sheet.
 *
 * So the state the bar owns lives here too — the search text, the
 * Primary/Encrypted lens, the filter — and is handed to whichever body is up.
 * That is also the honest model of it: they are properties of *the list you are
 * looking at*, not of one particular mailbox, and they survive a switch the way
 * they already survived changing category.
 *
 * Android's back button is wired here rather than in a body: without it, back
 * from Sent would leave the app, which is not what a screen that never pushed
 * anything should do.
 */
import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORY_LABELS } from '../categorizer/categorizer';
import { listDrafts } from '../drafts/drafts';
import { listLabels } from '../labels/labels';
import { initials } from '../lib/format';
import { listScheduled } from '../outbox/outbox';
import { snoozedRows } from '../snooze/snooze';
import { HomeProps } from '../navigation';
import { useApp } from '../state/AppState';
import { accountLabel, settingsOf } from '../store/accountScope';
import { SECONDARY_BOXES, SecondaryBox } from '../state/types';
import { color, font, radius, space, type } from '../theme';
import { Icon } from '../ui/Icon';
import { useAccent } from '../ui/appearance';
import { categoryOf, Destination, isInboxDestination, useDestination } from '../ui/destination';
import { INBOX_TABS, InboxTab } from '../ui/inboxTabs';
import { MailTopBar } from '../ui/mailBar';
import { Filter, FILTERS, needsAttention } from '../ui/mailFilter';
import { ComposeFab } from '../ui/mailList';
import { AllAccountsAvatar, Avatar, barIcon, IconButton, PressableRow, Segmented, Sheet } from '../ui/primitives';
import { ContactFilter, CONTACT_FILTERS, ContactsBody } from './ContactsScreen';
import { DraftsBody } from './DraftsScreen';
import { InboxBody } from './InboxScreen';
import { MailboxBody } from './MailboxScreen';
import { ScheduledBody } from './ScheduledScreen';
import { SnoozedBody } from './SnoozedScreen';

/** What every destination body is handed: the bar's state, plus navigation. */
export type BodyProps = HomeProps & {
  /** The bar's search text, applied to the rows this body has loaded. */
  query: string;
  /** The Primary/Encrypted lens. */
  tab: InboxTab;
  /** `attention` narrows to mail the reader has to decide something about. */
  filter: Filter;
  /** The bar's title row height — where a mail opened from here starts. */
  headerHeight: number;
  /** The bar's full height — how much band is still lit under an open mail. */
  barHeight: number;
  /** Puts search, lens, filter *and* destination back to their defaults. */
  clearFilters: () => void;
  /** Clears the search text alone — for a body with nothing else narrowing it. */
  clearSearch: () => void;
  /**
   * Whether a mail row should cascade in or simply be there.
   *
   * Decided here rather than in a body, because only this screen survives a
   * destination change: a body cannot tell its first mount from its fifth, so
   * every switch replayed the entry animation over mail that was already known
   * and the list took ~660 ms to become readable. This screen has seen every
   * list, so it can say that the cascade has already been spent.
   */
  entry: 'stagger' | 'none';
  /** Contacts' own three-way filter, since its strip carries no mail lens. */
  contactFilter: ContactFilter;
  /** Puts that filter back to All, from its "nobody in this state" empty. */
  showAllContacts: () => void;
  /**
   * A local label the mail lists narrow to, or `null` for no label filter.
   *
   * Chosen in the Filter sheet beside "Needs attention" rather than as drawer
   * destinations: a label is a filter over mail this device holds, exactly as
   * that one is, and it applies over the inbox and Sent, Archive and Trash
   * alike — labels are on messages, not on a folder.
   */
  labelFilter: string | null;
  /**
   * A body tells the screen whether it has rows selected, so the compose button
   * steps aside for the bulk action bar the body draws in its place.
   */
  onSelecting: (selecting: boolean) => void;
};

const TITLES: Record<string, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  archive: 'Archive',
  trash: 'Trash',
  drafts: 'Drafts',
  scheduled: 'Scheduled',
  snoozed: 'Snoozed',
  contacts: 'Contacts',
};

/**
 * Destinations whose rows are provider mail, and so carry the lens and filter.
 *
 * Snoozed is mail, but a short list of it that is ordered by when each message
 * comes back rather than when it arrived — so, like Scheduled, its strip says
 * how much is waiting instead of offering a lens over it.
 */
function showsMail(destination: Destination): boolean {
  return (
    destination !== 'drafts' && destination !== 'scheduled' && destination !== 'snoozed' && destination !== 'contacts'
  );
}

/** What the bar's search box says it will search, per destination. */
const SEARCH_HINT: Record<string, string> = {
  drafts: 'Search drafts',
  scheduled: 'Search queued mail',
  snoozed: 'Search snoozed mail',
  contacts: 'Search name or address',
};

/**
 * The height of the tallest control the bar's strip holds — the Filter chip:
 * 9 above and below a 14pt line of Manrope, plus its hairline border. Taken from
 * the rendered bar rather than derived, because a line box is the font's
 * business, not the stylesheet's.
 *
 * The strip is pinned to it so the bar is exactly one height on every
 * destination: Drafts has no tabs and no filter, and a strip that shrank to fit
 * its count line would move the list under it every time you switched.
 */
const CONTROL_HEIGHT = 43;

/** Plural without the "1 items" tell. */
function count(n: number, one: string, many: string, none: string): string {
  if (n === 0) return none;
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether the body in front has rows selected, held outside React state.
 *
 * As `useState` on the home screen, entering multi-select re-rendered the whole
 * screen — the bar and the body — after the body had already re-rendered for
 * the selection itself: a second ~200 ms pass on the first selection, on a dev
 * build, for the sake of hiding the compose button. Now only `ComposeSlot`
 * subscribes.
 */
class SelectingFlag {
  private value = false;
  private listeners = new Set<() => void>();
  set = (next: boolean) => {
    if (next === this.value) return;
    this.value = next;
    this.listeners.forEach((listener) => listener());
  };
  get = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

function ComposeSlot({ flag, bottom, onPress }: { flag: SelectingFlag; bottom: number; onPress: () => void }) {
  const selecting = useSyncExternalStore(flag.subscribe, flag.get);
  return selecting ? null : <ComposeFab bottom={bottom} onPress={onPress} />;
}

export function HomeScreen(props: HomeProps) {
  const { navigation } = props;
  const {
    session,
    accounts,
    activeAccount,
    messages,
    boxes,
    drafts,
    scheduled,
    snoozed,
    unified,
    labels,
    encryptionFor,
    refreshInbox,
    loadBox,
  } = useApp();
  const { destination, setDestination } = useDestination();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<InboxTab>('primary');
  const [filter, setFilter] = useState<Filter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [contactFilter, setContactFilter] = useState<ContactFilter>('all');
  const [chosenLabel, setChosenLabel] = useState<string | null>(null);
  // Not state: a body reporting that it is selecting must not re-render this
  // screen — the bar, its band and the body under it — to hide one button. Only
  // the compose slot listens. See `SelectingFlag`.
  const selectingFlag = useMemo(() => new SelectingFlag(), []);
  const setSelecting = selectingFlag.set;
  // A label deleted while it was the filter stops filtering, rather than
  // leaving an empty list narrowed by something the sheet can no longer show.
  const labelFilter = chosenLabel && labels.labels[chosenLabel] ? chosenLabel : null;
  const labelList = useMemo(() => listLabels(labels), [labels]);
  /** Measured on the bar, read by a body to place an opened mail. */
  const [headerHeight, setHeaderHeight] = useState(0);
  /** The whole bar, controls included — the band an open mail may stand on. */
  const [barHeight, setBarHeight] = useState(0);

  /** The mailbox in front, whose name and avatar mode the bar wears. */
  const activeRef = accounts.find((a) => a.id === activeAccount);

  const category = categoryOf(destination);
  const mail = showsMail(destination);
  const box: SecondaryBox | null = SECONDARY_BOXES.includes(destination as SecondaryBox)
    ? (destination as SecondaryBox)
    : null;

  const attention = useMemo(
    () => messages.filter((m) => needsAttention(encryptionFor(m))).length,
    [encryptionFor, messages],
  );

  /**
   * The entry cascade is spent once, on the first list this screen ever shows.
   *
   * Read from a ref during render and set from an effect, so the render that
   * *first* puts rows on screen still says `stagger` — the animation belongs to
   * that arrival — and every render after it says `none`. Switching destination
   * therefore swaps mail that is already known straight in, rather than fading
   * it up from nothing over the stagger's full length.
   */
  const cascadeSpent = useRef(false);
  const anyRows = messages.length > 0 || SECONDARY_BOXES.some((b) => boxes[b].items.length > 0);
  const entry: BodyProps['entry'] = cascadeSpent.current ? 'none' : 'stagger';
  useEffect(() => {
    if (anyRows) cascadeSpent.current = true;
  }, [anyRows]);

  const clearSearch = useCallback(() => setQuery(''), []);
  const showAllContacts = useCallback(() => setContactFilter('all'), []);

  const clearFilters = useCallback(() => {
    setQuery('');
    setFilter('all');
    setChosenLabel(null);
    setTab('primary');
    setContactFilter('all');
    setDestination('inbox');
  }, [setDestination]);

  // A destination is not a route, so the system back gesture has nothing to pop
  // — without this it would leave the app from Sent.
  useEffect(() => {
    if (!isFocused || isInboxDestination(destination)) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setDestination('inbox');
      return true;
    });
    return () => sub.remove();
  }, [destination, isFocused, setDestination]);

  const bodyProps: BodyProps = {
    ...props,
    query,
    tab,
    filter,
    headerHeight,
    barHeight,
    clearFilters,
    clearSearch,
    entry,
    contactFilter,
    showAllContacts,
    labelFilter,
    onSelecting: setSelecting,
  };

  // A body that is not up cannot hold a selection, so leaving it clears the flag
  // the compose button reads.
  useEffect(() => setSelecting(false), [destination]);

  return (
    <View style={s.screen}>
      <MailTopBar
        title={category ? CATEGORY_LABELS[category] : (TITLES[destination] ?? 'Inbox')}
        // No second line at all. A merged inbox still composes, sends and
        // decrypts as exactly one account, and a switch still takes a moment —
        // but the leading avatar here wears the active mailbox's face and
        // compose shows the account it sends from, so both were already
        // answered where they matter. What the subtitle added was a line under
        // the title that appeared and vanished, moving the list under it.
        leading={
          // The account avatar is the drawer handle, as in the reference — the
          // rail behind it is where mailboxes are switched. It is the same on
          // every destination, because none of them is a push.
          <Pressable
            accessibilityLabel="Accounts and folders"
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => navigation.openDrawer()}
            style={({ pressed }) => [pressed && { opacity: 0.7 }]}
          >
            {/* Merged, the bar wears the same mark as the rail control that
                merged it — one account's face here would say the list is that
                account's, which is exactly what it is not. Who is being sent
                as is not lost: this opens the rail, where the active mailbox
                is the one ringed in the accent. */}
            {unified ? (
              <AllAccountsAvatar active size={36} tone={accent} />
            ) : (
              <Avatar
                // The registry ref, not the session: the user's own name for
                // this mailbox and their "show as" choice live there, and the
                // bar has to wear the same face the rail does.
                label={initials(activeRef ? accountLabel(activeRef) : (session?.name ?? session?.email ?? ''))}
                mode={settingsOf(activeRef).avatar}
                photo={activeRef?.photo ?? session?.photo}
                seed={session?.email ?? ''}
                size={36}
              />
            )}
          </Pressable>
        }
        actions={
          <>
            {destination !== 'inbox' ? (
              <IconButton {...barIcon} icon="close" label="Show all mail" onPress={() => setDestination('inbox')} />
            ) : null}
            {mail ? (
              <IconButton
                {...barIcon}
                icon="refresh"
                label="Refresh"
                // The user tapped Refresh, so this one is theirs and shows a
                // spinner — unlike the sync each destination runs on mount.
                onPress={() =>
                  void (box ? loadBox(box, { manual: true }) : refreshInbox({ manual: true }))
                }
              />
            ) : null}
          </>
        }
        // Every destination is searchable — a draft is text you wrote, so there
        // is no reason the one search box goes dark over it.
        search={{ value: query, onChange: setQuery, placeholder: SEARCH_HINT[destination] }}
        // The strip is always drawn, at one height, whatever is in it: a bar
        // that grows and shrinks as the destination changes is the same jump
        // this screen exists to avoid. Drafts and Scheduled have no lens to
        // offer — Primary/Encrypted is a property of *received* mail, and a
        // draft has not been encrypted yet — so they say how much is in front of
        // you instead.
        controls={
          <View style={s.controls}>
            {mail ? (
              <>
                <Segmented compact options={INBOX_TABS} value={tab} onChange={setTab} />
                <Pressable
                  accessibilityLabel="Filter"
                  accessibilityRole="button"
                  onPress={() => setFilterOpen(true)}
                  style={({ pressed }) => [s.filterPill, pressed && { backgroundColor: color.segmentActive }]}
                >
                  <Text style={s.filterText}>Filter</Text>
                  {filter !== 'all' || labelFilter ? (
                    <View style={[s.filterDot, { backgroundColor: accent }]} />
                  ) : null}
                </Pressable>
              </>
            ) : destination === 'contacts' ? (
              // Contacts has a lens of its own — All · Verified · Unverified —
              // so it fills the strip rather than describing what is in it.
              // `stretch`ed into equal thirds, which keeps the sliding thumb's
              // corners circular: it is sized from the first tab and moved by
              // `scaleX`, and unequal tabs stretch those arcs flat.
              <Segmented
                compact
                stretch
                options={CONTACT_FILTERS}
                value={contactFilter}
                onChange={setContactFilter}
                style={s.contactFilter}
              />
            ) : (
              <Text style={s.countLabel}>
                {destination === 'drafts'
                  ? count(listDrafts(drafts).length, 'draft', 'drafts', 'No drafts')
                  : destination === 'snoozed'
                    ? count(
                        snoozedRows(snoozed, [], new Date().toISOString()).length,
                        'message snoozed',
                        'messages snoozed',
                        'Nothing snoozed',
                      )
                    : count(listScheduled(scheduled).length, 'message waiting', 'messages waiting', 'Nothing waiting')}
              </Text>
            )}
          </View>
        }
        onHeaderHeight={setHeaderHeight}
        onBarHeight={setBarHeight}
      />

      {box ? (
        // Deliberately **not** keyed on the box. A key here read as "start at
        // the top", but it bought that by tearing the whole body down and
        // building it again: the mount effect re-fetched a list already in
        // state, and every row replayed its entry animation. The body now stays
        // mounted and scrolls itself back to the top when the box changes,
        // which is the thing the key was actually for.
        <MailboxBody {...bodyProps} box={box} />
      ) : destination === 'drafts' ? (
        <DraftsBody {...bodyProps} />
      ) : destination === 'scheduled' ? (
        <ScheduledBody {...bodyProps} />
      ) : destination === 'snoozed' ? (
        <SnoozedBody {...bodyProps} />
      ) : destination === 'contacts' ? (
        <ContactsBody {...bodyProps} />
      ) : (
        <InboxBody {...bodyProps} />
      )}

      <ComposeSlot flag={selectingFlag} bottom={insets.bottom + 22} onPress={() => navigation.navigate('Compose', {})} />


      <Sheet bottomInset={insets.bottom} onClose={() => setFilterOpen(false)} title="Filter" visible={filterOpen}>
        {FILTERS.map((f) => (
          <PressableRow
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f.key }}
            key={f.key}
            onPress={() => {
              setFilter(f.key);
              setFilterOpen(false);
            }}
            style={s.filterRow}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.filterRowLabel}>{f.label}</Text>
              <Text style={s.filterRowHint}>{f.hint}</Text>
            </View>
            {f.key === 'attention' && attention > 0 ? (
              <View style={s.attentionCount}>
                <Text style={s.attentionCountText}>{attention}</Text>
              </View>
            ) : null}
            {filter === f.key ? <Icon name="check" size={19} color={accent} strokeWidth={2.4} /> : null}
          </PressableRow>
        ))}
        {/* Labels narrow on top of the choice above, so "Needs attention" under
            "Work" is a real combination rather than one replacing the other. */}
        {labelList.length > 0 ? (
          <>
            <Text style={s.sheetSection}>Label</Text>
            <ScrollView style={s.labelScroll}>
              {labelList.map((label) => {
                const on = labelFilter === label.id;
                return (
                  <PressableRow
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    key={label.id}
                    onPress={() => {
                      setChosenLabel(on ? null : label.id);
                      setFilterOpen(false);
                    }}
                    style={s.filterRow}
                  >
                    <Icon name="file" size={18} color={on ? accent : color.inkDim} />
                    <Text numberOfLines={1} style={[s.filterRowLabel, { flex: 1 }]}>
                      {label.name}
                    </Text>
                    {on ? <Icon name="check" size={19} color={accent} strokeWidth={2.4} /> : null}
                  </PressableRow>
                );
              })}
            </ScrollView>
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  // React Native's `minHeight` is a border-box height, so the padding is part
  // of it — the strip is the tallest control plus its own breathing room, and
  // that is what holds the bar at one height across destinations.
  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: CONTROL_HEIGHT + space.sm + space.md,
    paddingBottom: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  countLabel: { ...type.small, color: color.inkDim },
  // Takes the strip's width, the way the three-way control did on the screen it
  // replaces — the mail lens is two tabs and leaves room for the Filter chip.
  contactFilter: { flex: 1 },
  // An outline chip — a hairline border on the card fill — rather than a filled
  // segment-coloured pill.
  filterPill: {
    alignItems: 'center',
    backgroundColor: color.card,
    borderColor: color.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  filterText: { color: color.ink, fontFamily: font.sansMedium, fontSize: 14 },
  filterDot: { borderRadius: 3, height: 6, width: 6 },

  filterRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  filterRowLabel: { ...type.settingsRow, color: color.ink },
  filterRowHint: { ...type.settingsValue, color: color.inkFaint, marginTop: 1 },
  sheetSection: {
    ...type.settingsValue,
    color: color.inkFaint,
    fontFamily: font.sansSemibold,
    letterSpacing: 0.4,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    textTransform: 'uppercase',
  },
  labelScroll: { maxHeight: 260 },
  attentionCount: {
    backgroundColor: color.coralBg,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  attentionCountText: { color: color.coralInk, fontFamily: font.sansSemibold, fontSize: 12 },
});
