import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Timestamp } from 'firebase/firestore';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  markNotificationRead,
  markNotificationUnread,
  bulkMarkNotificationsRead,
  isRead,
  type NotificationEntry,
} from './notifications';

/** A fake Firestore Timestamp, only `.toDate()` is ever called on it here. */
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



});
