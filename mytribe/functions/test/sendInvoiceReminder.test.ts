import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { sendInvoiceReminderHandler } from '../src/admin/sendInvoiceReminder';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(invoice: Record<string, unknown> | null = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', dueDate: '2026-07-01' }) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice } });
}

describe('sendInvoiceReminder happy path', () => {
  it('enqueues invoice.reminder to the resolved kinfolk uid and returns ok', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, invoiceId: 'inv1' });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.reminder', recipientUid: 'kin-uid-1' }),
    );
  });

  it('stamps reminderNotifiedAtMs for cron idempotency parity', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(write?.data.reminderNotifiedAtMs).toBeTypeOf('number');
  });

  it('writes a BILLING_REMINDER_SENT audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_REMINDER_SENT', targetUid: 'inv1', familyId: 'fam1' }),
    );
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

  it('fails loud (does NOT swallow) when dispatch throws', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(sendInvoiceReminderHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');
  });
});
