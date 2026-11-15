import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn(), perCopyLine: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
// The real writer, watched: `perCopyLine` records every per-copy line asked for.
vi.mock('../src/notifications/noticeAudit', async (original) => {
  const actual = await original<typeof import('../src/notifications/noticeAudit')>();
  return {
    ...actual,
    recordNoticeNotSent: async (input: Parameters<typeof actual.recordNoticeNotSent>[0]) => {
      mocks.perCopyLine(input);
      return actual.recordNoticeNotSent(input);
    },
  };
});

import { enqueueNotificationDetailed } from '../src/notifications/dispatcher';
import {
  countHeldNotice,
  hourWindow,
  startHeldNoticeBatch,
  withHeldNoticeBatch,
} from '../src/notifications/heldNoticeBatch';
import { heldSummaryLineId, recordHeldNoticeSummary } from '../src/notifications/noticeAudit';
import { notificationsHeldSummaryWords } from '../src/lib/activityWords';
import { runKincareReminderScan } from '../src/scheduled/kincareReminderCron';
import { runInvoiceOverdueScan, runInvoiceRemindersScan } from '../src/scheduled/invoiceRemindersCron';

/**
 * #2331: A TIMED JOB WRITES ONE ACTIVITY LOG LINE FOR THE NOTICES IT HELD BACK.
 *
 * With notices to households off, the visit reminder job (hourly) and the
 * invoice reminder and overdue jobs (daily) each wrote one "Notification not
 * sent" line per household copy, every run. The Activity Log lists the newest
 * 200 rows, so those lines could push the day's real activity out of view.
 *
 * Driven through the real scans, the real dispatcher and the real
 * `writeAuditEntry` against the in-memory Firestore, so each case reads the
 * `activity_log` documents a client would list.
 */
const NOW = Date.UTC(2026, 10, 14, 15, 5, 0);
const TICK = '2026-11-14T15:00:00Z';
const NEXT_TICK = '2026-11-14T16:00:00Z';
const TODAY = '2026-11-14';
const HOUR = 60 * 60 * 1000;

type Docs = Record<string, Record<string, unknown> | null>;
type Write = { path: string; data: Record<string, unknown> };
const logLines = (writes: Write[]) => writes.filter((w) => w.path.startsWith('activity_log/')).map((w) => w.data);
const logIds = (writes: Write[]) => writes.filter((w) => w.path.startsWith('activity_log/')).map((w) => w.path);

const settings = (live: boolean): Docs => ({
  [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: live },
});

/** A household with one sign-in, as the recipient resolvers read it. */
function household(n: number): Docs {
  return {
    [`kinfolk/fam${n}`]: { uid: `kin${n}`, kinfolkName: `Household ${n}` },
    [`families/fam${n}/members/kin${n}`]: { role: 'PRIMARY', status: 'ACTIVE' },
    [`clients/kin${n}`]: { displayName: `Person ${n}`, email: 'catch@hanasamku.com' },
  };
}
const households = (count: number): Docs =>
  Object.assign({}, ...Array.from({ length: count }, (_, i) => household(i + 1)));

/** A confirmed visit 36 hours out: inside the reminder window. */
const booking = (n: number) => ({
  id: `bk${n}`,
  path: `families/fam${n}/bookings/bk${n}`,
  data: { status: 'confirmed', serviceName: 'Drop-in', startTime: { toMillis: () => NOW + 36 * HOUR } },
});

