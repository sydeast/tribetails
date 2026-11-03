import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
  // #1511: what the dispatcher did to each recipient's copy (see recordPayment.test.ts).
  appOnlyUids: vi.fn<() => string[]>(),
  suppressed: vi.fn<() => Array<{ recipientUid: string; reason: 'duplicate' | 'prefs' | 'gate' }>>(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
// `contentDedupeKey` stays real (#832): it names the receipt, and a stub that
// returned undefined would make the enqueue throw and this suite test nothing.
// #1511: the handler reads the detailed outcome. One counted mock answers both
// entry points, so every assertion below on `enqueue` still holds.
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  return {
    contentDedupeKey: actual.contentDedupeKey,
    enqueueNotification: mocks.enqueue,
    enqueueNotificationDetailed: async (args: unknown) => ({
      written: ((await mocks.enqueue(args)) as string[] | undefined) ?? [],
      suppressed: mocks.suppressed(),
      unresolved: [],
      appOnly: mocks.appOnlyUids(),
    }),
  };
});
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
  mocks.appOnlyUids.mockReset().mockReturnValue([]);
  mocks.suppressed.mockReset().mockReturnValue([]);
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
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'invoice.receipt', recipientUid: 'kin-uid-1' }),
    );
    // #1511: a channel carried the household's copy.
    expect(res).toEqual({ ok: true, appOnly: false });
  });

  it('still returns ok when notification dispatch fails', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValueOnce(new Error('boom'));
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    // #1511: no record was written, so the answer makes no claim about one.
    expect(res).toEqual({ ok: true });
  });

  // ── #1511: the receipt notice that reached the household in the app only ──
  it('#1511 every channel off for the household: appOnly true', async () => {
    mocks.appOnlyUids.mockReturnValue(['kin-uid-1']);
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true, appOnly: true });
  });

  it('#1511 no portal account: nothing reached the household, so appOnly is omitted', async () => {
    mocks.resolveUid.mockResolvedValue(null);
    mocks.appOnlyUids.mockReturnValue(['office-uid']);
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true });
  });

  it('#1511 a repeat press the ledger deduped wrote nothing new, so appOnly is omitted', async () => {
    mocks.enqueue.mockResolvedValue([]);
    mocks.suppressed.mockReturnValue([{ recipientUid: 'kin-uid-1', reason: 'duplicate' }]);
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await generateReceiptHandler(req({ invoiceId: 'inv1' }));
    expect(res).toEqual({ ok: true });
  });
});
