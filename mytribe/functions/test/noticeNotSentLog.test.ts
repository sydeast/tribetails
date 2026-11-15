import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import { DEDUPE_COLLECTION, enqueueNotificationDetailed } from '../src/notifications/dispatcher';
import { channelsSwitchedOffByRecipient, resolveChannels } from '../src/notifications/prefs';
import { getNotificationDef } from '../src/notifications/catalog';
import {
  noticeLineId,
  noticeNotSentWords,
  noticeRecipientWords,
  noticeStream,
  recordNoticeNotSent,
} from '../src/notifications/noticeAudit';
import { onNotificationDispatchCreateHandler } from '../src/notifications/triggers/onNotificationCreate';

/**
 * #1819, #1905: THE ACTIVITY LOG SAYS WHAT HAPPENED TO A HOUSEHOLD'S NOTICE.
 *
 * Driven through the real dispatcher and the real `writeAuditEntry`, against
 * the in-memory Firestore, so each case reads the `activity_log` document a
 * client would list: its key, its status, and the sentence on the row.
 *
 *   #1819  a clock tap with household notices off wrote "Notification
 *          dispatched", status SUCCESS, and the reason only as a stored key.
 *   #1905  a payment notice with the household's Email switch off wrote
 *          "Sent ... by email" (the office's copy) and nothing for the household.
 */
const VISIT_KEY = 'kincare.auntie.on_my_way';
const PAYMENT_KEY = 'invoice.payment.applied';
const BASE_MS = Date.UTC(2026, 10, 10, 19, 7, 0);

type Write = { path: string; data: Record<string, unknown> };
const logLines = (writes: Write[]) => writes.filter((w) => w.path.startsWith('activity_log/')).map((w) => w.data);
const workOrders = (writes: Write[]) => writes.filter((w) => w.path.startsWith('notificationDispatch/'));
const records = (writes: Write[]) => writes.filter((w) => w.path.startsWith('notifications/'));
const ledger = (writes: Write[]) => writes.filter((w) => w.path.startsWith(`${DEDUPE_COLLECTION}/`));

const HOUSEHOLD = { 'clients/kinUid': { displayName: 'Dre East', email: 'catch@hanasamku.com' } };
const GATE_OFF = { [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } };

