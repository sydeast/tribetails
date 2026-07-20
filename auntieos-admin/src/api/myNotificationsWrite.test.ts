import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { saveMyAdminNotificationPrefs } from './myNotificationsWrite';
import type { AdminNotificationPrefs } from './myNotifications';

beforeEach(() => call.mockReset());

const PREFS: AdminNotificationPrefs = {
  byKey: { 'kincare.booking.confirm': { sms: true } },
  byCategory: { visit: { push: false } },
  marketingOptIn: { newsletter: true },
};

describe('myNotificationsWrite api', () => {
  it('calls saveMyAdminNotificationPrefs with exactly { prefs }, matching the backend SaveArgs contract', async () => {
    call.mockResolvedValue({ ok: true });
    await saveMyAdminNotificationPrefs(PREFS);
    expect(call).toHaveBeenCalledWith('saveMyAdminNotificationPrefs', { prefs: PREFS });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('never sends a uid: the payload has no field for one', async () => {
    call.mockResolvedValue({ ok: true });
    await saveMyAdminNotificationPrefs(PREFS);
    const [, payload] = call.mock.calls[0]!;
    expect(Object.keys(payload as object)).toEqual(['prefs']);
  });

  it('propagates a callable failure rather than swallowing it (fail-loud)', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(saveMyAdminNotificationPrefs(PREFS)).rejects.toThrow('permission-denied');
  });
});
