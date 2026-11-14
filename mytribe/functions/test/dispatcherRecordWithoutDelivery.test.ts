import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import { DEDUPE_COLLECTION, enqueueNotificationDetailed } from '../src/notifications/dispatcher';
import { promoteQueuedNotification } from '../src/notifications/promoteQueued';
import { householdAppOnly, reachedAppOnly } from '../src/notifications/appOnly';
import { notificationDisabledFor } from '../src/notifications/prefs';
import { getNotificationDef } from '../src/notifications/catalog';

/**
 * #1505: THE NOTIFICATIONS LIST IS A CHANNEL OF ITS OWN.
 *
 * The dispatcher used to write `notifications/{id}` only when the recipient's
 * prefs left at least one delivery channel on. A kinfolk who turned off email,
 * text and push for a category therefore got no record either, and the list
 * behind the bell (#1316, reads `notifications` by `recipientUid`) never showed
 * the alert. Now the record is written regardless of delivery prefs and nothing
 * is sent: no work order, so no fan-out, no channel subdoc, no provider call.
 *
 * Three things that must NOT have moved are pinned alongside:
 *   - the household send gate still writes nothing at all, record included;
 *   - a notification the OPERATOR disabled (or a marketing key without opt-in)
 *     still writes nothing, reported as 'prefs' exactly as before;
 *   - a recipient with a channel on gets record AND work order, as before.
 *
 * `kincare.auntie.on_my_way` is trigger mode, kinfolk-only, `required: {}`, so
 * an explicit all-false per-key pref is honoured verbatim. `pets.updated` is the
 * debounced path with a kinfolk secondary resolver.
 */
const KEY = 'kincare.auntie.on_my_way';
const BASE_MS = Date.UTC(2026, 10, 2, 15, 0, 0);

const ALL_OFF = { email: false, sms: false, push: false };

/** A kinfolk who left the notification on and turned every delivery channel off. */
function allOffPrefs(key: string = KEY): Record<string, Record<string, unknown>> {
  return { 'clients/kinUid': { notificationPrefs: { byKey: { [key]: ALL_OFF } } } };
}

