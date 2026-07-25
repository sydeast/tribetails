import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import type { NotificationEntry } from '../api/notifications';
import {
  NOTIF_UNREAD_FILTER,
  activeNotifications,
  notificationCategories,
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