function visitsDb(count: number, live = false, extra: Docs = {}) {
  const ctx = buildDbMock({
    docs: { ...settings(live), ...households(count), ...extra },
    collectionGroupDocs: { bookings: Array.from({ length: count }, (_, i) => booking(i + 1)) },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

/** Open invoices, each for its own household. `dueDate` decides reminder (soon) or overdue (past). */
function invoicesDb(count: number, dueDate: string, live = false) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `inv${i + 1}`,
    data: { status: 'open', amountDue: 120, amountMinor: 12000, currency: 'usd', dueDate, kinfolkId: `fam${i + 1}` },
  }));
  const ctx = buildDbMock({
    docs: { ...settings(live), ...households(count) },
    queryDocs: { invoices: rows },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.perCopyLine.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2331 the hourly visit reminder job, with notices to households off', () => {
  it('a run that holds 3 reminders writes one line that says 3', async () => {
    const ctx = visitsDb(3);
    expect(await runKincareReminderScan(NOW, TICK)).toBe(0);

    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actionType: 'NOTIFICATION_NOT_SENT',
      status: 'NOT_SENT',
      severity: 'info',
      actorRole: 'SYSTEM',
      description: 'Held back 3 visit reminders: notices to households are turned off',
      payload: {
        outcome: 'held',
        summary: true,
        job: 'kincareReminderCron',
        window: '2026-11-14T15',
        count: 3,
        kinds: { 'kincare.upcoming.reminder': 3 },
      },
    });
    // One entry sealed onto the chain for the whole run, not one per reminder.
    expect(lines[0]?.seq).toBe(1);
    // No household on a line about three of them.
    expect(lines[0]).not.toHaveProperty('familyId');
    expect(lines[0]).not.toHaveProperty('targetUid');
  });

  it('writes no line per reminder, so no name is read and no entry is sealed for each', async () => {
    visitsDb(3);
    await runKincareReminderScan(NOW, TICK);
    expect(mocks.perCopyLine).not.toHaveBeenCalled();
  });

  it('the sentence is words: no id, no stored key, no job name, no address', async () => {
    const ctx = visitsDb(2);
    await runKincareReminderScan(NOW, TICK);
    const sentence = String(logLines(ctx.writes)[0]?.description);
    expect(sentence).toBe('Held back 2 visit reminders: notices to households are turned off');
    expect(sentence).not.toMatch(/kin\d|fam\d|bk\d|kincare\.|Cron|@|uid=|T15/);
  });

  it('one held reminder reads in the singular', async () => {
    const ctx = visitsDb(1);
    await runKincareReminderScan(NOW, TICK);
    expect(logLines(ctx.writes)[0]?.description).toBe(
      'Held back 1 visit reminder: notices to households are turned off',
    );
  });

  it('a run that holds nothing writes nothing', async () => {
    const ctx = visitsDb(0);
    expect(await runKincareReminderScan(NOW, TICK)).toBe(0);
    expect(logLines(ctx.writes)).toEqual([]);
  });

  it('with notices on, the reminders go out and there is no held line', async () => {
    const ctx = visitsDb(3, true);
    expect(await runKincareReminderScan(NOW, TICK)).toBe(3);
    expect(logLines(ctx.writes).filter((l) => l.actionType === 'NOTIFICATION_NOT_SENT')).toEqual([]);
  });

  it('a retry of the same tick writes no second line; the next tick writes its own', async () => {
    const ctx = visitsDb(3);
    await runKincareReminderScan(NOW, TICK);
    // Cloud Scheduler repeats the tick's scheduleTime on a retry, minutes later.
    await runKincareReminderScan(NOW + 2 * 60 * 1000, TICK);
    expect(logLines(ctx.writes)).toHaveLength(1);

    await runKincareReminderScan(NOW + HOUR, NEXT_TICK);
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(new Set(logIds(ctx.writes)).size).toBe(2);
  });

  it('a retry that runs past the top of the hour still belongs to its own tick', () => {
    expect(hourWindow(Date.UTC(2026, 10, 14, 16, 1, 0), TICK)).toBe('2026-11-14T15');
    expect(hourWindow(NOW)).toBe('2026-11-14T15');
    expect(hourWindow(NOW, 'not a time')).toBe('2026-11-14T15');
  });

  it('a held reminder is still not stamped as reminded, so it goes out once notices are on', async () => {
    const ctx = visitsDb(2);
    await runKincareReminderScan(NOW, TICK);
    expect(ctx.writes.filter((w) => w.path.includes('/bookings/'))).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('notificationDedupe/'))).toEqual([]);
  });
});

describe('#2331 a run that fails half way', () => {
  it('still writes what it counted, and the error goes on to the scheduler', async () => {
    const ctx = visitsDb(0);
    await expect(
      withHeldNoticeBatch('kincareReminderCron', '2026-11-14T15', async (batch) => {
        for (const n of [1, 2]) {
          await enqueueNotificationDetailed(
            { key: 'kincare.upcoming.reminder', recipientUid: 'kinUid', data: { kinfolkId: 'fam1', bookingId: `bk${n}` } },
            batch,
          );
        }
        throw new Error('DEADLINE_EXCEEDED');
      }),
    ).rejects.toThrow('DEADLINE_EXCEEDED');

    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.description).toBe('Held back 2 visit reminders: notices to households are turned off');
  });

  it('the retry of that run adds no line: the first count stands', async () => {
    const ctx = visitsDb(3);
    const partial = startHeldNoticeBatch('kincareReminderCron', '2026-11-14T15');
    countHeldNotice(partial, 'kincare.upcoming.reminder', 'off');
    await recordHeldNoticeSummary(partial);

    await runKincareReminderScan(NOW + 60 * 1000, TICK);
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.description).toBe('Held back 1 visit reminder: notices to households are turned off');
  });

  it('a summary line that cannot be written does not fail the run', async () => {
    const ctx = visitsDb(2);
    ctx.db.runTransaction = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    await expect(runKincareReminderScan(NOW, TICK)).resolves.toBe(0);
    expect(mocks.logEventFn.mock.calls.map((c) => c[0].event)).toContain('notification.not_sent.audit_failed');
  });
});

