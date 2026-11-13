import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn().mockReturnValue('s1'), initSentry: () => {} }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  buildStaffNotificationOptions,
  getMyStaffNotificationOptionsHandler,
  staffGateFrom,
} from '../src/admin/myStaffNotificationOptions';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

const STAFF_KEYS = Object.values(NOTIFICATION_CATALOG)
  .filter((d) => d.audiences.staff === true)
  .map((d) => d.key)
  .sort();

const ROW_KEYS = [
  'allowedChannels',
  'alwaysEnabled',
  'audience',
  'audiences',
  'category',
  'deliveryMode',
  'description',
  'key',
  'kinfolkFacing',
  'label',
  'required',
];

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.dbFn.mockReset();
});

describe('#2182 buildStaffNotificationOptions', () => {
  it('lists only the notifications the staff stream receives', () => {
    const out = buildStaffNotificationOptions({});
    expect(STAFF_KEYS.length).toBeGreaterThan(0);
    expect(out.catalog.map((r) => r.key).sort()).toEqual(STAFF_KEYS);
    expect(out.catalog.some((r) => r.key === 'kincare.booking.confirm')).toBe(false);
  });

  it('every row is staff-only and carries how it is drawn, not what fires it or who else gets it', () => {
    const out = buildStaffNotificationOptions({});
    for (const row of out.catalog) {
      expect(row.audiences).toEqual({ staff: true });
      expect(row.kinfolkFacing).toBe(false);
      const keys = Object.keys(row).filter((k) => k !== 'alwaysEnabledStreams').sort();
      expect(keys, row.key).toEqual(ROW_KEYS);
    }
    const wire = JSON.stringify(out);
    for (const owner of ['emitters', 'whoReceives', 'templates', 'mergeFields', 'recipientResolver', 'ungated', 'businessAdmin']) {
      expect(wire, `must not carry ${owner}`).not.toContain(owner);
    }
  });

  it('keeps only the staff-facing overrides, and never another stream', () => {
    const out = buildStaffNotificationOptions({
      'kincare.note.kinfolk': {
        enabled: true,
        channels: { email: true, sms: false },
        locked: { push: true },
        lockReason: '  The owner decided this.  ',
        streams: { business: { enabled: false, channels: { email: false } } },
      },
      'kincare.booking.confirm': { enabled: false, channels: { email: false } },
    });
    expect(Object.keys(out.overrides)).toEqual(['kincare.note.kinfolk']);
    expect(out.overrides['kincare.note.kinfolk']).toEqual({
      enabled: true,
      channels: { email: true, sms: false },
      locked: { push: true },
      lockReason: 'The owner decided this.',
    });
  });
});

describe('#2182 staffGateFrom', () => {
  it('the staff stream value wins, field by field, over the flat value', () => {
    expect(
      staffGateFrom({
        enabled: true,
        channels: { email: true, sms: true },
        lockedEnabled: false,
        locked: { email: true },
        streams: {
          staff: { enabled: false, channels: { sms: false }, lockedEnabled: true, locked: { sms: true } },
          kinfolk: { channels: { email: false } },
        },
      }),
    ).toEqual({
      enabled: false,
      channels: { email: true, sms: false },
      lockedEnabled: true,
      locked: { email: true, sms: true },
    });
  });
});

describe('#2182 getMyStaffNotificationOptions', () => {
  const handler = wrapAdminCallable('getMyStaffNotificationOptions', getMyStaffNotificationOptionsHandler);
  const stored = {
    'businessSettings/notifications': {
      byKey: { 'schedule.upcoming.digest': { enabled: true, channels: { sms: false }, lockedEnabled: true } },
      updatedAtMs: 1,
    },
  };

  it('answers an Auntie with her rows and the business gate on them', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: stored }).db);
    const res = await handler({ auth: { uid: 'auntie-1', token: { staffRole: 'auntie' } }, data: {} } as never);
    expect(res.catalog.map((r) => r.key).sort()).toEqual(STAFF_KEYS);
    expect(res.overrides['schedule.upcoming.digest']).toEqual({
      enabled: true,
      channels: { sms: false },
      lockedEnabled: true,
      locked: {},
    });
    expect(Object.keys(res).sort()).toEqual(['catalog', 'overrides']);
  });

  it('an empty store is the catalog with no overrides', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    const res = await handler({ auth: { uid: 'auntie-1', token: { staffRole: 'auntie' } }, data: {} } as never);
    expect(res.overrides).toEqual({});
    expect(res.catalog.length).toBe(STAFF_KEYS.length);
  });

  it('refuses a household account and an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: stored }).db);
    await expect(
      handler({ auth: { uid: 'kf-1', token: { role: 'kinfolk', kinfolkId: 'k1' } }, data: {} } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(handler({ auth: undefined, data: {} } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
