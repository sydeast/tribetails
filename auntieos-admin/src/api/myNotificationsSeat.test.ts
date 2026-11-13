import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call, currentSessionSeat } = vi.hoisted(() => ({ call: vi.fn(), currentSessionSeat: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('../lib/sessionSeat', () => ({ currentSessionSeat }));

import { getMyNotificationMatrix, STREAM_BUSINESS, STREAM_STAFF } from './myNotifications';
import { adminVisibleNotifications } from '../lib/myNotificationsFormat';

/** What `getMyStaffNotificationOptions` answers: staff rows only, one flat gate each. */
const STAFF_REPLY = {
  catalog: [
    {
      key: 'schedule.upcoming.digest',
      label: 'Your schedule',
      category: 'visit',
      audience: 'staff',
      audiences: { staff: true },
      allowedChannels: ['email', 'sms', 'push'],
      required: {},
      alwaysEnabled: false,
      kinfolkFacing: false,
      deliveryMode: 'scheduled',
      description: '',
    },
  ],
  overrides: {
    'schedule.upcoming.digest': { enabled: true, channels: { sms: false }, locked: { email: true }, lockReason: 'Set by the owner.' },
  },
};

beforeEach(() => {
  call.mockReset();
  currentSessionSeat.mockReset();
});

describe('#2182 getMyNotificationMatrix', () => {
  it('the owner reads the full business matrix, as before', async () => {
    currentSessionSeat.mockResolvedValue({ uid: 'o1', caretaker: false });
    call.mockResolvedValue({ catalog: [], overrides: {} });
    await getMyNotificationMatrix();
    expect(call).toHaveBeenCalledWith('getBusinessNotificationOverrides', {});
    expect(call).not.toHaveBeenCalledWith('getMyStaffNotificationOptions', {});
  });

  it('an Auntie reads only her own options, never the Settings > Notifications read', async () => {
    currentSessionSeat.mockResolvedValue({ uid: 'a1', caretaker: true });
    call.mockResolvedValue(STAFF_REPLY);
    const matrix = await getMyNotificationMatrix();
    expect(call).toHaveBeenCalledWith('getMyStaffNotificationOptions', {});
    expect(call).not.toHaveBeenCalledWith('getBusinessNotificationOverrides', {});
    // Her rows draw under "As the Auntie" and nothing draws under "As the owner".
    expect(adminVisibleNotifications(matrix, STREAM_STAFF).map((e) => e.key)).toEqual(['schedule.upcoming.digest']);
    expect(adminVisibleNotifications(matrix, STREAM_BUSINESS)).toEqual([]);
    expect(matrix.overrides['schedule.upcoming.digest']?.locked.email).toBe(true);
    expect(matrix.overrides['schedule.upcoming.digest']?.lockReason).toBe('Set by the owner.');
  });

  it("an Auntie's failed read throws, for the screen to say so", async () => {
    currentSessionSeat.mockResolvedValue({ uid: 'a1', caretaker: true });
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(getMyNotificationMatrix()).rejects.toThrow('permission-denied');
  });
});
