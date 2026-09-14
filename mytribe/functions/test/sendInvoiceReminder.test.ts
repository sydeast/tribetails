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
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

import {
  INVOICE_REMINDER_CLAIM_LEASE_MS,
  INVOICE_REMINDER_RESEND_WINDOW_MS,
  sendInvoiceReminderHandler,
} from '../src/admin/sendInvoiceReminder';
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

/** The invoice as stored right now. */
async function stored(ctx: ReturnType<typeof seed>): Promise<Record<string, unknown>> {
  return ((await ctx.db.collection('invoices').doc('inv1').get()).data() ?? {}) as Record<string, unknown>;
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
      reason: 'sent',
      lastReminderAtMs: NOW,
      nextReminderAllowedAtMs: NOW + INVOICE_REMINDER_RESEND_WINDOW_MS,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.reminder', recipientUid: 'kin-uid-1' }),
    );
  });

  it('stamps reminderNotifiedAtMs for cron idempotency parity, and clears its claim', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    const doc = await stored(ctx);
    expect(doc.reminderNotifiedAtMs).toBe(NOW);
    expect(doc.reminderClaimAtMs).toBe('__DELETE__');
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
      reason: 'recent',
      lastReminderAtMs: earlier,
      nextReminderAllowedAtMs: earlier + INVOICE_REMINDER_RESEND_WINDOW_MS,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(ctx.writes.some((w) => w.path === 'invoices/inv1')).toBe(false);
  });

  it('two presses in a row send one reminder', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    vi.setSystemTime(NOW + 2_000);
    const second = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));

    expect(first.sent).toBe(true);
    expect(second).toMatchObject({ sent: false, reason: 'recent', lastReminderAtMs: NOW });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a fractional stored stamp still answers with integer times, not a validation failure', async () => {
    const earlier = NOW - 60_000 + 0.5;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: earlier });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(res.sent).toBe(false);
    expect(res.lastReminderAtMs).toBe(Math.floor(earlier));
    expect(Number.isInteger(res.nextReminderAllowedAtMs)).toBe(true);
  });

  it('a stamp written by the daily cron blocks a manual press the same day', async () => {
    const cronRan = NOW - 6 * 60 * 60 * 1000;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: cronRan });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(res).toMatchObject({ sent: false, reason: 'recent', lastReminderAtMs: cronRan });
  });

  it('claims before dispatching, and does NOT write the stamp until the dispatch has succeeded', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    let docWhenDispatched: Record<string, unknown> = {};
    mocks.enqueue.mockImplementation(async () => {
      docWhenDispatched = await stored(ctx);
      return { written: ['n1'], suppressed: [] };
    });
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(ctx.db.runTransaction).toHaveBeenCalled();
    expect(docWhenDispatched.reminderClaimAtMs).toBe(NOW);
    expect(docWhenDispatched.reminderNotifiedAtMs).toBeUndefined();
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

    expect(res).toMatchObject({ sent: false, reason: 'recent', lastReminderAtMs: dispatcherSaw });
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect((await stored(ctx)).reminderNotifiedAtMs).toBe(dispatcherSaw);
  });
});

describe('sendInvoiceReminder claim is a lease (#832)', () => {
  it('a claim left by a crash between claim and send: refused as in progress, the stamp untouched, then works after the lease', async () => {
    // What a crashed call leaves behind: its claim, and no stamp, because the
    // stamp is only ever written after a send.
    const crashedAt = NOW - 60_000;
    const ctx = seed({ kinfolkId: 'fam1', reminderClaimAtMs: crashedAt });
    mocks.dbFn.mockReturnValue(ctx.db);

    const during = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(during).toEqual({
      ok: true,
      invoiceId: 'inv1',
      sent: false,
      reason: 'in-progress',
      // No reminder ever went out, and the answer never pretends one did.
      lastReminderAtMs: null,
      nextReminderAllowedAtMs: crashedAt + INVOICE_REMINDER_CLAIM_LEASE_MS,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect((await stored(ctx)).reminderNotifiedAtMs).toBeUndefined();

    vi.setSystemTime(crashedAt + INVOICE_REMINDER_CLAIM_LEASE_MS);
    const after = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(after).toMatchObject({ sent: true, reason: 'sent' });
    expect((await stored(ctx)).reminderNotifiedAtMs).toBe(crashedAt + INVOICE_REMINDER_CLAIM_LEASE_MS);
  });

  it('a throw resolving the household (after the claim) releases the claim and never stamps', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockRejectedValueOnce(new Error('kinfolk lookup down'));

    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('kinfolk lookup down');

    const doc = await stored(ctx);
    expect(doc.reminderClaimAtMs).toBe('__DELETE__');
    expect(doc.reminderNotifiedAtMs).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const retry = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(retry.sent).toBe(true);
  });

  it('fails loud (does NOT swallow) when dispatch throws, releases the claim, and keeps the older stamp', async () => {
    const old = NOW - 3 * INVOICE_REMINDER_RESEND_WINDOW_MS;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: old });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));

    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');

    const doc = await stored(ctx);
    expect(doc.reminderNotifiedAtMs).toBe(old);
    expect(doc.reminderClaimAtMs).toBe('__DELETE__');
    const retry = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(retry.sent).toBe(true);
  });

  it('a claim taken over after its lease is not cleared by the stale call finishing late', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    // While the first call is dispatching, its lease expires and a second press
    // takes the claim over.
    mocks.enqueue.mockImplementationOnce(async () => {
      await ctx.db.collection('invoices').doc('inv1').set({ reminderClaimAtMs: NOW + INVOICE_REMINDER_CLAIM_LEASE_MS }, { merge: true });
      return { written: ['n1'], suppressed: [] };
    });
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    const doc = await stored(ctx);
    expect(doc.reminderClaimAtMs).toBe(NOW + INVOICE_REMINDER_CLAIM_LEASE_MS);
    expect(doc.reminderNotifiedAtMs).toBe(NOW);
  });
});

describe('sendInvoiceReminder when prefs suppress every recipient (#832)', () => {
  it('answers suppressed, never sent, and writes no stamp and no audit', async () => {
    const earlier = NOW - 5 * INVOICE_REMINDER_RESEND_WINDOW_MS;
    const ctx = seed({ kinfolkId: 'fam1', reminderNotifiedAtMs: earlier });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockResolvedValue({ written: [], suppressed: [{ recipientUid: 'kin-uid-1', reason: 'prefs' }] });

    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));

    expect(res).toEqual({
      ok: true,
      invoiceId: 'inv1',
      sent: false,
      reason: 'suppressed',
      lastReminderAtMs: earlier,
      nextReminderAllowedAtMs: null,
    });
    const doc = await stored(ctx);
    expect(doc.reminderNotifiedAtMs).toBe(earlier);
    expect(doc.reminderClaimAtMs).toBe('__DELETE__');
    expect(writeAuditEntry).not.toHaveBeenCalled();
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
});