describe('#2331 the daily invoice jobs, with notices to households off', () => {
  it('the reminder job writes one line with its count', async () => {
    const ctx = invoicesDb(4, '2026-11-15');
    expect(await runInvoiceRemindersScan(NOW, TODAY)).toBe(0);
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actionType: 'NOTIFICATION_NOT_SENT',
      status: 'NOT_SENT',
      description: 'Held back 4 invoice reminders: notices to households are turned off',
      payload: { job: 'invoiceRemindersCron', window: TODAY, count: 4, kinds: { 'invoice.reminder': 4 } },
    });
    expect(mocks.perCopyLine).not.toHaveBeenCalled();
  });

  it('the overdue job writes one line with its count', async () => {
    const ctx = invoicesDb(2, '2026-11-01');
    expect(await runInvoiceOverdueScan(NOW, TODAY)).toBe(0);
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      description: 'Held back 2 overdue invoice notices: notices to households are turned off',
      payload: { job: 'invoiceOverdueCron', window: TODAY, count: 2, kinds: { 'invoice.overdue': 2 } },
    });
    expect(mocks.perCopyLine).not.toHaveBeenCalled();
  });

  it('the two jobs on the same day write a line each, and a second run that day writes none', async () => {
    const ctx = invoicesDb(2, '2026-11-15');
    await runInvoiceRemindersScan(NOW, TODAY);
    await runInvoiceRemindersScan(NOW + 60 * 1000, TODAY);
    expect(logLines(ctx.writes)).toHaveLength(1);

    await runInvoiceRemindersScan(NOW + 24 * HOUR, '2026-11-15');
    expect(logLines(ctx.writes)).toHaveLength(2);
    expect(heldSummaryLineId('invoiceRemindersCron', TODAY, 'off')).not.toBe(
      heldSummaryLineId('invoiceOverdueCron', TODAY, 'off'),
    );
  });

  it('nothing due means no line', async () => {
    const ctx = invoicesDb(3, '2027-03-01');
    await runInvoiceRemindersScan(NOW, TODAY);
    await runInvoiceOverdueScan(NOW, TODAY);
    expect(logLines(ctx.writes)).toEqual([]);
  });
});

