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

import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';
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

function seed(invoice: Record<string, unknown> | null = {
  kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 40, amountDue: 40,
}) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice } });
}

describe('reviewAndSendDraftInvoice happy path', () => {
  it('flips DRAFT -> open on both status fields and returns ok', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, invoiceId: 'inv1' });
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(write?.data.status).toBe('open');
    expect(write?.data.invoiceStatus).toBe('open');
    expect(write?.data.sentBy).toBe('admin1');
  });

  it('enqueues invoice.new to the resolved kinfolk uid', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.new', recipientUid: 'kin-uid-1' }),
    );
  });

  it('writes a BILLING_DRAFT_INVOICE_SENT audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_DRAFT_INVOICE_SENT', targetUid: 'inv1', familyId: 'fam1' }),
    );
  });
});

describe('reviewAndSendDraftInvoice validation + sad paths', () => {
  it('rejects blank invoiceId (invalid-argument)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing invoice (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects a non-draft invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a draft with no total (failed-precondition, names what is missing)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'draft', total: 0 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('total'),
    });
  });

  it('rejects a draft with no household (failed-precondition)', async () => {
    const ctx = seed({ invoiceNumber: 'INV-9', status: 'draft', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('household'),
    });
  });

  it('rejects a draft with no invoice number (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'draft', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('invoice number'),
    });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('fails loud (does NOT swallow, does NOT flip status) when dispatch throws', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    await expect(reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }))).rejects.toThrow('boom');
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')).toBeUndefined();
  });
});