function db(docs: Record<string, Record<string, unknown> | null> = {}, queryDocs: Record<string, unknown[]> = {}) {
  const ctx = buildDbMock({ docs: { ...HOUSEHOLD, ...docs }, queryDocs, writeThrough: true } as never);
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#1819 a notice the send switch held back', () => {
  it('writes "not sent" with the reason in words, never "dispatched" and never SUCCESS', async () => {
    const ctx = db(GATE_OFF);
    await enqueueNotificationDetailed({
      key: VISIT_KEY,
      recipientUid: 'kinUid',
      data: { familyId: 'fam1', visitId: 'visit1' },
      dedupeKey: 'visit:visit1:on_my_way#a',
    });

    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actionType: 'NOTIFICATION_NOT_SENT',
      status: 'NOT_SENT',
      severity: 'info',
      actorRole: 'SYSTEM',
      familyId: 'fam1',
      description: 'Held back "Your Auntie is on the way" for Dre East: notices to households are turned off',
      payload: { key: VISIT_KEY, outcome: 'held', channels: [], recipientUid: 'kinUid' },
    });
    // The position argument in the dispatcher is untouched: no record, no work order, no ledger.
    expect(records(ctx.writes)).toEqual([]);
    expect(workOrders(ctx.writes)).toEqual([]);
    expect(ledger(ctx.writes)).toEqual([]);
  });

  it('the sentence carries no id, no stored key and no address', async () => {
    const ctx = db(GATE_OFF);
    await enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: { familyId: 'fam1', visitId: 'visit1' } });
    const sentence = String(logLines(ctx.writes)[0]?.description);
    expect(sentence).not.toMatch(/kinUid|fam1|visit1|household_notices_off|kincare\.|@|uid=/);
  });

  it('the same step reached twice writes the line once; a different step writes its own', async () => {
    const ctx = db(GATE_OFF);
    const tap = (dedupeKey: string) =>
      enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: { familyId: 'fam1', visitId: 'visit1' }, dedupeKey });
    await tap('visit:visit1:on_my_way#a');
    await tap('visit:visit1:on_my_way#a');
    expect(logLines(ctx.writes)).toHaveLength(1);
    await tap('visit:visit1:on_my_way#b');
    expect(logLines(ctx.writes)).toHaveLength(2);
  });

  // #2331: the timed jobs themselves now write one line per run (`heldNoticeSummary.test.ts`).
  it('the same notice held again with no run count writes its line once a day, not once a call', async () => {
    const ctx = db(GATE_OFF);
    const run = () =>
      enqueueNotificationDetailed({ key: 'invoice.overdue', recipientUid: 'kinUid', data: { invoiceId: 'inv1', kinfolkId: 'fam1' } });
    await run();
    await run();
    expect(logLines(ctx.writes)).toHaveLength(1);
    vi.setSystemTime(BASE_MS + 24 * 60 * 60 * 1000);
    await run();
    expect(logLines(ctx.writes)).toHaveLength(2);
  });

  it('a person with no name on file reads as the household name, then "the household", never the id', async () => {
    const named = db({ ...GATE_OFF, 'clients/kinUid': {}, 'kinfolk/fam1': { kinfolkName: 'The Rivera Home' } });
    await enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: { familyId: 'fam1' } });
    expect(logLines(named.writes)[0]?.description).toBe(
      'Held back "Your Auntie is on the way" for The Rivera Home: notices to households are turned off',
    );

    const nameless = db({ ...GATE_OFF, 'clients/kinUid': { displayName: 'catch@hanasamku.com' } });
    await enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: {} });
    expect(logLines(nameless.writes)[0]?.description).toBe(
      'Held back "Your Auntie is on the way" for the household: notices to households are turned off',
    );
  });

  it('gate on: a notice that goes out writes no "not sent" line', async () => {
    const ctx = db();
    const outcome = await enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: { familyId: 'fam1' } });
    expect(outcome.written).toHaveLength(1);
    expect(workOrders(ctx.writes)).toHaveLength(1);
    expect(logLines(ctx.writes)).toEqual([]);
  });

  it('the notification switched off in Settings is named for that, and a marketing opt-out writes no line', async () => {
    const off = db({ 'businessSettings/notifications': { byKey: { [VISIT_KEY]: { enabled: false } } } });
    await enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: { familyId: 'fam1' } });
    expect(logLines(off.writes)).toEqual([
      expect.objectContaining({
        actionType: 'NOTIFICATION_NOT_SENT',
        status: 'NOT_SENT',
        description: 'Did not send "Your Auntie is on the way" to Dre East: this notification is turned off in Settings',
      }),
    ]);

    const marketing = db();
    const outcome = await enqueueNotificationDetailed({ key: 'newsletter.announcement', recipientUid: 'kinUid', data: {} });
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'prefs' }]);
    expect(logLines(marketing.writes)).toEqual([]);
  });

  it('a line that cannot be written never fails the dispatch', async () => {
    const ctx = db(GATE_OFF);
    (ctx.db as unknown as { runTransaction: unknown }).runTransaction = async () => {
      throw new Error('chain head contention');
    };
    const outcome = await enqueueNotificationDetailed({ key: VISIT_KEY, recipientUid: 'kinUid', data: { familyId: 'fam1' } });
    expect(outcome.suppressed).toEqual([{ recipientUid: 'kinUid', reason: 'gate', gateState: 'off' }]);
    expect(mocks.logEventFn.mock.calls.map((c) => c[0].event)).toContain('notification.not_sent.audit_failed');
  });
});

