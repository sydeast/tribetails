import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

import { enqueueNotification } from '../src/notifications/dispatcher';

/**
 * End-to-end fan-out tests for the multi-audience refactor (#43).
 * Catalog keys exercised:
 *   - kincare.booking.confirm  (primary kinfolkAcct, secondary businessAdmins)
 *   - pets.updated             (primary businessAdmins, secondary kinfolkAcct, debounced)
 */
describe('enqueueNotification fan-out (audience:both)', () => {
  it('HAPPY: kincare.booking.confirm dispatches to kinfolk + every business admin', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1', 'admin2'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1', kinfolkId: 'kfId' },
    });

    expect(ids.length).toBe(3); // 1 kinfolk + 2 admins
    // R5: each copy is now a PAIR: the inbox doc and its id-matched work order.
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(
      writtenPaths.every(
        (p) => p.startsWith('notifications/') || p.startsWith('notificationDispatch/'),
      ),
    ).toBe(true);
    const notifIds = writtenPaths
      .filter((p) => p.startsWith('notifications/'))
      .map((p) => p.slice('notifications/'.length))
      .sort();
    const dispatchIds = writtenPaths
      .filter((p) => p.startsWith('notificationDispatch/'))
      .map((p) => p.slice('notificationDispatch/'.length))
      .sort();
    expect(notifIds).toHaveLength(3);
    // Id-matched, which is the whole basis of the split: the work order is
    // findable from the notification and vice versa without a query.
    expect(dispatchIds).toEqual(notifIds);
  });

  /**
   * THE R5 SPLIT, asserted from both sides.
   *
   * This replaces assertions that pinned `channels` onto the notification doc.
   * Delivery state on an inbox record is what made both admin clients render
   * "channels: email, sms" and a "Dispatched" counter as card content, which the
   * operator called out as workflow leaking into Notifications. Asserting only
   * its ABSENCE would be a weaker test than the one it replaces, so this also
   * proves the state landed on the work order: the field did not vanish, it
   * moved, and a future change that drops it entirely fails here.
   */
  it('SPLIT: delivery state lands on the work order and NEVER on the notification', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1', kinfolkId: 'kfId' },
    });

    const inbox = ctx.writes.filter((w) => w.path.startsWith('notifications/'));
    expect(inbox.length).toBeGreaterThan(0);
    for (const w of inbox) {
      expect(w.data.status, 'inbox doc must carry no dispatch status').toBeUndefined();
      expect(w.data.mode, 'inbox doc must carry no delivery mode').toBeUndefined();
      expect(w.data.channels, 'inbox doc must carry no channel list').toBeUndefined();
      // ...while keeping everything a card actually renders.
      expect(w.data.title).toBeTruthy();
      expect(w.data.targetType).toBe('booking');
    }

    const orders = ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'));
    expect(orders.length).toBe(inbox.length);
    for (const w of orders) {
      expect(w.data).toMatchObject({
        key: 'kincare.booking.confirm',
        mode: 'trigger',
        status: 'pending',
        channels: ['email'],
      });
      expect(w.data.notificationId).toBe(w.path.slice('notificationDispatch/'.length));
    }
  });

  it('SAD: missing recipientUid still dispatches business side (primary fails, secondary OK)', async () => {
    // kincare.booking.confirm: primary kinfolkAcct requires recipientUid; secondary businessAdmins doesn't.
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: '',
      data: { bookingId: 'b1' },
    });

    expect(ids.length).toBe(1); // admin only
  });

  it('SAD: empty admins list still dispatches kinfolk side (primary OK, secondary fails)', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
    });

    expect(ids.length).toBe(1); // kinfolk only
  });

  it('NEGATIVE: both resolvers fail → throws "no recipients resolved"', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      enqueueNotification({
        key: 'kincare.booking.confirm',
        recipientUid: '',
        data: {},
      }),
    ).rejects.toThrow(/no recipients resolved/);
  });

  it('EDGE: dedupes same uid appearing in both resolvers', async () => {
    // Contrived but valid — primary returns uid X, secondary admin list also has X.
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['kinUid'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
    });

    expect(ids.length).toBe(1); // dedup'd to single dispatch
  });

  it('HAPPY: pets.updated dispatches via debounced path (writes to pendingNotifications)', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await enqueueNotification({
      key: 'pets.updated',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kfId', kinId: 'k1' },
    });

    const paths = ctx.writes.map((w) => w.path);
    expect(paths.some((p) => p.startsWith('pendingNotifications/'))).toBe(true);
  });

  it('IGNORES a legacy notificationsPaused flag (global master-pause removed 2026-06-25)', async () => {
    // The global "pause all notifications" master (box 1) was removed; the operator
    // never asked for it. A stale business_settings.notificationsPaused must NOT
    // suppress dispatch anymore.
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1', 'admin2'] },
        'business_settings/business_settings': { notificationsPaused: true },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1', kinfolkId: 'kfId' },
    });

    expect(ids.length).toBe(3); // kinfolk + 2 admins, not suppressed
  });

  it('NO-SECONDARY: single-audience key still dispatches normally', async () => {
    // kincare.auntie.on_my_way: audience='kinfolk', no secondaryResolver.
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kinUid',
      data: {},
    });

    expect(ids.length).toBe(1);
  });

  // Audience revamp 2026-07: the dispatcher resolves a per-recipient STREAM
  // (clients -> kinfolk; staff -> staff when the key serves staff, else business)
  // and gates each copy through the stream-effective override view.
  it('STREAMS: streams.kinfolk sms gate strips sms from the kinfolk copy only', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1'] },
        'businessSettings/notifications': {
          byKey: {
            'kincare.booking.confirm': {
              enabled: true,
              channels: { sms: true },
              streams: { kinfolk: { channels: { sms: false } } },
            },
          },
        },
        'clients/kinUid': { notificationPrefs: { byKey: { 'kincare.booking.confirm': { sms: true } } } },
        'staff/admin1': { notificationPrefs: { byKey: { 'kincare.booking.confirm': { sms: true } } } },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
    });

    expect(ids.length).toBe(2);
    // Resolved channels are read off the WORK ORDER since R5; the notification
    // doc for each copy no longer carries them.
    const orders = ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'));
    const kinOrder = orders.find((w) => w.data.recipientUid === 'kinUid');
    const staffOrder = orders.find((w) => w.data.recipientUid === 'admin1');
    expect(kinOrder!.data.channels).toEqual(['email']); // sms gated off for the kinfolk stream
    expect(staffOrder!.data.channels).toEqual(['email', 'sms']); // business stream keeps sms
  });

  it('STREAMS: streams.business.enabled=false suppresses only the business copies', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1', 'admin2'] },
        'businessSettings/notifications': {
          byKey: {
            'kincare.booking.confirm': {
              enabled: true,
              channels: {},
              streams: { business: { enabled: false } },
            },
          },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
    });

    expect(ids.length).toBe(1); // kinfolk copy survives, both admin copies suppressed
    const writes = ctx.writes.filter((w) => w.path.startsWith('notifications/'));
    expect(writes.length).toBe(1);
    expect(writes[0].data.recipientUid).toBe('kinUid');
  });

  it('STREAMS: a staff-audience key gates on the staff stream, not business', async () => {
    // kincare.note.kinfolk is staff-audience: its businessAdmins recipients ride
    // the STAFF stream, so a business-stream kill must not touch it...
    const bizKilled = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1'] },
        'businessSettings/notifications': {
          byKey: {
            'kincare.note.kinfolk': { enabled: true, channels: {}, streams: { business: { enabled: false } } },
          },
        },
      },
    });
    mocks.dbFn.mockReturnValue(bizKilled.db);
    const survived = await enqueueNotification({ key: 'kincare.note.kinfolk', data: { bookingId: 'b1' } });
    expect(survived.length).toBe(1);

    // ...while a staff-stream kill suppresses every copy.
    const staffKilled = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1'] },
        'businessSettings/notifications': {
          byKey: {
            'kincare.note.kinfolk': { enabled: true, channels: {}, streams: { staff: { enabled: false } } },
          },
        },
      },
    });
    mocks.dbFn.mockReturnValue(staffKilled.db);
    const suppressed = await enqueueNotification({ key: 'kincare.note.kinfolk', data: { bookingId: 'b1' } });
    expect(suppressed).toEqual([]);
  });

  it('STREAMS zero-migration: an override without streams gates every copy identically (legacy behavior)', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1'] },
        'businessSettings/notifications': {
          byKey: { 'kincare.booking.confirm': { enabled: true, channels: { sms: false } } },
        },
        'clients/kinUid': { notificationPrefs: { byKey: { 'kincare.booking.confirm': { sms: true } } } },
        'staff/admin1': { notificationPrefs: { byKey: { 'kincare.booking.confirm': { sms: true } } } },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
    });

    expect(ids.length).toBe(2);
    // Read off the WORK ORDER, not the notification (R5): the resolved channel
    // set is delivery state, and the assertion follows it to its new home
    // rather than being deleted along with the field it was reading.
    for (const w of ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'))) {
      expect(w.data.channels, `${String(w.data.recipientUid)} copy`).toEqual(['email']);
    }
  });

  it('DISPATCHER: auth.password.reset routes via dispatcher (email channel, specificUid)', async () => {
    // auth.password.reset is now dispatcher-owned (custom SendGrid delivery).
    // alwaysEnabled + required.email=true → always writes one notifications doc.
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'auth.password.reset',
      recipientUid: 'kinUid',
      data: { link: 'https://kinfolk.tribetails.com/account/secure-reset?oobCode=abc', email: 'x@y.z', displayName: 'Pepper' },
    });

    expect(ids.length).toBe(1);
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(writtenPaths.some((p) => p.startsWith('notifications/'))).toBe(true);
    const notifDoc = ctx.writes.find((w) => w.path.startsWith('notifications/'));
    expect(notifDoc?.data).toMatchObject({
      key: 'auth.password.reset',
      recipientUid: 'kinUid',
    });
    // The email channel is proven on the work order (R5), where it now lives.
    const order = ctx.writes.find((w) => w.path.startsWith('notificationDispatch/'));
    expect(order?.data).toMatchObject({
      key: 'auth.password.reset',
      recipientUid: 'kinUid',
      channels: ['email'],
      status: 'pending',
    });
  });
});
