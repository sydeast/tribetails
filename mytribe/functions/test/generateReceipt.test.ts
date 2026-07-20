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

import { generateReceiptHandler } from '../src/admin/generateReceipt';
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

describe('generateReceipt', () => {
  it('throws not-found when the invoice doc is missing', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(generateReceiptHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects blank invoiceId via zod', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(generateReceiptHandler(req({ invoiceId: '' }))).rejects.toThrow();
  });

  it('sets receiptIssuedAt + receiptIssuedBy on an existing invoice', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: 'INV-001' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    const write = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(write).toBeTruthy();
    expect(write!.merge).toBe(true);
    expect(write!.data.receiptIssuedAt).toBe('__TS__');
    expect(write!.data.receiptIssuedBy).toBe('admin1');
  });

  it('writes a BILLING_RECEIPT_ISSUED audit entry', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_RECEIPT_ISSUED', familyId: 'fam1' }),
    );
  });

  it('enqueues invoice.receipt notification', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.receipt', recipientUid: 'kin-uid-1' }),
    );
  });

  it('still returns ok when notification dispatch fails', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
  });
});
