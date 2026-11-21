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
  tickMs,
  withHeldNoticeBatch,
} from '../src/notifications/heldNoticeBatch';
import { heldMarkerPath } from '../src/notifications/noticeAudit';
import { notificationsHeldSummaryWords } from '../src/lib/activityWords';
import { runKincareReminderScan } from '../src/scheduled/kincareReminderCron';
import { runInvoiceOverdueScan, runInvoiceRemindersScan } from '../src/scheduled/invoiceRemindersCron';
import { scheduleMarketingBlastHandler } from '../src/admin/scheduleMarketingBlast';
import { drainScheduledNotifications } from '../src/scheduled/notificationScheduledSweep';
import { heldStampOf } from '../src/notifications/queuedCopyHold';
import type { CallableRequest } from 'firebase-functions/v2/https';

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

/** A confirmed visit 36 hours out (or `hoursOut`): inside the reminder window. */
const booking = (n: number, hoursOut = 36) => ({
  id: `bk${n}`,
  path: `families/fam${n}/bookings/bk${n}`,
  data: { status: 'confirmed', serviceName: 'Drop-in', startTime: { toMillis: () => NOW + hoursOut * HOUR } },
});

function visitsDb(count: number, live = false, extra: Docs = {}, hoursOut = 36) {
  const bookings = Array.from({ length: count }, (_, i) => booking(i + 1, hoursOut));
  // Kept, so a test can read what the run queued and flip the switch (#2478).
  const docs: Docs = { ...settings(live), ...households(count), ...extra };
  const ctx = buildDbMock({
    docs,
    collectionGroupDocs: { bookings },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  // The scan reads `bookings` afresh each run, so a test can book another visit between runs.
  return Object.assign(ctx, { bookings, docs });
}

/** Open invoices, each for its own household. `dueDate` decides reminder (soon) or overdue (past). */
function invoicesDb(count: number, dueDate: string, live = false) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `inv${i + 1}`,
    data: { status: 'open', amountDue: 120, amountMinor: 12000, currency: 'usd', dueDate, kinfolkId: `fam${i + 1}` },
  }));
  // Each invoice is stored as a document too, so a stamp merged onto it
  // keeps the rest of the invoice, as Firestore does. Kept for #2478.
  const docs: Docs = {
    ...settings(live),
    ...households(count),
    ...Object.fromEntries(rows.map((r) => [`invoices/${r.id}`, { ...r.data }])),
  };
  const ctx = buildDbMock({
    docs,
    queryDocs: { invoices: rows },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return Object.assign(ctx, { docs });
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
        day: '2026-11-14',
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

  it('a retry of the same tick writes no second line', async () => {
    const ctx = visitsDb(3);
    await runKincareReminderScan(NOW, TICK);
    // Cloud Scheduler repeats the tick's scheduleTime on a retry, minutes later.
    await runKincareReminderScan(NOW + 2 * 60 * 1000, TICK);
    expect(logLines(ctx.writes)).toHaveLength(1);
  });

  it('the next hour holds the same 3 reminders again and writes nothing', async () => {
    const ctx = visitsDb(3);
    await runKincareReminderScan(NOW, TICK);
    await runKincareReminderScan(NOW + HOUR, NEXT_TICK);
    await runKincareReminderScan(NOW + 2 * HOUR, '2026-11-14T17:00:00Z');
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.description).toBe('Held back 3 visit reminders: notices to households are turned off');
    // The chain was not touched by the runs that had nothing new to say.
    expect(ctx.writes.filter((w) => w.path.startsWith('activity_log_chain_head/'))).toHaveLength(1);
  });

  it('a reminder that comes due later that day is the only one the next line counts', async () => {
    const ctx = visitsDb(3, false, household(4));
    await runKincareReminderScan(NOW, TICK);

    // A fourth visit is booked into the window before the next tick.
    ctx.bookings.push(booking(4));
    await runKincareReminderScan(NOW + HOUR, NEXT_TICK);

    const lines = logLines(ctx.writes);
    expect(lines.map((l) => l.description)).toEqual([
      'Held back 3 visit reminders: notices to households are turned off',
      'Held back 1 visit reminder: notices to households are turned off',
    ]);
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect((lines[1]?.payload as { count?: number }).count).toBe(1);
  });

  it('the next business day counts the reminders still held once more; midnight UTC is not a new day', async () => {
    // 47 hours out, so the visits are still inside the window a day later.
    const ctx = visitsDb(2, false, {}, 47);
    await runKincareReminderScan(NOW, TICK);

    // 00:05 UTC on the 15th is 18:05 on the 14th in Chicago: the same business day.
    await runKincareReminderScan(Date.UTC(2026, 10, 15, 0, 5, 0), '2026-11-15T00:00:00Z');
    expect(logLines(ctx.writes)).toHaveLength(1);

    // 07:05 UTC on the 15th is 01:05 on the 15th in Chicago: a new business day.
    await runKincareReminderScan(Date.UTC(2026, 10, 15, 7, 5, 0), '2026-11-15T07:00:00Z');
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (l.payload as { day?: string }).day)).toEqual(['2026-11-14', '2026-11-15']);
    expect(lines[1]?.description).toBe('Held back 2 visit reminders: notices to households are turned off');

    // And once that day too.
    await runKincareReminderScan(Date.UTC(2026, 10, 15, 8, 5, 0), '2026-11-15T08:00:00Z');
    expect(logLines(ctx.writes)).toHaveLength(2);
  });

  it('a retry of yesterday\'s last tick that lands after today began writes nothing and leaves today\'s count alone', async () => {
    const ctx = visitsDb(2, false, {}, 47);
    // Today (the 15th in Chicago) has already been counted.
    await runKincareReminderScan(Date.UTC(2026, 10, 15, 7, 5, 0), '2026-11-15T07:00:00Z');
    expect(logLines(ctx.writes)).toHaveLength(1);

    // The 05:00 UTC tick was due at 23:00 on the 14th in Chicago; its retry runs late.
    await runKincareReminderScan(Date.UTC(2026, 10, 15, 7, 20, 0), '2026-11-15T05:00:00Z');
    expect(logLines(ctx.writes)).toHaveLength(1);

    // Today's next tick still finds its two counted.
    await runKincareReminderScan(Date.UTC(2026, 10, 15, 8, 5, 0), '2026-11-15T08:00:00Z');
    expect(logLines(ctx.writes)).toHaveLength(1);
    expect(ctx.writes.filter((w) => w.path.startsWith('scheduled_runs/'))).toHaveLength(1);
  });

  it('what the job has counted today is kept on one marker, with no id in the clear', async () => {
    const ctx = visitsDb(3);
    await runKincareReminderScan(NOW, TICK);
    await runKincareReminderScan(NOW + HOUR, NEXT_TICK);
    const markers = ctx.writes.filter((w) => w.path.startsWith('scheduled_runs/'));
    // Written once, with the line; the run with nothing new wrote nothing at all.
    expect(markers).toHaveLength(1);
    expect(markers[0]?.path).toBe(heldMarkerPath('kincareReminderCron'));
    expect(markers[0]?.data).toMatchObject({ dayIso: '2026-11-14', unreadable: [] });
    expect(markers[0]?.data.off).toHaveLength(3);
    expect(JSON.stringify(markers[0]?.data)).not.toMatch(/kin\d|fam\d|bk\d/);
  });

  it('a retry that runs past midnight still belongs to the day its tick was due', () => {
    expect(tickMs(Date.UTC(2026, 10, 15, 6, 1, 0), '2026-11-15T05:00:00Z')).toBe(Date.UTC(2026, 10, 15, 5, 0, 0));
    expect(tickMs(NOW)).toBe(NOW);
    expect(tickMs(NOW, 'not a time')).toBe(NOW);
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
      withHeldNoticeBatch('kincareReminderCron', { atMs: NOW }, async (batch) => {
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

  it('the retry of that run writes a line for the rest only: the two lines add up', async () => {
    const ctx = visitsDb(3);
    // The first attempt held one reminder and died.
    await expect(
      withHeldNoticeBatch('kincareReminderCron', { atMs: NOW }, async (batch) => {
        await enqueueNotificationDetailed(
          { key: 'kincare.upcoming.reminder', recipientUid: 'kin1', data: { kinfolkId: 'fam1', bookingId: 'bk1' } },
          batch,
        );
        throw new Error('DEADLINE_EXCEEDED');
      }),
    ).rejects.toThrow('DEADLINE_EXCEEDED');

    // The retry of the tick scans all three.
    await runKincareReminderScan(NOW + 60 * 1000, TICK);
    expect(logLines(ctx.writes).map((l) => l.description)).toEqual([
      'Held back 1 visit reminder: notices to households are turned off',
      'Held back 2 visit reminders: notices to households are turned off',
    ]);

    // A second retry has nothing left to count.
    await runKincareReminderScan(NOW + 2 * 60 * 1000, TICK);
    expect(logLines(ctx.writes)).toHaveLength(2);
  });

  it('a line that could not be written is not marked as counted: the next run writes it', async () => {
    const ctx = visitsDb(2);
    const real = ctx.db.runTransaction;
    ctx.db.runTransaction = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    await runKincareReminderScan(NOW, TICK);
    expect(logLines(ctx.writes)).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('scheduled_runs/'))).toEqual([]);

    ctx.db.runTransaction = real;
    await runKincareReminderScan(NOW + HOUR, NEXT_TICK);
    expect(logLines(ctx.writes).map((l) => l.description)).toEqual([
      'Held back 2 visit reminders: notices to households are turned off',
    ]);
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
      payload: { job: 'invoiceRemindersCron', day: TODAY, count: 4, kinds: { 'invoice.reminder': 4 } },
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
      payload: { job: 'invoiceOverdueCron', day: TODAY, count: 2, kinds: { 'invoice.overdue': 2 } },
    });
    expect(mocks.perCopyLine).not.toHaveBeenCalled();
  });

  it('a second scan the same business day writes no second line; the next day counts them once more', async () => {
    const ctx = invoicesDb(2, '2026-11-16');
    await runInvoiceRemindersScan(NOW, TODAY);
    // A retry, or a day marker that did not land, scans the day again.
    await runInvoiceRemindersScan(NOW + 60 * 1000, TODAY);
    await runInvoiceRemindersScan(NOW + 3 * HOUR, TODAY);
    expect(logLines(ctx.writes)).toHaveLength(1);

    await runInvoiceRemindersScan(NOW + 24 * HOUR, '2026-11-15');
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      description: 'Held back 2 invoice reminders: notices to households are turned off',
      payload: { day: '2026-11-15', count: 2 },
    });
  });

  it('the overdue job, scanned twice in a day, writes one line', async () => {
    const ctx = invoicesDb(2, '2026-11-01');
    await runInvoiceOverdueScan(NOW, TODAY);
    // A held overdue notice backs off for 20 hours. A scan past that which still
    // belongs to the same business day (a late retry) holds the two again.
    await runInvoiceOverdueScan(NOW + 21 * HOUR, TODAY);
    expect(logLines(ctx.writes)).toHaveLength(1);
  });

  it('each job keeps its own count: the same day, a line each', async () => {
    const ctx = invoicesDb(2, '2026-11-15');
    await runInvoiceRemindersScan(NOW, TODAY);
    const overdue = invoicesDb(2, '2026-11-01');
    await runInvoiceOverdueScan(NOW, TODAY);
    expect(logLines(ctx.writes)).toHaveLength(1);
    expect(logLines(overdue.writes)).toHaveLength(1);
    expect(heldMarkerPath('invoiceRemindersCron')).not.toBe(heldMarkerPath('invoiceOverdueCron'));
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
    await withHeldNoticeBatch('kincareReminderCron', { atMs: NOW }, async (batch) => {
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

  it('is counted apart from turned off: a copy already counted as off still shows in the warn line, once', async () => {
    const ctx = visitsDb(2);
    await runKincareReminderScan(NOW, TICK);
    ctx.db.doc(HOUSEHOLD_GATE_SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    await runKincareReminderScan(NOW + HOUR, NEXT_TICK);
    await runKincareReminderScan(NOW + 2 * HOUR, '2026-11-14T17:00:00Z');
    expect(logLines(ctx.writes).map((l) => [l.severity, l.description])).toEqual([
      ['info', 'Held back 2 visit reminders: notices to households are turned off'],
      ['warn', 'Held back 2 visit reminders: the setting for notices to households could not be read'],
    ]);
  });
});

describe('#2331 the run count is never stored', () => {
  it('with notices on, nothing a timed job writes carries the count or the job', async () => {
    const ctx = visitsDb(2, true);
    expect(await runKincareReminderScan(NOW, TICK)).toBe(2);
    const invoices = invoicesDb(2, '2026-11-15', true);
    expect(await runInvoiceRemindersScan(NOW, TODAY)).toBe(2);

    const stored = [...ctx.writes, ...invoices.writes];
    // Notifications, work orders, the dedupe ledger and the stamps were all written.
    expect(stored.length).toBeGreaterThan(4);
    for (const w of stored) {
      expect(Object.keys(w.data)).not.toEqual(expect.arrayContaining(['heldBatch']));
      expect(JSON.stringify(w.data)).not.toMatch(/heldBatch|unnamed|kincareReminderCron|invoiceRemindersCron/);
    }
    expect(stored.filter((w) => w.path.startsWith('scheduled_runs/'))).toEqual([]);
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

/** Open invoices due soon, with `invoice.reminder` turned off in Settings when `off`. */
function turnedOffDb(count: number, opts: { live?: boolean; off?: boolean } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `inv${i + 1}`,
    data: { status: 'open', amountDue: 120, amountMinor: 12000, currency: 'usd', dueDate: '2026-11-15', kinfolkId: `fam${i + 1}` },
  }));
  const docs: Docs = {
    ...settings(opts.live ?? true),
    ...households(count),
    ...(opts.off ?? true ? { 'businessSettings/notifications': { byKey: { 'invoice.reminder': { enabled: false } } } } : {}),
  };
  const ctx = buildDbMock({ docs, queryDocs: { invoices: rows }, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ...ctx, docs };
}

describe('#2341 a notification turned off in Settings, inside a timed job', () => {
  it('writes one line for the run, with a count, and no line per notice', async () => {
    const ctx = turnedOffDb(3);
    expect(await runInvoiceRemindersScan(NOW, TODAY)).toBe(0);
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      actionType: 'NOTIFICATION_NOT_SENT',
      status: 'NOT_SENT',
      severity: 'info',
      actorRole: 'SYSTEM',
      description: 'Did not send 3 invoice reminders: this notification is turned off in Settings',
      payload: {
        outcome: 'turned_off',
        summary: true,
        job: 'invoiceRemindersCron',
        day: TODAY,
        count: 3,
        kinds: { 'invoice.reminder': 3 },
      },
    });
    expect(lines[0]).not.toHaveProperty('familyId');
    expect(mocks.perCopyLine).not.toHaveBeenCalled();
  });

  it('a second scan the same day writes nothing more', async () => {
    const ctx = turnedOffDb(2);
    await runInvoiceRemindersScan(NOW, TODAY);
    await runInvoiceRemindersScan(NOW + HOUR, TODAY);
    expect(logLines(ctx.writes)).toHaveLength(1);
  });

  it('the day\'s count of one reason survives a line for another', async () => {
    // Turned off in Settings with the switch on: counted as turned off.
    const ctx = turnedOffDb(2);
    await runInvoiceRemindersScan(NOW, TODAY);
    // Notification back on, switch off: the same reminders are now held by the switch.
    delete ctx.docs['businessSettings/notifications'];
    ctx.docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { timeZone: 'America/Chicago', householdNotificationsLive: false };
    await runInvoiceRemindersScan(NOW + HOUR, TODAY);
    // Turned off again, switch on: already counted today, so no third line.
    ctx.docs['businessSettings/notifications'] = { byKey: { 'invoice.reminder': { enabled: false } } };
    ctx.docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { timeZone: 'America/Chicago', householdNotificationsLive: true };
    await runInvoiceRemindersScan(NOW + 2 * HOUR, TODAY);
    expect(logLines(ctx.writes).map((l) => l.description)).toEqual([
      'Did not send 2 invoice reminders: this notification is turned off in Settings',
      'Held back 2 invoice reminders: notices to households are turned off',
    ]);
  });

  it('the overdue job rolls up the same way', async () => {
    const rows = [1, 2].map((n) => ({
      id: `inv${n}`,
      data: { status: 'open', amountDue: 120, amountMinor: 12000, currency: 'usd', dueDate: '2026-11-01', kinfolkId: `fam${n}` },
    }));
    const ctx = buildDbMock({
      docs: {
        ...settings(true),
        ...households(2),
        'businessSettings/notifications': { byKey: { 'invoice.overdue': { enabled: false } } },
      },
      queryDocs: { invoices: rows },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runInvoiceOverdueScan(NOW, TODAY);
    expect(logLines(ctx.writes).map((l) => l.description)).toEqual([
      'Did not send 2 overdue invoice notices: this notification is turned off in Settings',
    ]);
  });

  it('a notice a person pressed, turned off in Settings, keeps its own line', async () => {
    const ctx = visitsDb(1, true, {
      'businessSettings/notifications': { byKey: { 'kincare.auntie.on_my_way': { enabled: false } } },
    });
    await enqueueNotificationDetailed({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kin1',
      data: { familyId: 'fam1', visitId: 'visit1' },
    });
    const lines = logLines(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      familyId: 'fam1',
      description: 'Did not send "Your Auntie is on the way" to Person 1: this notification is turned off in Settings',
      payload: { outcome: 'turned_off', recipientUid: 'kin1' },
    });
  });
});

describe('#2346 the once-a-day rule for a pressed notice is the business day', () => {
  const press = () =>
    enqueueNotificationDetailed({
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'kin1',
      data: { familyId: 'fam1', visitId: 'visit1' },
      dedupeKey: 'visit:visit1:on_my_way#a',
    });

  it('held at 5 PM and again at 8 PM Chicago, across the UTC midnight, is one line', async () => {
    const ctx = visitsDb(1);
    vi.setSystemTime(Date.UTC(2026, 10, 14, 23, 0, 0)); // 5 PM CST, Nov 14
    await press();
    vi.setSystemTime(Date.UTC(2026, 10, 15, 2, 0, 0)); // 8 PM CST, Nov 14; Nov 15 in UTC
    await press();
    expect(logLines(ctx.writes)).toHaveLength(1);
  });

  it('held at 11 PM and again at 1 AM Chicago, across the business midnight, is two lines', async () => {
    const ctx = visitsDb(1);
    vi.setSystemTime(Date.UTC(2026, 10, 15, 5, 0, 0)); // 11 PM CST, Nov 14
    await press();
    vi.setSystemTime(Date.UTC(2026, 10, 15, 7, 0, 0)); // 1 AM CST, Nov 15; same UTC day
    await press();
    expect(logLines(ctx.writes)).toHaveLength(2);
  });

  it('the line id follows the business zone, and the ruled Chicago zone when settings cannot be read', async () => {
    const { noticeLineIdForEvent } = await import('../src/notifications/noticeAudit');
    const ctx = visitsDb(1);
    const fivePm = Date.UTC(2026, 10, 14, 23, 0, 0);
    const eightPm = Date.UTC(2026, 10, 15, 2, 0, 0);
    const nextMorning = Date.UTC(2026, 10, 15, 15, 0, 0);
    const at5pm = await noticeLineIdForEvent('held', 'k', 'id', 'kin1', fivePm);
    expect(await noticeLineIdForEvent('held', 'k', 'id', 'kin1', eightPm)).toBe(at5pm);
    expect(await noticeLineIdForEvent('held', 'k', 'id', 'kin1', nextMorning)).not.toBe(at5pm);
    ctx.db.doc(HOUSEHOLD_GATE_SETTINGS_PATH).get = vi.fn().mockRejectedValue(new Error('UNAVAILABLE'));
    expect(await noticeLineIdForEvent('held', 'k', 'id', 'kin1', eightPm)).toBe(at5pm);
  });
});

describe('#2340 a marketing blast with notices to households off', () => {
  /** `count` households with a sign-in, each opted in to the newsletter. */
  function blastDb(count: number, extra: Docs = {}) {
    const docs: Docs = { ...settings(false), ...households(count), ...extra };
    for (let n = 1; n <= count; n += 1) {
      docs[`clients/kin${n}`] = {
        ...(docs[`clients/kin${n}`] as Record<string, unknown>),
        notificationPrefs: { marketingOptIn: { newsletter: true } },
      };
    }
    const kinfolk = Array.from({ length: count }, (_, i) => ({
      id: `fam${i + 1}`,
      data: { status: 'active', tags: [], uid: `kin${i + 1}`, kinfolkName: `Household ${i + 1}` },
    }));
    const ctx = buildDbMock({ docs, queryDocs: { kinfolk }, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return { ...ctx, docs };
  }

  const blast = (over: Record<string, unknown> = {}) =>
    scheduleMarketingBlastHandler({
      data: { key: 'newsletter.announcement', fireAtMs: NOW + HOUR, data: { subject: 'Sample' }, criteria: { kind: 'all' }, ...over },
      auth: { uid: 'admin1', token: { admin: true } },
    } as unknown as CallableRequest<unknown>);

  const notSent = (writes: Write[]) => logLines(writes).filter((l) => l.actionType === 'NOTIFICATION_NOT_SENT');

  // #1834 (ruling 2026-11-20): a blast is held as a whole before anything is
  // queued, so the line names the blast and its households, not its copies.
  it('#1834: held as a whole, one line for the blast, nothing queued to go later', async () => {
    const ctx = blastDb(3);
    await expect(blast()).rejects.toMatchObject({ code: 'failed-precondition', message: 'held_household_notices_off' });
    const lines = notSent(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'NOT_SENT',
      severity: 'info',
      description: 'Held back a marketing blast to 3 households: notices to households are turned off. It will not be sent later',
      payload: { key: 'newsletter.announcement', outcome: 'held', households: 3 },
    });
    expect(lines[0]).not.toHaveProperty('familyId');
    expect(mocks.perCopyLine).not.toHaveBeenCalled();
    expect(ctx.writes.filter((w) => w.path.startsWith('scheduledNotifications/'))).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('marketingBlasts/'))).toEqual([]);
  });

  it('#1834: two held blasts the same day are a line each', async () => {
    const ctx = blastDb(2);
    await expect(blast()).rejects.toBeTruthy();
    await expect(blast({ data: { subject: 'Second' } })).rejects.toBeTruthy();
    expect(notSent(ctx.writes).map((l) => l.description)).toEqual([
      'Held back a marketing blast to 2 households: notices to households are turned off. It will not be sent later',
      'Held back a marketing blast to 2 households: notices to households are turned off. It will not be sent later',
    ]);
  });

  it('#1834: the newsletter turned off in Settings, switch on: held with one "Did not send" line', async () => {
    const ctx = blastDb(2, {
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: true },
      'businessSettings/notifications': { byKey: { 'newsletter.announcement': { enabled: false } } },
    });
    await expect(blast()).rejects.toMatchObject({ message: 'held_notice_turned_off' });
    expect(notSent(ctx.writes).map((l) => l.description)).toEqual([
      'Did not send a marketing blast to 2 households: this notification is turned off in Settings. It will not be sent later',
    ]);
  });

  it('#1834: scheduled while on, due after notices were turned off: held at its send time, one #2340 line', async () => {
    const ctx = blastDb(2, {
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: true },
    });
    const res = await blast();
    expect(res.dispatched).toBe(2);
    const queued = () => Object.keys(ctx.docs).filter((k) => k.startsWith('scheduledNotifications/') && ctx.docs[k]);
    expect(queued()).toHaveLength(2);

    ctx.docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { timeZone: 'America/Chicago', householdNotificationsLive: false };
    const drained = await drainScheduledNotifications(NOW + 2 * HOUR);

    expect(drained).toEqual({ promoted: 0, held: 2 });
    expect(queued()).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/') || w.path.startsWith('notificationDispatch/'))).toEqual([]);
    // One counted increment per held copy (the mock records an increment, it does not add it up).
    const heldStamps = ctx.writes.filter((w) => w.path === `marketingBlasts/${res.blastId}` && 'heldAtSend' in w.data);
    expect(heldStamps).toHaveLength(2);
    expect(heldStamps.every((w) => w.merge && w.data.heldReason === 'off')).toBe(true);
    // #2478: the copies came off the queue, so the line says they will not go later.
    expect(notSent(ctx.writes).map((l) => l.description)).toEqual([
      'Held back 2 notices from a marketing blast: notices to households are turned off. They will not be sent later',
    ]);

    // Switching notices back on sends nothing: held means never sent later.
    ctx.docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { timeZone: 'America/Chicago', householdNotificationsLive: true };
    expect(await drainScheduledNotifications(NOW + 3 * HOUR)).toEqual({ promoted: 0, held: 0 });
  });

  it('#1834 ERROR: settings that cannot be read at the send time neither send nor drop the copies', async () => {
    const ctx = blastDb(2, {
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: true },
    });
    await blast();
    const queued = () => Object.keys(ctx.docs).filter((k) => k.startsWith('scheduledNotifications/') && ctx.docs[k]);
    expect(queued()).toHaveLength(2);

    const realDoc = ctx.db.doc.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, 'doc').mockImplementation(((path: string) =>
      path.startsWith('business_settings/')
        ? { get: () => Promise.reject(new Error('unavailable')) }
        : realDoc(path)) as any);
    expect(await drainScheduledNotifications(NOW + 2 * HOUR)).toEqual({ promoted: 0, held: 0 });
    // Still queued, nothing sent, nothing counted as held, no line.
    expect(queued()).toHaveLength(2);
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toEqual([]);
    expect(notSent(ctx.writes)).toEqual([]);

    // The next tick reads the setting and the blast goes.
    spy.mockRestore();
    expect(await drainScheduledNotifications(NOW + 2 * HOUR)).toEqual({ promoted: 2, held: 0 });
  });

  it('#1834: switched on at its send time, the blast is promoted as before', async () => {
    const ctx = blastDb(2, {
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: true },
    });
    await blast();
    expect(await drainScheduledNotifications(NOW + 2 * HOUR)).toEqual({ promoted: 2, held: 0 });
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toHaveLength(2);
  });

  // #2478: this pinned the defect. A household copy that is not a blast is
  // held at its send time too (the `#2478` block below has the cases).
  it('#2478: a household notice that is not a blast is held by the send-time check too', async () => {
    const ctx = blastDb(0, {
      'scheduledNotifications/r1': {
        key: 'invoice.reminder',
        recipientUid: 'kin1',
        stream: 'kinfolk',
        fireAtMs: NOW,
        channels: ['email'],
        data: { invoiceId: 'inv1' },
      },
    });
    expect(await drainScheduledNotifications(NOW + HOUR)).toEqual({ promoted: 0, held: 1 });
    expect(notSent(ctx.writes).map((l) => l.description)).toEqual([
      'Held back 1 invoice reminder: notices to households are turned off. It will not be sent later',
    ]);
  });

  it('a blast that goes out writes no "not sent" line', async () => {
    const ctx = blastDb(2, {
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { timeZone: 'America/Chicago', householdNotificationsLive: true },
    });
    const res = await blast();
    expect(res.dispatched).toBe(2);
    expect(notSent(ctx.writes)).toEqual([]);
  });
});

