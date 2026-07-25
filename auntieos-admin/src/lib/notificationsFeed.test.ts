import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import type { NotificationEntry } from '../api/notifications';
import { activeNotifications, unreadNotifications, unreadNotificationCount } from './notificationsFeed';

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
