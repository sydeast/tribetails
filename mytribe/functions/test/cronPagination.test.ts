import { describe, it, expect, vi, beforeEach } from 'vitest';

// WARNING-25: reminder/digest crons must NOT silently cap at one `.limit(N)`
// page. These tests drive the exported scan runners against a PAGED
// collection-group mock that hands out N>pageSize docs across multiple
// startAfter() pages, and assert every doc is processed (none past the cap is
// dropped). A separate test forces the safety ceiling and asserts a CRITICAL
// cap log is emitted (fail-loud), not a silent stop.
//
// Roster: invoiceRemindersCron (both scans), kincareReminderCron and
// scheduleDigestCron are covered here. The fourth WARNING-25 cron,
// rotateOldFcmTokens, is covered in test/rotateOldFcmTokens.test.ts instead:
// it drains a flat `collection()` rather than a collectionGroup and batches its
// deletes, so it needs a different db mock than pagedDbMock below.

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  enqueueDetailed: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: mocks.enqueueDetailed,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import {
  OVERDUE_SUPPRESSED_RETRY_MS,
  runInvoiceRemindersScan,
  runInvoiceOverdueScan,
} from '../src/scheduled/invoiceRemindersCron';
import { runKincareReminderScan } from '../src/scheduled/kincareReminderCron';
import { runScheduleDigestScan } from '../src/scheduled/scheduleDigestCron';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.enqueueDetailed.mockReset().mockResolvedValue({ written: ['n1'], suppressed: [] });
  mocks.logEvent.mockReset();
});

type Row = { id: string; data: Record<string, unknown> };

/**
 * Builds a collectionGroup mock whose pages honour `.limit(pageSize)` +
 * `.startAfter(lastDoc)` so the runner's pagination is genuinely exercised.
 * Records every `set()` write so we can assert the notified stamp on each doc.
 *
 * `settings` backs the single `doc('business_settings/business_settings')` read
 * `runKincareReminderScan` makes before it drains anything (#519's
 * `enableAutoReminder24h` gate). It defaults to `{}` — a document with no such
 * key, which is every document in production — so every pre-existing case in
 * this file keeps asserting the reminders it always asserted.
 */
function pagedDbMock(rows: Row[], settings: Record<string, unknown> = {}) {
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];

  function makeDocSnap(row: Row) {
    // Bookings are genuinely nested (families/{fam}/bookings/{id}), so the
    // kincare cron legitimately reads familyId off ref.parent.parent. Invoices
    // are NOT nested (O-14: flat top-level `invoices` collection) — this
    // fam-${id} stand-in is a red herring there and invoiceRemindersCron.ts
    // correctly ignores it, reading the stamped `kinfolkId` field instead.
    const ref: any = {
      id: row.id,
      parent: { parent: { id: `fam-${row.id}` } },
      set: vi.fn(async (data: Record<string, unknown>) => {
        writes.push({ id: row.id, data });
      }),
    };
    return { id: row.id, data: () => row.data, ref };
  }

  function makeQuery(startId: string | null, limit: number | null): any {
    let startIndex = 0;
    if (startId) {
      const i = rows.findIndex((r) => r.id === startId);
      startIndex = i < 0 ? rows.length : i + 1;
    }
    const slice = limit == null ? rows.slice(startIndex) : rows.slice(startIndex, startIndex + limit);
    const q: any = {
      where: vi.fn(() => makeQuery(startId, limit)),
      orderBy: vi.fn(() => makeQuery(startId, limit)),
      limit: vi.fn((n: number) => makeQuery(startId, n)),
      startAfter: vi.fn((cursor: any) => makeQuery(cursor.id, limit)),
      get: vi.fn(async () => ({ docs: slice.map(makeDocSnap) })),
    };
    return q;
  }

  const db = {
    collectionGroup: vi.fn(() => makeQuery(null, null)),
    // #871: the invoice scans read the top-level collection.
    collection: vi.fn(() => makeQuery(null, null)),
    doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => settings })) })),
  };
  return { db, writes };
}