describe('#2331 what does not roll up', () => {
  it('a notice a person pressed keeps its own line, naming who it was for', async () => {
    const ctx = visitsDb(1);
    await enqueueNotificationDetailed({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kin1',
      data: { familyId: 'fam1', visitId: 'visit1' },
      dedupeKey: 'visit:visit1:on_my_way#a',
    });
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actionType: 'NOTIFICATION_NOT_SENT',
      status: 'NOT_SENT',
      familyId: 'fam1',
      description: 'Held back "Your Auntie is on the way" for Person 1: notices to households are turned off',
      payload: { key: 'kincare.auntie.on_my_way', outcome: 'held', recipientUid: 'kin1' },
    });
    expect(mocks.perCopyLine).toHaveBeenCalledTimes(1);
  });

  it('two pressed notices in a row are two lines', async () => {
    const ctx = visitsDb(2);
    for (const n of [1, 2]) {
      await enqueueNotificationDetailed({
        key: 'kincare.auntie.on_my_way',
        recipientUid: `kin${n}`,
        data: { familyId: `fam${n}`, visitId: `visit${n}` },
      });
    }
    expect(logLines(ctx.writes)).toHaveLength(2);
  });

  it('inside a timed job, a notification turned off in Settings (switch ON) still writes a line per notice', async () => {
    const rows = [1, 2].map((n) => ({
      id: `inv${n}`,
      data: { status: 'open', amountDue: 120, amountMinor: 12000, currency: 'usd', dueDate: '2026-11-15', kinfolkId: `fam${n}` },
    }));
    const ctx = buildDbMock({
      docs: {
        ...settings(true),
        ...households(2),
        'businessSettings/notifications': { byKey: { 'invoice.reminder': { enabled: false } } },
      },
      queryDocs: { invoices: rows },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    expect(await runInvoiceRemindersScan(NOW, TODAY)).toBe(0);
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.description)).toEqual([
      expect.stringMatching(/^Did not send "[^"]+" to Person 1: this notification is turned off in Settings$/),
      expect.stringMatching(/^Did not send "[^"]+" to Person 2: this notification is turned off in Settings$/),
    ]);
    expect(lines.every((l) => (l.payload as { summary?: boolean }).summary === undefined)).toBe(true);
  });

  it('a send that failed stays one FAILURE line per notice', async () => {
    // Notices on: the timed job hands each reminder to its channels as before.
    const ctx = invoicesDb(2, '2026-11-15', true);
    expect(await runInvoiceRemindersScan(NOW, TODAY)).toBe(2);
    // A reminder is queued for the 5-minute sweep; either collection is one row per notice.
    const orders = ctx.writes.filter((w) => /^(scheduledNotifications|notificationDispatch)\//.test(w.path));
    expect(orders).toHaveLength(2);
    expect(logLines(ctx.writes).filter((l) => l.actionType === 'NOTIFICATION_NOT_SENT')).toEqual([]);

    // The channel trigger writes the failure, one call per notice (`onNotificationChannelCreate`).
    const { recordNoticeNotSent, noticeLineId } = await import('../src/notifications/noticeAudit');
    for (const order of orders) {
      const notificationId = order.path.split('/')[1] ?? '';
      await recordNoticeNotSent({
        key: 'invoice.reminder',
        outcome: 'failed',
        recipientUid: String(order.data.recipientUid),
        stream: 'kinfolk',
        channels: ['email'],
        data: order.data.data as Record<string, unknown>,
        notificationId,
        docId: noticeLineId('failed', notificationId, 'email'),
      });
    }
    const failures = logLines(ctx.writes).filter((l) => l.actionType === 'NOTIFICATION_NOT_SENT');
    expect(failures).toHaveLength(2);
    expect(failures.map((l) => l.status)).toEqual(['FAILURE', 'FAILURE']);
    expect(failures.map((l) => l.familyId).sort()).toEqual(['fam1', 'fam2']);
    expect(failures.map((l) => l.description)).toEqual([
      expect.stringMatching(/^Could not send "[^"]+" to Person \d by email: the send failed$/),
      expect.stringMatching(/^Could not send "[^"]+" to Person \d by email: the send failed$/),
    ]);
  });
});

describe('#2331 the switch could not be read', () => {
  it('gets its own line, at warn, and does not say anyone turned it off', async () => {
    const ctx = visitsDb(2, true);
    ctx.db.doc(HOUSEHOLD_GATE_SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    await withHeldNoticeBatch('kincareReminderCron', '2026-11-14T15', async (batch) => {
      for (const n of [1, 2]) {
        await enqueueNotificationDetailed(
          { key: 'kincare.upcoming.reminder', recipientUid: `kin${n}`, data: { kinfolkId: `fam${n}`, bookingId: `bk${n}` } },
          batch,
        );
      }
    });
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'NOT_SENT',
      severity: 'warn',
      description: 'Held back 2 visit reminders: the setting for notices to households could not be read',
      payload: { count: 2, reason: 'setting_unreadable' },
    });
  });
});

describe('#2331 the sentence', () => {
  const kind = (key: string, count: number, name = '') => ({ key, name, count });

  it('names each timed kind, one and many', () => {
    expect(notificationsHeldSummaryWords([kind('kincare.upcoming.reminder', 14)])).toBe(
      'Held back 14 visit reminders: notices to households are turned off',
    );
    expect(notificationsHeldSummaryWords([kind('invoice.reminder', 1)])).toBe(
      'Held back 1 invoice reminder: notices to households are turned off',
    );
    expect(notificationsHeldSummaryWords([kind('invoice.overdue', 1)])).toBe(
      'Held back 1 overdue invoice notice: notices to households are turned off',
    );
  });

  it('a kind with no words of its own reads as its name, and never as its key', () => {
    expect(notificationsHeldSummaryWords([kind('invoice.payment.applied', 3, 'Payment received')])).toBe(
      'Held back 3 "Payment received" notices: notices to households are turned off',
    );
    expect(notificationsHeldSummaryWords([kind('some.new.key', 1, '')])).toBe(
      'Held back 1 notice: notices to households are turned off',
    );
    expect(notificationsHeldSummaryWords([kind('some.new.key', 2, '')])).toBe(
      'Held back 2 notices: notices to households are turned off',
    );
  });

  it('several kinds in one run read as a list', () => {
    expect(
      notificationsHeldSummaryWords([kind('invoice.overdue', 2), kind('invoice.reminder', 5), kind('kincare.upcoming.reminder', 1)]),
    ).toBe(
      'Held back 2 overdue invoice notices, 5 invoice reminders and 1 visit reminder: notices to households are turned off',
    );
  });
});
