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
    // #832 adds one dedupe-ledger entry per copy, written in the same commit.
    const writtenPaths = ctx.writes.map((w) => w.path);
    expect(
      writtenPaths.every(
        (p) =>
          p.startsWith('notifications/') ||
          p.startsWith('notificationDispatch/') ||
          p.startsWith('notificationDedupe/'),
      ),
    ).toBe(true);
    expect(writtenPaths.filter((p) => p.startsWith('notificationDedupe/'))).toHaveLength(3);
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

  // #866: "nobody exists" and "the lookup failed" are no longer the same answer.
  // A caller that treats the first as final (the Stripe webhook stops retrying)
  // must never see it for the second.
  it('NEGATIVE: every resolver empty BY DEFINITION rejects with the no-recipients code', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { isNoRecipientsError } = await import('../src/notifications/recipientErrors');

    const err = await enqueueNotification({ key: 'kincare.booking.confirm', recipientUid: '', data: {} }).catch(
      (e: unknown) => e,
    );
    expect(isNoRecipientsError(err)).toBe(true);
  });

  /**
   * A db whose ONLY failure is the `businessSettings/admins` read. The
   * dispatcher reads other businessSettings documents too (the operator's
   * per-key overrides), so failing the whole collection would reject every call
   * and prove nothing about the resolver.
   */
  function rosterReadFails() {
    const ctx = buildDbMock({ docs: {} });
    const readError = Object.assign(new Error('14 UNAVAILABLE: deadline exceeded'), { code: 14 });
    const db = {
      ...ctx.db,
      collection: (path: string) => {
        const real = ctx.db.collection(path);
        if (path !== 'businessSettings') return real;
        return {
          ...real,
          doc: (id?: string) =>
            id === 'admins' ? { get: async () => { throw readError; } } : real.doc(id),
        };
      },
    };
    mocks.dbFn.mockReturnValue(db);
    return { ctx, readError };
  }

  // #866 fourth review: a failed office-roster read must not cost the household
  // its copy. Main delivered it (the failure was swallowed), and so must this.
  it('a failed roster READ still delivers the household copy, and reports businessAdmins unresolved', async () => {
    const { ctx } = rosterReadFails();
    const { enqueueNotificationDetailed } = await import('../src/notifications/dispatcher');

    const outcome = await enqueueNotificationDetailed({
      key: 'kincare.booking.confirm',
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
    });

    const household = ctx.writes.filter(
      (w) => w.path.startsWith('notifications/') && (w.data as { recipientUid?: string }).recipientUid === 'kinUid',
    );
    expect(household).toHaveLength(1);
    expect(outcome.written).toHaveLength(1);
    expect(outcome.unresolved).toEqual([
      { resolver: 'businessAdmins', error: expect.stringContaining('UNAVAILABLE') },
    ]);
    // Reported loudly, not swallowed.
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'resolver.lookup.failed' }),
    );
  });

  describe.each([
    // [key, primary resolver, secondary resolver, data]
    ['kincare.booking.confirm', { bookingId: 'b1', kinfolkId: 'kf1' }],
    ['invoice.new', { invoiceId: 'inv1', kinfolkId: 'kf1' }],
    ['invoice.payment.applied', { invoiceId: 'inv1', kinfolkId: 'kf1', paymentId: 'p1' }],
    ['kincare.changed', { bookingId: 'b1', kinfolkId: 'kf1' }],
  ] as const)('only the roster read fails: %s', (key, data) => {
    it('delivers the household copy and resolves', async () => {
      const { ctx } = rosterReadFails();
      const ids = await enqueueNotification({ key, recipientUid: 'kinUid', data: { ...data } });
      const household = ctx.writes.filter(
        (w) => w.path.startsWith('notifications/') && (w.data as { recipientUid?: string }).recipientUid === 'kinUid',
      );
      expect(household).toHaveLength(1);
      expect(ids).toHaveLength(1);
    });
  });

  it('only the roster read fails: profile.updated (debounced) still writes the household pending row', async () => {
    const { ctx } = rosterReadFails();
    await enqueueNotification({ key: 'profile.updated', recipientUid: 'kinUid', data: { kinfolkId: 'kf1' } });
    const pending = ctx.writes.filter((w) => w.path.startsWith('pendingNotifications/'));
    expect(pending.map((w) => w.path)).toEqual(['pendingNotifications/kinUid_profile.updated']);
  });

  it('control: a specificUid-only key never reads the roster, so its failure changes nothing', async () => {
    const { ctx } = rosterReadFails();
    const { enqueueNotificationDetailed } = await import('../src/notifications/dispatcher');
    const outcome = await enqueueNotificationDetailed({
      key: 'auth.account.locked',
      recipientUid: 'kinUid',
      data: { email: 'a@b.c', lockStartedAtMs: 1 },
    });
    expect(outcome.written).toHaveLength(1);
    expect(outcome.unresolved).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toHaveLength(1);
  });

  it('with no household uid, a failed roster READ is rethrown as itself, never as "nobody exists"', async () => {
    const { ctx, readError } = rosterReadFails();
    const { isNoRecipientsError } = await import('../src/notifications/recipientErrors');
    const err = await enqueueNotification({ key: 'kincare.booking.confirm', recipientUid: '', data: { bookingId: 'b1' } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(readError);
    expect(isNoRecipientsError(err)).toBe(false);
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toHaveLength(0);
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
        // This fixture supplies the settings doc itself, so `buildDbMock`'s
        // gate seeding does not apply and the gate has to be stated here.
        'business_settings/business_settings': { notificationsPaused: true, householdNotificationsLive: true },
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

  it('DISPATCHER: auth.password.reset is external, so an enqueue writes nothing', async () => {
    // #905: the reset trigger sends this email itself (auth/requestPasswordReset.ts).
    // If anything did enqueue it, the dispatcher must not store the link it carries.
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);

    const ids = await enqueueNotification({
      key: 'auth.password.reset',
      recipientUid: 'kinUid',
      data: { link: 'https://kinfolk.tribetails.com/account/secure-reset?oobCode=abc', email: 'x@y.z', displayName: 'Pepper' },
    });

    expect(ids).toEqual([]);
    expect(ctx.writes.filter((w) => /^notification/.test(w.path))).toEqual([]);
  });
});