describe('WARNING-25: invoice reminder cron paginates past the cap', () => {
  it('processes EVERY due invoice across multiple pages (none dropped past .limit)', async () => {
    const now = 1_000_000_000_000;
    const dueSoon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    // 1200 docs > a single 500-page; all unpaid, due within the window.
    const rows: Row[] = Array.from({ length: 1200 }, (_, i) => ({
      id: `inv${String(i).padStart(4, '0')}`,
      data: { status: 'open', amountDue: 100, dueDate: dueSoon, kinfolkId: `fam-inv${String(i).padStart(4, '0')}` },
    }));
    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const reminded = await runInvoiceRemindersScan(now);

    expect(reminded).toBe(1200);
    expect(mocks.enqueueDetailed).toHaveBeenCalledTimes(1200);
    // Every doc got its idempotency stamp written.
    expect(ctx.writes).toHaveLength(1200);
    // No cap log — we drained cleanly below the safety ceiling.
    expect(
      mocks.logEvent.mock.calls.some((c) => c[0]?.event === 'cron.pagination.cap-hit'),
    ).toBe(false);
  });

  it('#832: stamps only a reminder that went out; prefs suppression leaves the invoice unstamped', async () => {
    const now = 1_000_000_000_000;
    const dueSoon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const ctx = pagedDbMock([
      { id: 'inv-muted', data: { status: 'open', amountDue: 100, dueDate: dueSoon, kinfolkId: 'fam-muted' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueueDetailed.mockResolvedValue({ written: [], suppressed: [{ recipientUid: 'kin-uid', reason: 'prefs' }] });

    const reminded = await runInvoiceRemindersScan(now);

    expect(reminded).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('#832: a duplicate of a button send is stamped with THAT send time, never the cron run time', async () => {
    const now = 1_000_000_000_000;
    const buttonSentAt = now - 90_000;
    const dueSoon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const ctx = pagedDbMock([
      { id: 'inv-pressed', data: { status: 'open', amountDue: 100, dueDate: dueSoon, kinfolkId: 'fam-pressed' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueueDetailed.mockResolvedValue({
      written: [],
      suppressed: [{ recipientUid: 'kin-uid', reason: 'duplicate', existingId: 's1', lastAtMs: buttonSentAt }],
    });

    const reminded = await runInvoiceRemindersScan(now);

    expect(reminded).toBe(0);
    expect(ctx.writes).toEqual([{ id: 'inv-pressed', data: { reminderNotifiedAtMs: buttonSentAt } }]);
    // It looks back the button's whole window, not the dispatcher's 5 minutes.
    expect(mocks.enqueueDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.reminder', dedupeWindowMs: 24 * 60 * 60 * 1000 }),
    );
  });

  it('#832: a reminder that went out is stamped with this run time', async () => {
    const now = 1_000_000_000_000;
    const dueSoon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const ctx = pagedDbMock([
      { id: 'inv-sent', data: { status: 'open', amountDue: 100, dueDate: dueSoon, kinfolkId: 'fam-sent' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    expect(await runInvoiceRemindersScan(now)).toBe(1);
    expect(ctx.writes).toEqual([{ id: 'inv-sent', data: { reminderNotifiedAtMs: now } }]);
  });

  it('overdue scan also drains every past-due invoice across pages', async () => {
    const now = 1_000_000_000_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const rows: Row[] = Array.from({ length: 700 }, (_, i) => ({
      id: `ov${String(i).padStart(4, '0')}`,
      data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: `fam-ov${String(i).padStart(4, '0')}` },
    }));
    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const notified = await runInvoiceOverdueScan(now);
    expect(notified).toBe(700);
    expect(mocks.enqueueDetailed).toHaveBeenCalledTimes(700);
  });

  it('#832: an overdue notice that went out is stamped with this run time', async () => {
    const now = 1_000_000_000_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const ctx = pagedDbMock([
      { id: 'ov-sent', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-sent' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    expect(await runInvoiceOverdueScan(now)).toBe(1);
    expect(ctx.writes).toEqual([{ id: 'ov-sent', data: { overdueNotifiedAtMs: now } }]);
  });

  it('#871: a duplicate of an earlier run whose stamp did not land is stamped with THAT send time, never the run time', async () => {
    const now = 1_000_000_000_000;
    const triggerSentAt = now - 120_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const ctx = pagedDbMock([
      { id: 'ov-dup', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-dup' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueueDetailed.mockResolvedValue({
      written: [],
      suppressed: [{ recipientUid: 'kin-uid', reason: 'duplicate', existingId: 'n0', lastAtMs: triggerSentAt }],
    });

    expect(await runInvoiceOverdueScan(now)).toBe(0);
    expect(ctx.writes).toEqual([{ id: 'ov-dup', data: { overdueNotifiedAtMs: triggerSentAt } }]);
  });

  it('#832: an operator-override suppression writes no notified stamp, records the suppression, and skips the invoice until the next daily run', async () => {
    // `invoice.overdue` has required email, so only an operator override can
    // produce this outcome; the dispatcher reports it as `prefs` either way.
    const now = 1_000_000_000_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    mocks.enqueueDetailed.mockResolvedValue({ written: [], suppressed: [{ recipientUid: 'kin-uid', reason: 'prefs' }] });

    // The run that meets the suppression.
    const first = pagedDbMock([
      { id: 'ov-muted', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-muted' } },
    ]);
    mocks.dbFn.mockReturnValue(first.db);
    expect(await runInvoiceOverdueScan(now)).toBe(0);
    expect(first.writes).toEqual([{ id: 'ov-muted', data: { overdueSuppressedAtMs: now } }]);

    // Later the same day: not re-attempted, nothing logged or written.
    mocks.enqueueDetailed.mockClear();
    const sameDay = pagedDbMock([
      { id: 'ov-muted', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-muted', overdueSuppressedAtMs: now } },
    ]);
    mocks.dbFn.mockReturnValue(sameDay.db);
    expect(await runInvoiceOverdueScan(now + OVERDUE_SUPPRESSED_RETRY_MS - 1)).toBe(0);
    expect(mocks.enqueueDetailed).not.toHaveBeenCalled();
    expect(sameDay.writes).toHaveLength(0);

    // The next daily run lands 23 hours later (the spring-forward day, or a run
    // that starts early). The operator has turned the notice back on: it must
    // send and stamp, not wait out another whole day.
    mocks.enqueueDetailed.mockResolvedValue({ written: ['n1'], suppressed: [] });
    const nextDay = pagedDbMock([
      { id: 'ov-muted', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-muted', overdueSuppressedAtMs: now } },
    ]);
    mocks.dbFn.mockReturnValue(nextDay.db);
    const later = now + 23 * 60 * 60 * 1000;
    expect(await runInvoiceOverdueScan(later)).toBe(1);
    expect(nextDay.writes).toEqual([{ id: 'ov-muted', data: { overdueNotifiedAtMs: later } }]);
  });

  it('#832: the suppression wait is shorter than the 24-hour run period', () => {
    expect(OVERDUE_SUPPRESSED_RETRY_MS).toBeLessThan(23 * 60 * 60 * 1000);
  });

  it('O-14 regression: familyId comes from the stamped kinfolkId field, not ref.parent.parent (always null on flat invoices docs)', async () => {
    const now = 1_000_000_000_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const rows: Row[] = [
      { id: 'ov-linked', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-linked' } },
      { id: 'ov-orphan', data: { status: 'open', amountDue: 100, dueDate: pastDue } },
    ];
    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const notified = await runInvoiceOverdueScan(now);

    expect(notified).toBe(1);
    expect(mocks.resolveUid).toHaveBeenCalledWith('fam-linked');
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.writes[0]?.id).toBe('ov-linked');
  });

  it('O-14 regression: due date comes from the stamped `dueDate` field (what createInvoice.ts actually writes), not the never-written `invoiceDueDate`', async () => {
    const now = 1_000_000_000_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const rows: Row[] = [
      // Real production shape: `dueDate`, no `invoiceDueDate` at all.
      { id: 'ov-real-shape', data: { status: 'open', amountDue: 100, dueDate: pastDue, kinfolkId: 'fam-real' } },
    ];
    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const notified = await runInvoiceOverdueScan(now);

    expect(notified).toBe(1);
    expect(ctx.writes).toHaveLength(1);
  });

  it('O-14 regression: an invoice with amountDue<=0 is treated as paid (no status/paymentStatus field set) and skipped', async () => {
    const now = 1_000_000_000_000;
    // #871: two days back. One day back is the business's own today in Chicago
    // for this `now`, and due today is due, not overdue.
    const pastDue = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const rows: Row[] = [
      { id: 'ov-paid-via-amount', data: { amountDue: 0, dueDate: pastDue, kinfolkId: 'fam-paid' } },
    ];
    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const notified = await runInvoiceOverdueScan(now);

    expect(notified).toBe(0);
    expect(mocks.enqueueDetailed).not.toHaveBeenCalled();
  });
});

describe('WARNING-25: kincare reminder cron paginates past the cap', () => {
  it('processes every confirmed/approved booking in the 24-48h window across pages, skipping non-matching statuses in memory', async () => {
    const now = 1_000_000_000_000;
    const startMs = now + 36 * 60 * 60 * 1000; // inside 24-48h

    // 800 confirmed + 400 approved = 1200 actionable; interspersed with 200
    // "pending" docs to prove the in-memory status filter skips them. The
    // scan receives ALL 1400 docs from the unfiltered collectionGroup query.
    const rows: Row[] = Array.from({ length: 1400 }, (_, i) => {
      const status =
        i % 7 === 0 ? 'pending' : i % 3 === 0 ? 'approved' : 'confirmed';
      return {
        id: `bk${String(i).padStart(4, '0')}`,
        data: { status, startTime: { toMillis: () => startMs } },
      };
    });
    const expectedReminded = rows.filter(
      (r) => r.data['status'] === 'confirmed' || r.data['status'] === 'approved',
    ).length;

    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const reminded = await runKincareReminderScan(now);
    expect(reminded).toBe(expectedReminded);
    // The scan reads the outcome now, so it calls the detailed entrypoint:
    // `upcomingReminderNotifiedAtMs` may only be stamped for a reminder that
    // really went out. See kincareReminderCron.processUpcomingBooking.
    expect(mocks.enqueueDetailed).toHaveBeenCalledTimes(expectedReminded);
    // Pending docs must NOT have triggered a notification write.
    const pendingIds = new Set(
      rows.filter((r) => r.data['status'] === 'pending').map((r) => r.id),
    );
    expect(ctx.writes.some((w) => pendingIds.has(w.id))).toBe(false);
  });
});

describe('WARNING-25: safety ceiling fails LOUD (CRITICAL cap log)', () => {
  it('emits a critical cron.pagination.cap-hit log when the page ceiling is hit', async () => {
    const { paginateQuery } = await import('../src/lib/paginateCollectionGroup');
    const now = 1_000_000_000_000;
    const dueSoon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    // 30 docs with pageSize 2 + safetyMaxPages 3 => stops after 6 docs, logs cap.
    const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
      id: `c${String(i).padStart(3, '0')}`,
      data: { status: 'unpaid', invoiceDueDate: dueSoon },
    }));
    const ctx = pagedDbMock(rows);

    let processed = 0;
    const total = await paginateQuery(
      ctx.db.collectionGroup() as any,
      () => {
        processed += 1;
      },
      { pageSize: 2, safetyMaxPages: 3, functionName: 'invoiceRemindersCron' },
    );

    expect(total).toBe(6); // 3 pages * 2 docs, then stopped
    expect(processed).toBe(6);
    const capLog = mocks.logEvent.mock.calls.find((c) => c[0]?.event === 'cron.pagination.cap-hit');
    expect(capLog).toBeDefined();
    expect(capLog?.[0]?.severity).toBe('critical');
    expect(capLog?.[0]?.function).toBe('invoiceRemindersCron');
  });
});

describe('WARNING-25: schedule digest cron paginates past the cap', () => {
  it('collects every confirmed/approved booking in the next-24h window across pages, skipping out-of-window and non-matching statuses in memory', async () => {
    const now = 1_000_000_000_000;
    const inWindow = now + 6 * 60 * 60 * 1000; // 6h from now, inside 24h
    const pastStart = now - 2 * 60 * 60 * 1000; // already started, excluded
    const tooFar = now + 30 * 60 * 60 * 1000; // beyond 24h, excluded

    // 1400 docs through an unfiltered paged collection-group. Only confirmed/
    // approved AND in-window count. Interspersed pending + out-of-window docs
    // prove the in-memory filter, and 1400 > one 500-page proves pagination.
    const rows: Row[] = Array.from({ length: 1400 }, (_, i) => {
      const status = i % 7 === 0 ? 'pending' : i % 3 === 0 ? 'approved' : 'confirmed';
      const startMs = i % 5 === 0 ? tooFar : i % 5 === 1 ? pastStart : inWindow;
      return {
        id: `dg${String(i).padStart(4, '0')}`,
        data: { status, startTime: { toMillis: () => startMs } },
      };
    });
    const expected = rows.filter(
      (r) =>
        (r.data['status'] === 'confirmed' || r.data['status'] === 'approved') &&
        (r.data['startTime'] as { toMillis: () => number }).toMillis() === inWindow,
    );

    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const items = await runScheduleDigestScan(now);

    // Every in-window confirmed/approved booking present — none dropped past 1000.
    expect(items).toHaveLength(expected.length);
    expect(items.length).toBeGreaterThan(500); // genuinely spans multiple pages
    // Sorted ascending by startTimeMs.
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i].startTimeMs as number).toBeGreaterThanOrEqual(items[i - 1].startTimeMs as number);
    }
    // No silent cap.
    expect(
      mocks.logEvent.mock.calls.some((c) => c[0]?.event === 'cron.pagination.cap-hit'),
    ).toBe(false);
  });

  it('returns an empty digest when nothing falls in the window (no notification enqueued by the wrapper path)', async () => {
    const now = 1_000_000_000_000;
    const tooFar = now + 30 * 60 * 60 * 1000;
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      data: { status: 'confirmed', startTime: { toMillis: () => tooFar } },
    }));
    const ctx = pagedDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const items = await runScheduleDigestScan(now);
    expect(items).toHaveLength(0);
  });
});
