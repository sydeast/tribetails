import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Timestamp } from 'firebase/firestore';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  markNotificationRead,
  markNotificationUnread,
  bulkMarkNotificationsRead,
  isRead,
  formatWhen,
  dayKey,
  type NotificationEntry,
} from './notifications';

/** A fake Firestore Timestamp — only `.toDate()` is ever called on it here. */
function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

beforeEach(() => call.mockReset());

describe('notifications api', () => {
  it('markNotificationRead sends { notificationId }', async () => {
    call.mockResolvedValue({ ok: true });
    await markNotificationRead('n1');
    expect(call).toHaveBeenCalledWith('markNotificationRead', { notificationId: 'n1' });
  });

  it('markNotificationUnread sends { notificationId }', async () => {
    call.mockResolvedValue({ ok: true });
    await markNotificationUnread('n1');
    expect(call).toHaveBeenCalledWith('markNotificationUnread', { notificationId: 'n1' });
  });

  it('bulkMarkNotificationsRead sends { ids } and unwraps `marked`', async () => {
    call.mockResolvedValue({ ok: true, marked: 2 });
    const marked = await bulkMarkNotificationsRead(['a', 'b', 'c']);
    expect(call).toHaveBeenCalledWith('bulkMarkNotificationsRead', { ids: ['a', 'b', 'c'] });
    // 2, not 3: some ids can be silently skipped server-side (missing / not owned).
    expect(marked).toBe(2);
  });

  it('isRead is true only once readAt is present', () => {
    const base: NotificationEntry = {
      _id: 'n1', key: 'k', category: 'c', recipientUid: 'u', status: 'dispatched', mode: 'trigger',
      channels: [], createdAt: fakeTs('2026-07-16T09:00:00Z'), targetType: '', targetId: '',
    };
    expect(isRead(base)).toBe(false);
    expect(isRead({ ...base, readAt: fakeTs('2026-07-16T10:00:00Z') })).toBe(true);
  });

  it('formatWhen renders a short date + time, never a fabricated relative delta', () => {
    expect(formatWhen(fakeTs('2026-07-16T09:30:00Z'))).toBe('07-16 09:30');
  });

  it('formatWhen says (no time) for a still-pending serverTimestamp write', () => {
    expect(formatWhen(null)).toBe('(no time)');
    expect(formatWhen(undefined)).toBe('(no time)');
  });

  it('dayKey groups by YYYY-MM-DD and falls back to Undated', () => {
    expect(dayKey(fakeTs('2026-07-16T09:30:00Z'))).toBe('2026-07-16');
    expect(dayKey(null)).toBe('Undated');
  });
});
