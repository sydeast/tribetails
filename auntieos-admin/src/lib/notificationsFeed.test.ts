import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import type { NotificationEntry } from '../api/notifications';
import {
  NOTIF_UNREAD_FILTER,
  activeNotifications,
  dispatchedNotificationCount,
  isNotificationArchived,
  notificationCategories,
  notificationsForArchived,
  unreadAmong,
  notificationsByDay,
  notificationsForFilter,
  unreadNotifications,
  unreadNotificationCount,
} from './notificationsFeed';

function ts(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<NotificationEntry>): NotificationEntry {
  return { _id: 'n1', key: 'kincare.booking.confirm', createdAt: ts('2026-07-16T09:30:00Z'), ...over };
}

describe('activeNotifications', () => {
  it('keeps rows with no archivedAt', () => {
    const rows = [entry({ _id: 'a' }), entry({ _id: 'b' })];
    expect(activeNotifications(rows).map((r) => r._id)).toEqual(['a', 'b']);
  });

  it('drops archived rows so they never reappear in the feed', () => {
    const rows = [entry({ _id: 'a' }), entry({ _id: 'b', archivedAt: ts('2026-07-16T10:00:00Z') })];
    expect(activeNotifications(rows).map((r) => r._id)).toEqual(['a']);
  });

  it('preserves the stream order it was given', () => {
    const rows = [entry({ _id: 'c' }), entry({ _id: 'a' }), entry({ _id: 'b' })];
    expect(activeNotifications(rows).map((r) => r._id)).toEqual(['c', 'a', 'b']);
  });
});

describe('unreadNotifications', () => {
  it('keeps only rows with no readAt', () => {
    const rows = [entry({ _id: 'a' }), entry({ _id: 'b', readAt: ts('2026-07-16T10:00:00Z') })];
    expect(unreadNotifications(rows).map((r) => r._id)).toEqual(['a']);
  });

  it('excludes an archived row even when it is unread', () => {
    const rows = [entry({ _id: 'a', archivedAt: ts('2026-07-16T10:00:00Z') }), entry({ _id: 'b' })];
    expect(unreadNotifications(rows).map((r) => r._id)).toEqual(['b']);
  });

  it('is empty for an empty feed', () => {
    expect(unreadNotifications([])).toEqual([]);
  });
});

describe('unreadNotificationCount', () => {
  it('counts unread, unarchived rows only', () => {
    const rows = [
      entry({ _id: 'a' }),
      entry({ _id: 'b', readAt: ts('2026-07-16T10:00:00Z') }),
      entry({ _id: 'c', archivedAt: ts('2026-07-16T10:00:00Z') }),
      entry({ _id: 'd' }),
    ];
    expect(unreadNotificationCount(rows)).toBe(2);
  });

  it('is 0 for an empty feed', () => {
    expect(unreadNotificationCount([])).toBe(0);
  });
});

describe('notificationCategories', () => {
  it('lists the categories actually present, sorted, never an invented taxonomy', () => {
    const rows = [
      entry({ _id: 'a', category: 'payments' }),
      entry({ _id: 'b', category: 'bookings' }),
      entry({ _id: 'c', category: 'payments' }),
    ];
    expect(notificationCategories(rows)).toEqual(['bookings', 'payments']);
  });

  it('buckets a blank or absent category under "uncategorized"', () => {
    const rows = [entry({ _id: 'a', category: '' }), entry({ _id: 'b' })];
    expect(notificationCategories(rows)).toEqual(['uncategorized']);
  });
});

describe('notificationsForFilter', () => {
  const rows = [
    entry({ _id: 'a', category: 'bookings' }),
    entry({ _id: 'b', category: 'payments', readAt: ts('2026-07-16T10:00:00Z') }),
    entry({ _id: 'c' }),
  ];

  it('passes everything through for the All chip', () => {
    expect(notificationsForFilter(rows, null).map((r) => r._id)).toEqual(['a', 'b', 'c']);
  });

  it('narrows to unread on the Unread chip, by the real readAt field', () => {
    expect(notificationsForFilter(rows, NOTIF_UNREAD_FILTER).map((r) => r._id)).toEqual(['a', 'c']);
  });

  it('narrows to one category, blank categories matching "uncategorized"', () => {
    expect(notificationsForFilter(rows, 'bookings').map((r) => r._id)).toEqual(['a']);
    expect(notificationsForFilter(rows, 'uncategorized').map((r) => r._id)).toEqual(['c']);
  });

  it('is empty rather than falling back to everything for a category nothing matches', () => {
    expect(notificationsForFilter(rows, 'nope')).toEqual([]);
  });
});

describe('notificationsByDay', () => {
  it('groups consecutive rows under their local day key, preserving stream order', () => {
    const rows = [
      entry({ _id: 'a', createdAt: ts('2026-07-16T15:30:00Z') }),
      entry({ _id: 'b', createdAt: ts('2026-07-16T12:00:00Z') }),
      entry({ _id: 'c', createdAt: ts('2026-07-15T12:00:00Z') }),
    ];
    const groups = notificationsByDay(rows);
    expect(groups.map(([day]) => day)).toEqual(['2026-07-16', '2026-07-15']);
    expect(groups[0]![1].map((r) => r._id)).toEqual(['a', 'b']);
    expect(groups[1]![1].map((r) => r._id)).toEqual(['c']);
  });

  it('groups rows with no usable timestamp under one Undated separator', () => {
    const groups = notificationsByDay([entry({ _id: 'a', createdAt: null })]);
    expect(groups.map(([day]) => day)).toEqual(['Undated']);
  });
});
/**
 * THE THREE SHAPES `archivedAt` CAN ARRIVE IN, and why one predicate has to own
 * all three. `unarchiveNotification` merge-writes null rather than deleting the
 * field, so a restored row is neither "absent" nor "a timestamp". The old
 * `=== undefined` test would have read it as still archived and hidden it
 * forever, with no error to notice.
 */
