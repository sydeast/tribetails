import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotificationDetailed: mocks.enqueue }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { INVOICE_REMINDER_RESEND_WINDOW_MS, sendInvoiceReminderHandler } from '../src/admin/sendInvoiceReminder';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue({ written: ['n1'], suppressed: [] });
  (writeAuditEntry as any).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(invoice: Record<string, unknown> | null = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', dueDate: '2026-07-01' }) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice }, writeThrough: true });
}

describe('sendInvoiceReminder happy path', () => {
  it('enqueues invoice.reminder to the resolved kinfolk uid and says it sent', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({
      ok: true,
      invoiceId: 'inv1',
      sent: true,
      lastReminderAtMs: NOW,
      nextReminderAllowedAtMs: NOW + INVOICE_REMINDER_RESEND_WINDOW_MS,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.reminder', recipientUid: 'kin-uid-1' }),
    );
  });

  it('stamps reminderNotifiedAtMs for cron idempotency parity', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(write?.data.reminderNotifiedAtMs).toBe(NOW);
  });

  it('writes a BILLING_REMINDER_SENT audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_REMINDER_SENT', targetUid: 'inv1', familyId: 'fam1' }),
    );
  });

  it('sends when the last reminder is older than the window', async () => {
    const earlier = NOW - INVOICE_REMINDER_RESEND_WINDOW_MS;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: earlier });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(res.sent).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('sendInvoiceReminder refuses a duplicate (#832)', () => {
  it('reads reminderNotifiedAtMs back: a reminder inside the window is refused with when it went out', async () => {
    const earlier = NOW - 60 * 60 * 1000;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: earlier });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));

    expect(res).toEqual({
      ok: true,
      invoiceId: 'inv1',
      sent: false,
      lastReminderAtMs: earlier,
      nextReminderAllowedAtMs: earlier + INVOICE_REMINDER_RESEND_WINDOW_MS,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    // The earlier stamp is left exactly as it was.
    expect(ctx.writes.some((w) => w.path === 'invoices/inv1')).toBe(false);
  });

  it('two presses in a row send one reminder', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    vi.setSystemTime(NOW + 2_000);
    const second = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));

    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.lastReminderAtMs).toBe(NOW);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a stamp written by the daily cron blocks a manual press the same day', async () => {
    const cronRan = NOW - 6 * 60 * 60 * 1000;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: cronRan });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(res.sent).toBe(false);
    expect(res.lastReminderAtMs).toBe(cronRan);
  });

  it('makes the check and the claim in one transaction, before dispatching', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    let stampWhenDispatched: unknown;
    mocks.enqueue.mockImplementation(async () => {
      stampWhenDispatched = (await ctx.db.collection('invoices').doc('inv1').get()).data()?.reminderNotifiedAtMs;
      return { written: ['n1'], suppressed: [] };
    });
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(ctx.db.runTransaction).toHaveBeenCalled();
    expect(stampWhenDispatched).toBe(NOW);
  });

  it('when the dispatcher refuses a duplicate the stamp did not know about, reports it and records that time', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const dispatcherSaw = NOW - 90_000;
    mocks.enqueue.mockResolvedValue({
      written: [],
      suppressed: [{ recipientUid: 'kin-uid-1', reason: 'duplicate', existingId: 'sched-1', lastAtMs: dispatcherSaw }],
    });

    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));

    expect(res.sent).toBe(false);
    expect(res.lastReminderAtMs).toBe(dispatcherSaw);
    expect(writeAuditEntry).not.toHaveBeenCalled();
    const last = ctx.writes.filter((w) => w.path === 'invoices/inv1').at(-1);
    expect(last?.data.reminderNotifiedAtMs).toBe(dispatcherSaw);
  });
});

describe('sendInvoiceReminder validation + sad paths', () => {
  it('rejects blank invoiceId (invalid-argument)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(sendInvoiceReminderHandler(req({ invoiceId: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing invoice (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects already-paid invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'paid' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects invoice with no kinfolkId (failed-precondition)', async () => {
    const ctx = seed({ invoiceNumber: 'INV-9' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('fails loud (does NOT swallow) when dispatch throws, and releases the claim so a retry can send', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');

    const last = ctx.writes.filter((w) => w.path === 'invoices/inv1').at(-1);
    expect(last?.data.reminderNotifiedAtMs).toBeNull();

    const retry = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(retry.sent).toBe(true);
  });

  it('releasing the claim restores an older stamp rather than blanking it', async () => {
    const old = NOW - 3 * INVOICE_REMINDER_RESEND_WINDOW_MS;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: old });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');
    const last = ctx.writes.filter((w) => w.path === 'invoices/inv1').at(-1);
    expect(last?.data.reminderNotifiedAtMs).toBe(old);
  });
});
