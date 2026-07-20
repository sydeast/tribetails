import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(invoice: Record<string, unknown> | null = {
  kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40,
}) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice } });
}

describe('markInvoicePaid happy path', () => {
  it('flips the invoice to paid + zeroes amountDue and returns a paymentId', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    expect(res.invoiceId).toBe('inv1');
    expect(res.paymentId).toBeTruthy();
    const invoiceWrite = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(invoiceWrite?.data.status).toBe('paid');
    expect(invoiceWrite?.data.amountDue).toBe(0);
    expect(invoiceWrite?.data.paidBy).toBe('admin1');
  });

  it('writes a payments subcollection entry with method/reference/paidAt/recordedBy', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', method: 'check', reference: 'CK-100', amount: 40 }));
    const paymentWrite = ctx.writes.find((w) => w.path.startsWith('invoices/inv1/payments/'));
    expect(paymentWrite).toBeTruthy();
    expect(paymentWrite!.data.amount).toBe(40);
    expect(paymentWrite!.data.method).toBe('check');
    expect(paymentWrite!.data.reference).toBe('CK-100');
    expect(paymentWrite!.data.recordedBy).toBe('admin1');
    expect(paymentWrite!.data.paidAt).toBeTypeOf('string');
  });

  it('defaults the payment amount to the invoice amountDue when omitted', async () => {
    const ctx = seed({ kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 25, total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1' }));
    const paymentWrite = ctx.writes.find((w) => w.path.startsWith('invoices/inv1/payments/'));
    expect(paymentWrite!.data.amount).toBe(25);
  });

  it('writes a BILLING_INVOICE_PAID audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', method: 'cash' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_INVOICE_PAID', targetUid: 'inv1', familyId: 'fam1' }),
    );
  });
});

describe('markInvoicePaid validation + sad paths', () => {
  it('rejects blank invoiceId (invalid-argument)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing invoice (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an already-paid invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'paid', amountDue: 0 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a draft invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'draft', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a quote invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'QUOTE', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