describe('isNotificationArchived', () => {
  it('reads a real timestamp as archived', () => {
    expect(isNotificationArchived(entry({ archivedAt: ts('2026-07-16T10:00:00Z') }))).toBe(true);
  });
  it('reads an ABSENT field as not archived (never archived)', () => {
    expect(isNotificationArchived(entry({}))).toBe(false);
  });
  it('reads an explicit NULL as not archived (archived once, then restored)', () => {
    expect(isNotificationArchived(entry({ archivedAt: null }))).toBe(false);
  });
});
describe('activeNotifications, after restore', () => {
  it('a restored row is back in the active feed', () => {
    const rows = [entry({ _id: 'a', archivedAt: null }), entry({ _id: 'b', archivedAt: ts('2026-07-16T10:00:00Z') })];
    expect(activeNotifications(rows).map((r) => r._id)).toEqual(['a']);
  });
});
describe('notificationsForArchived', () => {
  const rows = [
    entry({ _id: 'active' }),
    entry({ _id: 'restored', archivedAt: null }),
    entry({ _id: 'filed', archivedAt: ts('2026-07-16T10:00:00Z') }),
  ];
  it('hide: the default, active rows only', () => {
    expect(notificationsForArchived(rows, 'hide').map((r) => r._id)).toEqual(['active', 'restored']);
  });
  it('include: everything, in stream order', () => {
    expect(notificationsForArchived(rows, 'include').map((r) => r._id)).toEqual([
      'active',
      'restored',
      'filed',
    ]);
  });
  it('only: the archived rows, so a misfiled one can be found again', () => {
    expect(notificationsForArchived(rows, 'only').map((r) => r._id)).toEqual(['filed']);
  });
  it('answers empty rather than falling back to everything when nothing is archived', () => {
    expect(notificationsForArchived([entry({ _id: 'a' })], 'only')).toEqual([]);
  });
  it('does not mutate its input', () => {
    const input = [entry({ _id: 'a' })];
    notificationsForArchived(input, 'include');
    expect(input).toHaveLength(1);
  });
  it('handles an empty feed in every mode', () => {
    expect(notificationsForArchived([], 'hide')).toEqual([]);
    expect(notificationsForArchived([], 'include')).toEqual([]);
    expect(notificationsForArchived([], 'only')).toEqual([]);
  });
});
/**
 * A DIFFERENT AXIS FROM READ STATE. `status` is the dispatcher's own pipeline;
 * `readAt` is the operator. Collapsing them would hide a delivery outage behind
 * a healthy-looking inbox.
 */
describe('dispatchedNotificationCount', () => {
  it('counts only rows the sender says it delivered', () => {
    expect(
      dispatchedNotificationCount([
        entry({ _id: 'a', status: 'dispatched' }),
        entry({ _id: 'b', status: 'pending' }),
      ]),
    ).toBe(1);
  });
  it('counts a dispatched row that is still unread, because the two are unrelated', () => {
    expect(dispatchedNotificationCount([entry({ _id: 'a', status: 'dispatched' })])).toBe(1);
  });
  it('is case and whitespace insensitive, matching what the dispatcher really writes', () => {
    expect(dispatchedNotificationCount([entry({ _id: 'a', status: ' Dispatched ' })])).toBe(1);
  });
  it('does not count an absent or blank status as delivered', () => {
    expect(
      dispatchedNotificationCount([entry({ _id: 'a' }), entry({ _id: 'b', status: '' })]),
    ).toBe(0);
  });
  it('excludes archived rows, like every other figure on the strip', () => {
    expect(
      dispatchedNotificationCount([
        entry({ _id: 'a', status: 'dispatched', archivedAt: ts('2026-07-16T10:00:00Z') }),
      ]),
    ).toBe(0);
  });
  it('is 0 on an empty feed', () => {
    expect(dispatchedNotificationCount([])).toBe(0);
  });
});
/**
 * WHAT THE BULK MARK-READ BUTTON SENDS, which is not the selection.
 * `bulkMarkNotificationsRead` skips already-read rows and reports how many it
 * really marked, so sending five ids of which three are read came back as
 * "Marked 2 of 5" for a batch in which nothing failed.
 */
describe('unreadAmong', () => {
  const rows = [
    entry({ _id: 'a' }),
    entry({ _id: 'b', readAt: ts('2026-07-16T10:00:00Z') }),
    entry({ _id: 'c' }),
  ];
  it('narrows a mixed selection to the unread ids only', () => {
    expect(unreadAmong(rows, new Set(['a', 'b', 'c']))).toEqual(['a', 'c']);
  });
  it('answers empty when every selected row is already read', () => {
    expect(unreadAmong(rows, new Set(['b']))).toEqual([]);
  });
  it('ignores selected ids that are no longer in the feed', () => {
    expect(unreadAmong(rows, new Set(['a', 'ghost']))).toEqual(['a']);
  });
  it('answers empty for an empty selection', () => {
    expect(unreadAmong(rows, new Set())).toEqual([]);
  });
  it('preserves the feed order rather than the selection order', () => {
    expect(unreadAmong(rows, new Set(['c', 'a']))).toEqual(['a', 'c']);
  });
});
