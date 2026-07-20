import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationOverride } from './myNotifications';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { saveBusinessNotificationOverride, deleteBusinessNotificationOverride } from './notificationOverridesWrite';

beforeEach(() => {
  call.mockReset().mockResolvedValue({ ok: true, key: 'k' });
});

describe('saveBusinessNotificationOverride', () => {
  it('calls the deployed callable with the encoded wire payload', async () => {
    const override: NotificationOverride = {
      enabled: true,
      channels: { email: true, sms: false, push: true },
      lockedEnabled: true,
      locked: { email: true, sms: false },
      lockReason: 'Legal requirement',
      streams: {
        business: { channels: { sms: false }, locked: {} },
        staff: { channels: {}, locked: {} }, // empty -> dropped
      },
    };

    await saveBusinessNotificationOverride('kincare.booking.confirm', override);

    expect(call).toHaveBeenCalledWith('saveBusinessNotificationOverride', {
      key: 'kincare.booking.confirm',
      override: {
        enabled: true,
        channels: { email: true, sms: false, push: true },
        lockedEnabled: true,
        locked: { email: true }, // sms:false dropped (literal-true schema)
        lockReason: 'Legal requirement',
        streams: { business: { channels: { sms: false } } }, // empty staff gate dropped
      },
    });
  });

  it('propagates a callable rejection (fail-loud, never swallowed)', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(
      saveBusinessNotificationOverride('k', { enabled: true, channels: {}, lockedEnabled: false, locked: {}, streams: {} }),
    ).rejects.toThrow('permission-denied');
  });
});

describe('deleteBusinessNotificationOverride', () => {
  it('calls the deployed callable with just the key', async () => {
    await deleteBusinessNotificationOverride('kincare.booking.confirm');
    expect(call).toHaveBeenCalledWith('deleteBusinessNotificationOverride', {
      key: 'kincare.booking.confirm',
    });
  });
});