type Write = { path: string; data: Record<string, unknown> };
const records = (writes: Write[]) => writes.filter((w) => w.path.startsWith('notifications/'));
const workOrders = (writes: Write[]) => writes.filter((w) => w.path.startsWith('notificationDispatch/'));
const ledger = (writes: Write[]) => writes.filter((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`));
const queued = (writes: Write[]) => writes.filter((w) => w.path.startsWith('pendingNotifications/'));
const events = (): string[] => mocks.logEventFn.mock.calls.map((c) => c[0].event);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#1505 trigger mode: every delivery channel off', () => {
  it('writes the notifications record and nothing that would deliver', async () => {
    const ctx = buildDbMock({ docs: allOffPrefs(), writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: { bookingId: 'b1' } });

    expect(outcome.written).toHaveLength(1);
    expect(outcome.suppressed).toEqual([]);
    // #1507: the outcome names the recipient whose record is the whole delivery.
    expect(outcome.appOnly).toEqual(['kinUid']);
    expect(reachedAppOnly(outcome)).toBe(true);
    expect(reachedAppOnly(outcome, 'kinUid')).toBe(true);

    const record = records(ctx.writes);
    expect(record).toHaveLength(1);
    expect(record[0].path).toBe(`notifications/${outcome.written[0]}`);
    expect(record[0].data).toMatchObject({ key: KEY, recipientUid: 'kinUid', title: 'Your Auntie is on the way' });
    // The record's shape is the one every other path writes: no pipeline fields.
    expect(record[0].data.channels).toBeUndefined();
    expect(record[0].data.status).toBeUndefined();

    // No work order: nothing for the fan-out to pick up, so no email, SMS or push.
    expect(workOrders(ctx.writes)).toEqual([]);
    expect(ctx.writes.some((w) => w.path.includes('/channels/'))).toBe(false);

    expect(events()).toContain('notification.record-only');
    expect(events()).not.toContain('notification.suppressed');
  });

  it('GATE OFF: writes nothing at all, record included', async () => {
    const ctx = buildDbMock({
      docs: { ...allOffPrefs(), [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: { bookingId: 'b1' } });

    expect(outcome.written).toEqual([]);
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
    // #1507: nothing written, so nothing reached them in the app either.
    expect(outcome.appOnly).toEqual([]);
    expect(reachedAppOnly(outcome)).toBe(false);
    expect(ctx.writes.map((w) => w.path), 'no record, no work order, no dedupe ledger').toEqual([]);
    expect(events()).toContain('notification.gated.household');
  });

  it('a channel on: record AND work order, exactly as before', async () => {
    // No prefs doc, so the catalog default applies: email on.
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: { bookingId: 'b1' } });

    expect(outcome.written).toHaveLength(1);
    expect(records(ctx.writes)).toHaveLength(1);
    const orders = workOrders(ctx.writes);
    expect(orders).toHaveLength(1);
    expect(orders[0].path).toBe(`notificationDispatch/${outcome.written[0]}`);
    expect(orders[0].data).toMatchObject({ channels: ['email'], status: 'pending', mode: 'trigger' });
    expect(events()).not.toContain('notification.record-only');
    // #1507: a channel carried it, so it is not app-only.
    expect(outcome.appOnly).toEqual([]);
    expect(reachedAppOnly(outcome)).toBe(false);
    expect(reachedAppOnly(outcome, 'kinUid')).toBe(false);
  });

  it('OPERATOR DISABLED: still nothing written, still reported as prefs', async () => {
    // The admin matrix turned the whole notification off (#7, warn-but-allow-off).
    // That is a decision about the notification, not about a channel, so the
    // record is not written either.
    const ctx = buildDbMock({
      docs: { 'businessSettings/notifications': { byKey: { [KEY]: { enabled: false } } } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: { bookingId: 'b1' } });

    expect(outcome.written).toEqual([]);
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'prefs' }]);
    expect(ctx.writes).toEqual([]);
    const suppressed = mocks.logEventFn.mock.calls.map((c) => c[0]).find((f) => f.event === 'notification.suppressed');
    expect(suppressed?.extra).toMatchObject({ reason: 'disabled-by-operator' });
  });

  it('MARKETING without opt-in: nothing written, the legal gate is not a channel pref', async () => {
    const marketingKey = getNotificationDef('newsletter.announcement').key;
    const ctx = buildDbMock({ writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({ key: marketingKey, recipientUid: 'kinUid', data: {} });

    expect(outcome.written).toEqual([]);
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'prefs' }]);
    expect(records(ctx.writes)).toEqual([]);
  });

  it('dedupe: a retry inside the window writes a second record no more than it writes a second email', async () => {
    const ctx = buildDbMock({ docs: allOffPrefs(), writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const args = { key: KEY, recipientUid: 'kinUid', data: { bookingId: 'b1' } };

    const first = await enqueueNotificationDetailed(args);
    vi.setSystemTime(BASE_MS + 30_000);
    const second = await enqueueNotificationDetailed(args);

    expect(first.written).toHaveLength(1);
    expect(second.written).toEqual([]);
    expect(second.suppressed).toEqual([
      { recipientUid: 'kinUid', reason: 'duplicate', existingId: first.written[0], lastAtMs: BASE_MS },
    ]);
    // #1507: only the attempt that wrote the record reports it as app-only.
    expect(first.appOnly).toEqual(['kinUid']);
    expect(second.appOnly).toEqual([]);
    expect(records(ctx.writes)).toHaveLength(1);
    expect(ledger(ctx.writes)).toHaveLength(1);
    expect(workOrders(ctx.writes)).toEqual([]);
  });

  it('a both-audience key: the kinfolk copy is record-only, the admin copy still delivers', async () => {
    // `invoice.updated`: kinfolkAcct + businessAdmins, trigger mode, `required: {}`.
    // (Not `kincare.booking.confirm`: that one has catalog-required email, which
    // `resolveChannels` puts above the recipient's own prefs, so its kinfolk copy
    // delivers whatever the prefs say.)
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1'] },
        ...allOffPrefs('invoice.updated'),
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.updated',
      recipientUid: 'kinUid',
      data: { invoiceId: 'inv1', kinfolkId: 'kf1' },
    });

    expect(outcome.written).toHaveLength(2);
    expect(records(ctx.writes).map((w) => w.data.recipientUid).sort()).toEqual(['admin1', 'kinUid']);
    const orders = workOrders(ctx.writes);
    expect(orders).toHaveLength(1);
    expect(orders[0].data.recipientUid).toBe('admin1');
    // #1507: the household's copy is app-only; the admin's is not, and the
    // admin's email must not answer for the household. Asked per recipient the
    // helper tells them apart; asked for the whole call it says no, because one
    // copy did deliver.
    expect(outcome.appOnly).toEqual(['kinUid']);
    expect(reachedAppOnly(outcome, 'kinUid')).toBe(true);
    expect(reachedAppOnly(outcome, 'admin1')).toBe(false);
    expect(reachedAppOnly(outcome)).toBe(false);
  });
});

describe('#1507 reachedAppOnly on a hand-built outcome', () => {
  it('an outcome without the field (an older mock, or a pre-#1507 caller) is never app-only', () => {
    expect(reachedAppOnly({ written: ['n1'], suppressed: [], unresolved: [] })).toBe(false);
    expect(reachedAppOnly({ written: ['n1'], suppressed: [], unresolved: [] }, 'kinUid')).toBe(false);
  });

  it('a blank recipient asks about the whole call, as a caller with an unresolved uid does', () => {
    const outcome = { written: ['n1'], suppressed: [], unresolved: [], appOnly: ['someone'] };
    expect(reachedAppOnly(outcome, '')).toBe(true);
  });
});

describe('#1511 householdAppOnly: the optional answer for a both-audience send', () => {
  const base = { written: ['n1', 'n2'], suppressed: [], unresolved: [] };

  it('answers for the household alone: the office copy having no channels is not theirs', () => {
    expect(householdAppOnly({ ...base, appOnly: ['kinUid'] }, 'kinUid')).toBe(true);
    expect(householdAppOnly({ ...base, appOnly: ['admin1'] }, 'kinUid')).toBe(false);
    expect(householdAppOnly(base, 'kinUid')).toBe(false);
  });

  it('is undefined with no household uid, however the office copy went', () => {
    expect(householdAppOnly({ ...base, appOnly: ['admin1'] }, null)).toBeUndefined();
    expect(householdAppOnly({ ...base, appOnly: ['admin1'] }, '')).toBeUndefined();
  });

  it('is undefined when the household copy was held back, whatever the reason', () => {
    for (const reason of ['duplicate', 'prefs', 'gate'] as const) {
      const outcome = { ...base, suppressed: [{ recipientUid: 'kinUid', reason }], appOnly: [] };
      expect(householdAppOnly(outcome, 'kinUid'), reason).toBeUndefined();
    }
  });
});

describe('#1505 queued modes mirror the rule', () => {
  it('debounced, every channel off: the queue row is written with no channels', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['admin1'] }, ...allOffPrefs('pets.updated') },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'pets.updated',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', kinId: 'k1' },
    });

    expect(outcome.written).toHaveLength(2);
    // #1507: the channels are frozen into the queue row at enqueue time, so the
    // queued modes answer app-only here and now, not at promotion.
    expect(outcome.appOnly).toEqual(['kinUid']);
    const rows = queued(ctx.writes);
    const kinRow = rows.find((w) => w.data.recipientUid === 'kinUid');
    const adminRow = rows.find((w) => w.data.recipientUid === 'admin1');
    expect(kinRow?.data).toMatchObject({ channels: [], status: 'pending', mode: 'debounced' });
    expect(adminRow?.data).toMatchObject({ channels: ['email'] });
  });

  it('debounced, GATE OFF: the kinfolk row is not queued; the admin row is', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/admins': { uids: ['admin1'] },
        ...allOffPrefs('pets.updated'),
        [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outcome = await enqueueNotificationDetailed({
      key: 'pets.updated',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'kf1', kinId: 'k1' },
    });

    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
    expect(queued(ctx.writes).map((w) => w.data.recipientUid)).toEqual(['admin1']);
  });

  it('promotion of a channel-less row writes the record and no work order', () => {
    const writes: Write[] = [];
    let auto = 0;
    const db: any = {
      collection: (name: string) => ({
        doc: (id?: string) => {
          if (!id) auto += 1;
          return { id: id ?? `auto-${auto}`, path: `${name}/${id ?? `auto-${auto}`}` };
        },
      }),
    };
    const tx = { set: (ref: { path: string }, data: Record<string, unknown>) => writes.push({ path: ref.path, data }) } as any;
    mocks.dbFn.mockReturnValue(db);

    const id = promoteQueuedNotification(
      tx,
      { key: 'pets.updated', category: 'home', recipientUid: 'kinUid', title: 'Pets updated or added', channels: [] },
      { mode: 'debounced-promoted', origin: { originPendingId: 'kinUid_pets.updated' } },
    );

    expect(records(writes)).toHaveLength(1);
    expect(records(writes)[0].path).toBe(`notifications/${id}`);
    expect(records(writes)[0].data).toMatchObject({ key: 'pets.updated', recipientUid: 'kinUid' });
    expect(workOrders(writes)).toEqual([]);
  });

  it('promotion of a row with a channel still writes both documents', () => {
    const writes: Write[] = [];
    const db: any = {
      collection: (name: string) => ({ doc: (id?: string) => ({ id: id ?? 'auto-1', path: `${name}/${id ?? 'auto-1'}` }) }),
    };
    const tx = { set: (ref: { path: string }, data: Record<string, unknown>) => writes.push({ path: ref.path, data }) } as any;
    mocks.dbFn.mockReturnValue(db);

    promoteQueuedNotification(tx, { key: 'pets.updated', recipientUid: 'kinUid', channels: ['email'] }, { mode: 'debounced-promoted' });

    expect(records(writes)).toHaveLength(1);
    expect(workOrders(writes)).toHaveLength(1);
    expect(workOrders(writes)[0].data).toMatchObject({ channels: ['email'], status: 'pending' });
  });
});

describe('notificationDisabledFor: the two reasons that still write nothing', () => {
  const def = getNotificationDef(KEY);

  it('is null for a recipient who only turned channels off', () => {
    expect(notificationDisabledFor(def, { byKey: { [KEY]: ALL_OFF } }, null, 'kinfolk')).toBeNull();
    expect(notificationDisabledFor(def, {}, { enabled: true, channels: { email: false, sms: false, push: false } }, 'kinfolk')).toBeNull();
  });

  it('names the operator when the override disables the notification on this stream', () => {
    const kinfolkOff = { enabled: true, channels: {}, streams: { kinfolk: { enabled: false } } };
    expect(notificationDisabledFor(def, {}, { enabled: false, channels: {} }, 'kinfolk')).toBe('operator');
    expect(notificationDisabledFor(def, {}, kinfolkOff, 'kinfolk')).toBe('operator');
    expect(notificationDisabledFor(def, {}, kinfolkOff, 'business')).toBeNull();
  });

  it('names marketing when the key needs an opt-in the recipient never gave', () => {
    const marketing = getNotificationDef('newsletter.announcement');
    expect(notificationDisabledFor(marketing, {}, null, 'kinfolk')).toBe('marketing');
    expect(
      notificationDisabledFor(marketing, { marketingOptIn: { [marketing.marketingCategory!]: true } }, null, 'kinfolk'),
    ).toBeNull();
  });
});
/**
 * #1973: `listOnlyFor` makes one recipient's copy of one send a list record
 * only, whatever their own settings say. `recordPayment` uses it for an
 * unticked payment that pays an invoice off.
 */
describe('#1973 listOnlyFor: a notifications-list record only, for this send', () => {
  const ALL_ON = { email: true, sms: true, push: true };
  it('writes the record and no work order, even with every channel on in their settings', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/kinUid': { notificationPrefs: { byKey: { [KEY]: ALL_ON } } } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const outcome = await enqueueNotificationDetailed({
      key: KEY,
      recipientUid: 'kinUid',
      data: { bookingId: 'b1' },
      listOnlyFor: ['kinUid'],
    });
    expect(outcome.written).toHaveLength(1);
    expect(outcome.appOnly).toEqual(['kinUid']);
    expect(records(ctx.writes)).toHaveLength(1);
    expect(workOrders(ctx.writes)).toEqual([]);
  });
  it('leaves every other recipient, and every other send, alone', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/kinUid': { notificationPrefs: { byKey: { [KEY]: ALL_ON } } } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: { bookingId: 'b2' }, listOnlyFor: ['someoneElse'] });
    expect(workOrders(ctx.writes)).toHaveLength(1);
  });
  it('still stops at the household send gate', async () => {
    const ctx = buildDbMock({
      docs: { [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const outcome = await enqueueNotificationDetailed({
      key: KEY,
      recipientUid: 'kinUid',
      data: { bookingId: 'b3' },
      listOnlyFor: ['kinUid'],
    });
    expect(outcome.written).toEqual([]);
    expect(records(ctx.writes)).toEqual([]);
  });
});