describe('#1905 a channel the household switched off', () => {
  /** The portal's category switch: Invoices & Payments, Email off. */
  const EMAIL_OFF = { 'clients/kinUid': { displayName: 'Dre East', notificationPrefs: { byCategory: { invoice: { email: false } } } } };

  it('the household copy goes to their notifications list, sends no email, and the log says so', async () => {
    const ctx = db(EMAIL_OFF);
    const outcome = await enqueueNotificationDetailed({
      key: PAYMENT_KEY,
      recipientUid: 'kinUid',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    });

    // The record is written (the notifications list), and nothing is queued to send to them.
    expect(outcome.appOnly).toContain('kinUid');
    const household = records(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid');
    expect(household).toHaveLength(1);
    expect(workOrders(ctx.writes).filter((w) => w.data.recipientUid === 'kinUid')).toEqual([]);

    expect(logLines(ctx.writes)).toEqual([
      expect.objectContaining({
        actionType: 'NOTIFICATION_NOT_SENT',
        status: 'NOT_SENT',
        familyId: 'fam1',
        targetCollection: 'notifications',
        targetId: household[0]!.path.split('/')[1],
        description:
          'Did not send "Payment or credit applied to an invoice" to Dre East by email: they turned that off in their notification settings',
        payload: expect.objectContaining({ outcome: 'channels_off', channels: ['email'] }),
      }),
    ]);
  });

  it('push, off by default and never chosen, is not blamed on the household', async () => {
    const def = getNotificationDef(PAYMENT_KEY);
    expect(resolveChannels(def, {}, null, 'kinfolk')).toEqual({ email: true, sms: false, push: false });
    expect(channelsSwitchedOffByRecipient(def, {}, null, 'kinfolk')).toEqual([]);

    const ctx = db();
    await enqueueNotificationDetailed({ key: PAYMENT_KEY, recipientUid: 'kinUid', data: { invoiceId: 'inv1', kinfolkId: 'fam1' } });
    expect(logLines(ctx.writes)).toEqual([]);
  });

  it('names each channel they switched off, by key or by category, and only those', () => {
    const def = getNotificationDef(PAYMENT_KEY);
    expect(channelsSwitchedOffByRecipient(def, { byCategory: { invoice: { email: false } } }, null, 'kinfolk')).toEqual([
      'email',
    ]);
    expect(channelsSwitchedOffByRecipient(def, { byKey: { [PAYMENT_KEY]: { email: false } } }, null, 'kinfolk')).toEqual([
      'email',
    ]);
    // Their per-notification choice wins over the category, as it does in the send.
    expect(
      channelsSwitchedOffByRecipient(
        def,
        { byKey: { [PAYMENT_KEY]: { email: true } }, byCategory: { invoice: { email: false } } },
        null,
        'kinfolk',
      ),
    ).toEqual([]);
    // Text message and push start off. A saved "off" for one changed nothing, so it is not named.
    expect(
      channelsSwitchedOffByRecipient(def, { byCategory: { invoice: { sms: false, push: false } } }, null, 'kinfolk'),
    ).toEqual([]);
    // A channel they turned ON is not one they turned off.
    expect(
      channelsSwitchedOffByRecipient(def, { byCategory: { invoice: { email: false, push: true } } }, null, 'kinfolk'),
    ).toEqual(['email']);
    // An unlocked owner "on" for push does not turn it on for anyone, so their "off" changed nothing either.
    expect(
      channelsSwitchedOffByRecipient(
        def,
        { byCategory: { invoice: { push: false } } },
        { enabled: true, channels: { push: true } },
        'kinfolk',
      ),
    ).toEqual([]);
  });

  it('a channel the owner turned off or locked is the owner\'s doing, not the household\'s', () => {
    const def = getNotificationDef(PAYMENT_KEY);
    const theirs = { byCategory: { invoice: { email: false } } };
    expect(channelsSwitchedOffByRecipient(def, theirs, { enabled: true, channels: { email: false } }, 'kinfolk')).toEqual([]);
    expect(
      channelsSwitchedOffByRecipient(def, theirs, { enabled: true, channels: {}, locked: { email: true } }, 'kinfolk'),
    ).toEqual([]);
    expect(channelsSwitchedOffByRecipient(def, theirs, { enabled: false, channels: {} }, 'kinfolk')).toEqual([]);
  });

  it('with the send switch off too, the one line is "held back", not a channel line', async () => {
    const ctx = db({ ...EMAIL_OFF, ...GATE_OFF });
    await enqueueNotificationDetailed({ key: PAYMENT_KEY, recipientUid: 'kinUid', data: { invoiceId: 'inv1', kinfolkId: 'fam1' } });
    expect(logLines(ctx.writes).map((l) => (l.payload as { outcome: string }).outcome)).toEqual(['held']);
  });
});

describe('#1905 the line for a copy handed to its channels names who it is for', () => {
  function workOrder(data: Record<string, unknown>) {
    const batch = { set: vi.fn(), update: vi.fn(), commit: vi.fn(async () => {}) };
    const ref = { id: 'notif1', set: vi.fn(async () => {}), collection: () => ({ doc: (id: string) => ({ id }) }) };
    return { event: { data: { data: () => ({ status: 'pending', ...data }), ref } }, batch };
  }

  async function sendingLine(data: Record<string, unknown>, docs: Record<string, Record<string, unknown>> = {}) {
    const ctx = db(docs);
    const { event, batch } = workOrder(data);
    (ctx.db as unknown as { batch: unknown }).batch = () => batch;
    await onNotificationDispatchCreateHandler(event);
    return logLines(ctx.writes);
  }

  it('the office copy says "to the office"; the household copy says the person', async () => {
    const office = await sendingLine({
      notificationId: 'notif1',
      key: PAYMENT_KEY,
      recipientUid: 'adminUid',
      channels: ['email'],
      mode: 'trigger',
      stream: 'business',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    });
    expect(office).toEqual([
      expect.objectContaining({
        actionType: 'NOTIFICATION_DISPATCHED',
        status: 'SUCCESS',
        familyId: 'fam1',
        description: 'Sending "Payment or credit applied to an invoice" to the office by email',
      }),
    ]);

    const household = await sendingLine({
      notificationId: 'notif2',
      key: PAYMENT_KEY,
      recipientUid: 'kinUid',
      channels: ['email', 'push'],
      mode: 'trigger',
      stream: 'kinfolk',
      data: { invoiceId: 'inv1', kinfolkId: 'fam1' },
    });
    expect(household[0]?.description).toBe(
      'Sending "Payment or credit applied to an invoice" to Dre East by email and push notification',
    );
  });

  it('a staff copy names the staff member, and a work order with no audience names nobody', async () => {
    const staff = await sendingLine(
      { key: 'kincare.note.auntie', recipientUid: 'auntieUid', channels: ['email'], stream: 'staff', data: {} },
      { 'staff/auntieUid': { displayName: 'TiTi' } },
    );
    expect(String(staff[0]?.description)).toMatch(/ to TiTi by email$/);

    const old = await sendingLine({ key: PAYMENT_KEY, recipientUid: 'kinUid', channels: ['email'], data: {} });
    expect(old[0]?.description).toBe('Sending "Payment or credit applied to an invoice" by email');
  });

  it('a work order with no channels writes no line', async () => {
    expect(await sendingLine({ key: PAYMENT_KEY, recipientUid: 'kinUid', channels: [], stream: 'kinfolk' })).toEqual([]);
  });
});

describe('the writer', () => {
  it('reads an audience only from the three it knows', () => {
    expect(noticeStream('kinfolk')).toBe('kinfolk');
    expect(noticeStream('business')).toBe('business');
    expect(noticeStream('staff')).toBe('staff');
    expect(noticeStream('household')).toBeNull();
    expect(noticeStream(undefined)).toBeNull();
  });

  it('names a recipient without ever reading an id or an address aloud', async () => {
    db({ 'clients/a': { firstName: 'Dre', lastName: 'East' }, 'clients/b': { displayName: 'pawsome@hanasamku.com' } });
    expect(await noticeRecipientWords('kinfolk', 'a')).toBe('Dre East');
    expect(await noticeRecipientWords('kinfolk', 'b')).toBe('the household');
    expect(await noticeRecipientWords('kinfolk', '')).toBe('the household');
    expect(await noticeRecipientWords('staff', 'nobody')).toBe('your team');
    expect(await noticeRecipientWords('business', 'adminUid')).toBe('the office');
    expect(await noticeRecipientWords(null, 'a')).toBe('');
  });

  it('an unreadable name is "the household", not a thrown send', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => {
        throw new Error('unavailable');
      },
    });
    expect(await noticeRecipientWords('kinfolk', 'a', 'fam1')).toBe('the household');
    expect(await noticeRecipientWords('staff', 'a')).toBe('your team');
  });

  it('every outcome has a sentence', () => {
    const words = (outcome: Parameters<typeof noticeNotSentWords>[0]['outcome'], channels: Array<'email' | 'sms' | 'push'> = []) =>
      noticeNotSentWords({ key: PAYMENT_KEY, outcome, channels, skipReason: 'recipient_no_email' }, 'Dre East');
    expect(words('held')).toMatch(/^Held back .* for Dre East: notices to households are turned off$/);
    expect(words('turned_off')).toMatch(/turned off in Settings$/);
    expect(words('channels_off', ['email'])).toMatch(/by email: they turned that off in their notification settings$/);
    expect(words('no_account')).toMatch(/nobody in the household has a MyTribe sign-in$/);
    expect(words('no_address', ['email'])).toMatch(/by email: no email address on file$/);
    expect(words('failed', ['push'])).toMatch(/by push notification: the send failed$/);
  });

  it('a failed send is FAILURE; everything else is NOT_SENT', async () => {
    const ctx = db();
    await recordNoticeNotSent({ key: PAYMENT_KEY, outcome: 'failed', recipientUid: 'kinUid', stream: 'kinfolk', channels: ['email'] });
    await recordNoticeNotSent({ key: PAYMENT_KEY, outcome: 'no_address', recipientUid: 'kinUid', stream: 'kinfolk', channels: ['sms'], skipReason: 'recipient_no_phone' });
    await recordNoticeNotSent({ key: PAYMENT_KEY, outcome: 'no_account', recipientUid: '', stream: 'kinfolk', familyId: 'fam1' });
    expect(logLines(ctx.writes).map((l) => [l.status, l.severity])).toEqual([
      ['FAILURE', 'warn'],
      ['NOT_SENT', 'warn'],
      ['NOT_SENT', 'info'],
    ]);
  });

  it('a fixed id is stable for the same parts and differs by outcome and channel', () => {
    expect(noticeLineId('failed', 'n1', 'email')).toBe(noticeLineId('failed', 'n1', 'email'));
    expect(noticeLineId('failed', 'n1', 'email')).not.toBe(noticeLineId('failed', 'n1', 'sms'));
    expect(noticeLineId('failed', 'n1', 'email')).not.toBe(noticeLineId('no_address', 'n1', 'email'));
    expect(noticeLineId('held', 'a/b', 'c')).toMatch(/^noticenotsent__[0-9a-f]{40}$/);
  });
});
