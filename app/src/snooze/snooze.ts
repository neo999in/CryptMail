/**
 * Snooze — hide a message until a chosen time, then resurface it.
 *
 * This module is the pure core: types + reducers + the due-time query the
 * scheduler polls. No storage, no React, no timers, no network.
 *
 * Shape mirrors outbox/outbox.ts intentionally: both are due-time queues.
 * The scheduler drives both from the same interval tick.
 */

/** One snoozed message entry. */
export type SnoozedMessage = {
  /** The mail message id being snoozed. */
  id: string;
  /** ISO-8601 timestamp: when to resurface this message. */
  until: string;
  /** ISO-8601 timestamp: when the snooze was applied. */
  snoozedAt: string;
};

/** All active snoozes, keyed by message id. */
export type SnoozeMap = Record<string, SnoozedMessage>;

/** Add or replace a snooze entry by id (pure). */
export function upsertSnooze(snoozes: SnoozeMap, item: SnoozedMessage): SnoozeMap {
  return { ...snoozes, [item.id]: item };
}

/** Remove a snooze entry by id; a missing id is a no-op (pure). */
export function removeSnooze(snoozes: SnoozeMap, id: string): SnoozeMap {
  const next = { ...snoozes };
  delete next[id];
  return next;
}

/** All snoozed messages, soonest due first. */
export function listSnoozed(snoozes: SnoozeMap): SnoozedMessage[] {
  return Object.values(snoozes).sort((a, b) => a.until.localeCompare(b.until));
}

/**
 * Messages whose snooze time has passed, soonest first.
 *
 * These should be removed from the snooze map so they reappear in the inbox.
 */
export function dueSnoozed(snoozes: SnoozeMap, now: string): SnoozedMessage[] {
  return listSnoozed(snoozes).filter((item) => item.until <= now);
}

/**
 * Whether a given message id is currently snoozed (i.e. not yet due).
 *
 * Used by InboxScreen to filter the message out of the visible list.
 */
export function isSnoozed(snoozes: SnoozeMap, id: string, now: string): boolean {
  const entry = snoozes[id];
  if (!entry) return false;
  return entry.until > now;
}

// ---------------------------------------------------------------------------
// Quick-snooze presets
// ---------------------------------------------------------------------------

export type QuickSnoozeOption = {
  key: string;
  label: string;
  sublabel: string;
  until: string;
};

/**
 * Calculate target timestamps for the standard quick-snooze options.
 *
 * All times are local-calendar based so "Tomorrow 9 AM" means what the user
 * expects, not a fixed 24-hour offset.
 */
export function quickSnoozeDates(now: Date = new Date()): QuickSnoozeOption[] {
  const snap = (d: Date) => d.toISOString();

  // Later today: +4 hours, capped to same-day 9 PM
  const laterToday = new Date(now);
  laterToday.setHours(laterToday.getHours() + 4, 0, 0, 0);
  if (laterToday.getDate() !== now.getDate()) {
    // Wrapped past midnight — use 9 PM tonight instead
    laterToday.setFullYear(now.getFullYear(), now.getMonth(), now.getDate());
    laterToday.setHours(21, 0, 0, 0);
  }

  // Tomorrow morning: next calendar day at 9 AM
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  // This weekend: coming Saturday at 9 AM (if today is Sat/Sun, still next Sat)
  const weekend = new Date(now);
  const dayOfWeek = weekend.getDay(); // 0=Sun, 6=Sat
  const daysUntilSat = dayOfWeek === 6 ? 7 : (6 - dayOfWeek + 7) % 7 || 7;
  weekend.setDate(weekend.getDate() + daysUntilSat);
  weekend.setHours(9, 0, 0, 0);

  // Next week: coming Monday at 9 AM
  const nextWeek = new Date(now);
  const daysUntilMon = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7;
  nextWeek.setDate(nextWeek.getDate() + daysUntilMon);
  nextWeek.setHours(9, 0, 0, 0);

  const fmt = (d: Date) =>
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const fmtDate = (d: Date) =>
    d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  return [
    {
      key: 'later_today',
      label: 'Later today',
      sublabel: fmt(laterToday),
      until: snap(laterToday),
    },
    {
      key: 'tomorrow',
      label: 'Tomorrow morning',
      sublabel: `${fmtDate(tomorrow)} · 9:00 AM`,
      until: snap(tomorrow),
    },
    {
      key: 'weekend',
      label: 'This weekend',
      sublabel: `${fmtDate(weekend)} · 9:00 AM`,
      until: snap(weekend),
    },
    {
      key: 'next_week',
      label: 'Next week',
      sublabel: `${fmtDate(nextWeek)} · 9:00 AM`,
      until: snap(nextWeek),
    },
  ];
}
