import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { DEDUPE_COLLECTION, deliverListedCopy, enqueueNotificationDetailed } from '../src/notifications/dispatcher';

/**
 * #2281 review: `deliverListedCopy` SENDS A LIST-ONLY COPY ON THE RECIPIENT'S
 * OWN CHANNELS, WITHOUT A SECOND RECORD AND WITHOUT TELLING ANYONE ELSE.
 *
 * The case it exists for: an older admin build pays an invoice off and stops.
 * The settlement sweep lists the payoff for the household (`listOnlyFor`,
 * nothing emailed) and tells the office. The admin then presses Record again
 * with Send Confirmation ticked. Enqueueing the notice again cannot email it:
 * the dispatcher's own ledger, run for real here, refuses the household's copy
 * as a duplicate. This attaches the missing work order to the record the sweep
 * wrote.
 */
const KEY = 'invoice.payment.applied';
const BASE_MS = Date.UTC(2026, 10, 14, 15, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DATA = { kinfolkId: 'fam1', invoiceId: 'inv1', paymentId: 'settle_ipay_1' };
const OFFICE = { 'businessSettings/admins': { uids: ['office1'] } };

type Write = { path: string; data: Record<string, unknown> };
const records = (writes: Write[]) => writes.filter((w) => /^notifications\/[^/]+$/.test(w.path));
const workOrders = (writes: Write[]) => writes.filter((w) => /^notificationDispatch\/[^/]+$/.test(w.path));
const ledger = (writes: Write[]) => writes.filter((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`));

function setup(extra: Record<string, Record<string, unknown>> = {}) {
  const docs: Record<string, Record<string, unknown>> = { ...OFFICE, ...extra };
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ...ctx, docs };
}

/** The sweep's send: the household's list only, and the office. */
const listOnly = () =>
  enqueueNotificationDetailed({
    key: KEY,
    recipientUid: 'kinUid',
    data: DATA,
    dedupeWindowMs: WEEK_MS,
    listOnlyFor: ['kinUid'],
  });
const deliver = (over: Record<string, unknown> = {}) =>
  deliverListedCopy({ key: KEY, recipientUid: 'kinUid', data: DATA, ...over });

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2281 review: a list-only copy the admin then asks to have sent', () => {
  it('enqueueing it again is refused as a duplicate, for the household and the office', async () => {
    const ctx = setup();
    const first = await listOnly();
    expect(first.written).toHaveLength(2);
    expect(first.appOnly).toEqual(['kinUid']);
    // The household's copy has no work order; the office's has.
    expect(workOrders(ctx.writes).map((w) => w.data.recipientUid)).toEqual(['office1']);

    vi.setSystemTime(BASE_MS + 20 * 60 * 1000);
    const again = await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: DATA, dedupeWindowMs: WEEK_MS });
    expect(again.written).toEqual([]);
    expect(again.suppressed.map((s) => [s.recipientUid, s.reason])).toEqual([
      ['kinUid', 'duplicate'],
      ['office1', 'duplicate'],
    ]);
    expect(records(ctx.writes)).toHaveLength(2);
    expect(workOrders(ctx.writes)).toHaveLength(1);
  });

  it('sends the listed copy by email: one work order on the same record, no new record, nothing for the office', async () => {
    const ctx = setup();
    await listOnly();
    const householdRecord = records(ctx.writes).find((w) => w.data.recipientUid === 'kinUid')!;
    const before = { records: records(ctx.writes).length, ledger: ledger(ctx.writes).length };

    vi.setSystemTime(BASE_MS + 20 * 60 * 1000);
    expect(await deliver()).toEqual({ outcome: 'sent', channels: ['email'] });

    const household = workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid');
    expect(household).toHaveLength(1);
    expect(household[0]!.path).toBe(`notificationDispatch/${householdRecord.path.split('/')[1]}`);
    expect(household[0]!.data).toMatchObject({
      notificationId: householdRecord.path.split('/')[1],
      key: KEY,
      recipientUid: 'kinUid',
      mode: 'trigger',
      channels: ['email'],
      status: 'pending',
      data: DATA,
    });
    // No second list entry, no ledger write, and the office hears nothing more.
    expect(records(ctx.writes)).toHaveLength(before.records);
    expect(ledger(ctx.writes)).toHaveLength(before.ledger);
    expect(workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'office1')).toHaveLength(1);
  });

  it('never sends it twice', async () => {
    const ctx = setup();
    await listOnly();
    expect((await deliver()).outcome).toBe('sent');
    expect(await deliver()).toEqual({ outcome: 'already', channels: [] });
    expect(workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid')).toHaveLength(1);
  });

  it('a copy that already went out on a channel is left alone', async () => {
    const ctx = setup();
    // An ordinary ticked send: record and work order together.
    await enqueueNotificationDetailed({ key: KEY, recipientUid: 'kinUid', data: DATA, dedupeWindowMs: WEEK_MS });
    const orders = workOrders(ctx.writes).length;
    expect(await deliver()).toEqual({ outcome: 'already', channels: [] });
    expect(workOrders(ctx.writes)).toHaveLength(orders);
  });

  it('honours the household\'s own settings: every channel off sends nothing', async () => {
    const ctx = setup({
      'clients/kinUid': { notificationPrefs: { byKey: { [KEY]: { email: false, sms: false, push: false } } } },
    });
    await listOnly();
    expect(await deliver()).toEqual({ outcome: 'no-channels', channels: [] });
    expect(workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid')).toEqual([]);
  });

  it('a notification the operator switched off sends nothing', async () => {
    const ctx = setup();
    await listOnly();
    ctx.docs['businessSettings/notifications'] = { byKey: { [KEY]: { enabled: false } } };
    expect((await deliver()).outcome).toBe('off');
    expect(workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid')).toEqual([]);
  });

  it('stops at the household send gate', async () => {
    const ctx = setup();
    await listOnly();
    ctx.docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { householdNotificationsLive: false };
    expect((await deliver()).outcome).toBe('gated');
    expect(workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid')).toEqual([]);
  });

  it('with no earlier copy on record there is nothing to send, and nothing is written', async () => {
    const ctx = setup();
    expect(await deliver()).toEqual({ outcome: 'no-record', channels: [] });
    // A different payment's copy is not this one's.
    await listOnly();
    const writes = ctx.writes.length;
    expect((await deliver({ data: { ...DATA, paymentId: 'settle_ipay_2' } })).outcome).toBe('no-record');
    // Nor is another member's.
    expect((await deliverListedCopy({ key: KEY, recipientUid: 'otherUid', data: DATA })).outcome).toBe('no-record');
    expect(ctx.writes).toHaveLength(writes);
  });
});