/**
 * #2478: A HOUSEHOLD COPY QUEUED FOR LATER IS ASKED AGAIN AT ITS SEND TIME.
 *
 * The switch used to be asked only when the copy was queued. An invoice or
 * visit reminder queued while notices to households were on still went out at
 * its time if the switch was turned off in between. Now the sweep asks the
 * switch again for every household copy it is about to promote: off, the copy
 * comes off the queue and is never sent later, and the run writes one line
 * with the count. Driven through the real crons, the real sweep and the real
 * Activity Log writer.
 */
describe('#2478 a household copy queued for later, notices turned off before its time', () => {
  const notSent = (writes: Write[]) => logLines(writes).filter((l) => l.actionType === 'NOTIFICATION_NOT_SENT');
  const queuedRows = (docs: Docs) => Object.keys(docs).filter((k) => k.startsWith('scheduledNotifications/') && docs[k]);
  const sends = (writes: Write[]) =>
    writes.filter((w) => w.path.startsWith('notifications/') || w.path.startsWith('notificationDispatch/'));
  const setLive = (docs: Docs, live: boolean) => {
    docs[HOUSEHOLD_GATE_SETTINGS_PATH] = { timeZone: 'America/Chicago', householdNotificationsLive: live };
  };

  /** A queued row as the dispatcher writes it, for keys no cron queues today. */
  const row = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    recipientUid: 'kin1',
    stream: 'kinfolk',
    fireAtMs: NOW,
    channels: ['email'],
    data: { kinfolkId: 'fam1' },
    ...over,
  });
  function queueDb(live: boolean, rows: Docs) {
    const docs: Docs = { ...settings(live), ...households(1), ...rows };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    return Object.assign(ctx, { docs });
  }

  it('invoice reminders queued while on, switched off before their time: held, one line, never sent later', async () => {
    const ctx = invoicesDb(2, '2026-11-15', true);
    expect(await runInvoiceRemindersScan(NOW, TODAY)).toBe(2);
    expect(queuedRows(ctx.docs)).toHaveLength(2);

    setLive(ctx.docs, false);
    expect(await drainScheduledNotifications(NOW + 5 * 60 * 1000)).toEqual({ promoted: 0, held: 2 });
    expect(queuedRows(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
    const lines = notSent(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      status: 'NOT_SENT',
      severity: 'info',
      actorRole: 'SYSTEM',
      description: 'Held back 2 invoice reminders: notices to households are turned off. They will not be sent later',
      payload: {
        outcome: 'held',
        summary: true,
        job: 'notificationScheduledSweep',
        count: 2,
        kinds: { 'invoice.reminder': 2 },
      },
    });
    // Counts only: no household, no person, no id on the line.
    expect(lines[0]).not.toHaveProperty('familyId');
    expect(JSON.stringify(lines[0])).not.toContain('Household 1');
    expect(mocks.perCopyLine).not.toHaveBeenCalled();

    // Switching notices back on sends nothing, and the next run writes no second line.
    setLive(ctx.docs, true);
    expect(await drainScheduledNotifications(NOW + 10 * 60 * 1000)).toEqual({ promoted: 0, held: 0 });
    expect(sends(ctx.writes)).toEqual([]);
    expect(notSent(ctx.writes)).toHaveLength(1);

    // Nor does the reminder job queue them again, today or the next business day.
    expect(await runInvoiceRemindersScan(NOW + HOUR, TODAY)).toBe(0);
    expect(await runInvoiceRemindersScan(NOW + 24 * HOUR, '2026-11-15')).toBe(0);
    expect(queuedRows(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
  });

  it('visit reminders queued while on, switched off before their time: held with one line', async () => {
    const ctx = visitsDb(3, true);
    expect(await runKincareReminderScan(NOW, TICK)).toBe(3);
    expect(queuedRows(ctx.docs)).toHaveLength(3);

    setLive(ctx.docs, false);
    expect(await drainScheduledNotifications(NOW + 5 * 60 * 1000)).toEqual({ promoted: 0, held: 3 });
    expect(queuedRows(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
    expect(notSent(ctx.writes).map((l) => l.description)).toEqual([
      'Held back 3 visit reminders: notices to households are turned off. They will not be sent later',
    ]);

    // Switched back on, the next hourly run does not queue them again.
    setLive(ctx.docs, true);
    expect(await runKincareReminderScan(NOW + HOUR, NEXT_TICK)).toBe(0);
    expect(queuedRows(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
  });

  it('an overdue notice queued while on is held the same way', async () => {
    const ctx = invoicesDb(1, '2026-11-01', true);
    expect(await runInvoiceOverdueScan(NOW, TODAY)).toBe(1);
    setLive(ctx.docs, false);
    expect(await drainScheduledNotifications(NOW + 5 * 60 * 1000)).toEqual({ promoted: 0, held: 1 });
    expect(notSent(ctx.writes).map((l) => l.description)).toEqual([
      'Held back 1 overdue invoice notice: notices to households are turned off. It will not be sent later',
    ]);

    // Switched back on, the overdue job does not queue it again the next business day.
    setLive(ctx.docs, true);
    expect(await runInvoiceOverdueScan(NOW + 24 * HOUR, '2026-11-15')).toBe(0);
    expect(queuedRows(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
  });

  it('still on at their time, the reminders are promoted as before and no line is written', async () => {
    const ctx = invoicesDb(2, '2026-11-15', true);
    await runInvoiceRemindersScan(NOW, TODAY);
    expect(await drainScheduledNotifications(NOW + 5 * 60 * 1000)).toEqual({ promoted: 2, held: 0 });
    expect(ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'))).toHaveLength(2);
    expect(notSent(ctx.writes)).toEqual([]);
    // #2515: a reminder that went out carries no held stamp.
    expect(ctx.docs['invoices/inv1']).not.toHaveProperty('reminderHeldAtMs');
  });

  /**
   * #2515 (lead decision 2026-11-21): the held reminder stays gone, and its
   * invoice or visit says it was held. The sent stamp stays (it is what keeps
   * the reminder from coming back), and the hold's time is written beside it,
   * so "Last reminder" reads "held, not sent".
   */
  describe('#2515 the invoice or visit records the reminder as held', () => {
    const HELD_AT = NOW + 5 * 60 * 1000;

    it('an invoice reminder held at its send time stamps the invoice as held, at or after its sent stamp', async () => {
      const ctx = invoicesDb(2, '2026-11-15', true);
      await runInvoiceRemindersScan(NOW, TODAY);
      setLive(ctx.docs, false);
      await drainScheduledNotifications(HELD_AT);
      for (const id of ['inv1', 'inv2']) {
        expect(ctx.docs[`invoices/${id}`]).toMatchObject({
          status: 'open',
          amountDue: 120,
          reminderNotifiedAtMs: NOW,
          reminderHeldAtMs: HELD_AT,
        });
      }
      // The once-ever gate stays: the reminder job does not raise it again.
      setLive(ctx.docs, true);
      expect(await runInvoiceRemindersScan(NOW + 24 * HOUR, '2026-11-15')).toBe(0);
      expect(ctx.docs['invoices/inv1']).toMatchObject({ reminderNotifiedAtMs: NOW, reminderHeldAtMs: HELD_AT });
    });

    it('an overdue notice held at its send time stamps overdueHeldAtMs', async () => {
      const ctx = invoicesDb(1, '2026-11-01', true);
      await runInvoiceOverdueScan(NOW, TODAY);
      setLive(ctx.docs, false);
      await drainScheduledNotifications(HELD_AT);
      expect(ctx.docs['invoices/inv1']).toMatchObject({ overdueNotifiedAtMs: NOW, overdueHeldAtMs: HELD_AT });
      expect(ctx.docs['invoices/inv1']).not.toHaveProperty('reminderHeldAtMs');
    });

    it('a visit reminder held at its send time stamps the booking', async () => {
      const ctx = visitsDb(2, true);
      await runKincareReminderScan(NOW, TICK);
      setLive(ctx.docs, false);
      await drainScheduledNotifications(HELD_AT);
      expect(ctx.docs['families/fam1/bookings/bk1']).toMatchObject({
        upcomingReminderNotifiedAtMs: NOW,
        upcomingReminderHeldAtMs: HELD_AT,
      });
      expect(ctx.docs['families/fam2/bookings/bk2']).toMatchObject({ upcomingReminderHeldAtMs: HELD_AT });
    });

    it('a pressed reminder (no target on the row) is stamped by the invoice id it carries', async () => {
      const ctx = queueDb(false, {
        'invoices/inv9': { status: 'open', kinfolkId: 'fam1', reminderNotifiedAtMs: NOW },
        'scheduledNotifications/pressed': row('invoice.reminder', { data: { kinfolkId: 'fam1', invoiceId: 'inv9' } }),
      });
      expect(await drainScheduledNotifications(HELD_AT)).toEqual({ promoted: 0, held: 1 });
      expect(ctx.docs['invoices/inv9']).toMatchObject({ reminderNotifiedAtMs: NOW, reminderHeldAtMs: HELD_AT });
    });

    it('NEGATIVE: an invoice that no longer exists is not made out of nothing', async () => {
      const ctx = queueDb(false, {
        'scheduledNotifications/gone': row('invoice.reminder', {
          data: { kinfolkId: 'fam1', invoiceId: 'inv-gone' },
          targetType: 'invoice',
          targetId: 'inv-gone',
        }),
      });
      expect(await drainScheduledNotifications(HELD_AT)).toEqual({ promoted: 0, held: 1 });
      expect(ctx.docs['invoices/inv-gone']).toBeUndefined();
      expect(ctx.writes.filter((w) => w.path.startsWith('invoices/'))).toEqual([]);
    });

    it('where each reminder records its hold, and nowhere for an id that is not one', () => {
      expect(heldStampOf({ key: 'invoice.reminder', data: { invoiceId: 'inv1' } })).toEqual({
        path: 'invoices/inv1',
        field: 'reminderHeldAtMs',
      });
      expect(heldStampOf({ key: 'invoice.overdue', data: {}, targetType: 'invoice', targetId: 'inv2' })).toEqual({
        path: 'invoices/inv2',
        field: 'overdueHeldAtMs',
      });
      expect(heldStampOf({ key: 'kincare.upcoming.reminder', data: { kinfolkId: 'fam1', bookingId: 'bk1' } })).toEqual({
        path: 'families/fam1/bookings/bk1',
        field: 'upcomingReminderHeldAtMs',
      });
      expect(heldStampOf({ key: 'invoice.reminder', data: { invoiceId: 'a/b' } })).toBeNull();
      expect(heldStampOf({ key: 'invoice.reminder', data: {} })).toBeNull();
      expect(heldStampOf({ key: 'kincare.upcoming.reminder', data: { kinfolkId: 'fam1' } })).toBeNull();
      expect(heldStampOf({ key: 'kintale.published', data: { invoiceId: 'inv1' } })).toBeNull();
    });

    it('NEGATIVE: a held copy that is not a reminder stamps nothing', async () => {
      const ctx = queueDb(false, {
        'invoices/inv9': { status: 'open', kinfolkId: 'fam1' },
        'scheduledNotifications/other': row('invoice.payment.applied', {
          data: { kinfolkId: 'fam1', invoiceId: 'inv9' },
          targetType: 'invoice',
          targetId: 'inv9',
        }),
      });
      expect(await drainScheduledNotifications(HELD_AT)).toEqual({ promoted: 0, held: 1 });
      expect(ctx.docs['invoices/inv9']).toEqual({ status: 'open', kinfolkId: 'fam1' });
    });
  });

  it('ERROR: a switch that cannot be read neither sends nor drops the copy; the next tick sends it', async () => {
    const ctx = invoicesDb(1, '2026-11-15', true);
    await runInvoiceRemindersScan(NOW, TODAY);
    const realDoc = ctx.db.doc.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, 'doc').mockImplementation(((path: string) =>
      path.startsWith('business_settings/')
        ? { get: () => Promise.reject(new Error('unavailable')) }
        : realDoc(path)) as any);
    expect(await drainScheduledNotifications(NOW + 5 * 60 * 1000)).toEqual({ promoted: 0, held: 0 });
    expect(queuedRows(ctx.docs)).toHaveLength(1);
    expect(sends(ctx.writes)).toEqual([]);
    expect(notSent(ctx.writes)).toEqual([]);

    spy.mockRestore();
    expect(await drainScheduledNotifications(NOW + 10 * 60 * 1000)).toEqual({ promoted: 1, held: 0 });
    expect(queuedRows(ctx.docs)).toEqual([]);
  });

  it('the four confirmations locked on for Kinfolk still obey the switch at their send time', async () => {
    const locked = ['invoice.new', 'invoice.receipt', 'invoice.payment.applied', 'kintale.published', 'kincare.booking.confirm'];
    const ctx = queueDb(false, Object.fromEntries(locked.map((key, i) => [`scheduledNotifications/c${i}`, row(key)])));
    expect(await drainScheduledNotifications(NOW + HOUR)).toEqual({ promoted: 0, held: locked.length });
    expect(queuedRows(ctx.docs)).toEqual([]);
    expect(sends(ctx.writes)).toEqual([]);
    const lines = notSent(ctx.writes);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toMatchObject({ count: locked.length, job: 'notificationScheduledSweep' });
  });

  it('a single message to one household passes, as it does when sent at once (#1834)', async () => {
    const ctx = queueDb(false, { 'scheduledNotifications/m1': row('message.reply') });
    expect(await drainScheduledNotifications(NOW + HOUR)).toEqual({ promoted: 1, held: 0 });
    expect(notSent(ctx.writes)).toEqual([]);
  });

  it("the office's and staff copies are not household copies and are promoted with the switch off", async () => {
    const ctx = queueDb(false, {
      'scheduledNotifications/s1': row('schedule.upcoming.digest', { recipientUid: 'staff1', stream: 'staff' }),
      'scheduledNotifications/b1': row('invoice.reminder', { recipientUid: 'admin1', stream: 'business' }),
      // A row queued before rows carried a stream, for a key only staff get.
      'scheduledNotifications/s2': row('schedule.upcoming.digest', { recipientUid: 'staff1', stream: undefined }),
    });
    expect(await drainScheduledNotifications(NOW + HOUR)).toEqual({ promoted: 3, held: 0 });
    expect(notSent(ctx.writes)).toEqual([]);
  });

  it('a household row queued before rows carried a stream is held by its key', async () => {
    const ctx = queueDb(false, { 'scheduledNotifications/o1': row('invoice.overdue', { stream: undefined }) });
    expect(await drainScheduledNotifications(NOW + HOUR)).toEqual({ promoted: 0, held: 1 });
    expect(queuedRows(ctx.docs)).toEqual([]);
  });

  it('a blast and a reminder held in the same run write a line each', async () => {
    const ctx = queueDb(false, {
      'scheduledNotifications/r1': row('invoice.reminder'),
      'scheduledNotifications/n1': row('newsletter.announcement', { data: { blastId: 'bl1' } }),
    });
    expect(await drainScheduledNotifications(NOW + HOUR)).toEqual({ promoted: 0, held: 2 });
    expect(notSent(ctx.writes).map((l) => l.description).sort()).toEqual([
      'Held back 1 invoice reminder: notices to households are turned off. It will not be sent later',
      'Held back 1 notice from a marketing blast: notices to households are turned off. It will not be sent later',
    ]);
  });
});
