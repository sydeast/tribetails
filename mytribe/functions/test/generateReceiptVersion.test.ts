import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: `generateReceipt` names each issue of a receipt by its version, so a
 * re-issued receipt is a new notification and a retry of one is not. The
 * dispatcher side of that claim is in notificationEventIdentities.test.ts; this
 * pins what the callable writes and sends.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveUid: vi.fn(), enqueue: vi.fn() }));
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

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
});

function req(invoiceId: string) {
  return { data: { invoiceId }, auth: { uid: 'admin1' } } as any;
}

describe('generateReceipt receipt version (#832)', () => {
  it('the first receipt is version 1, stored and named in the notification identity', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await generateReceiptHandler(req('inv1'));
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')?.data.receiptVersion).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'invoice:inv1:receipt:1' }));
  });

  it('a re-issue after an earlier one landed is the next version, so it sends', async () => {
    const ctx = buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1', receiptVersion: 2 } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await generateReceiptHandler(req('inv1'));
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')?.data.receiptVersion).toBe(3);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'invoice:inv1:receipt:3' }));
  });

  it('two presses that read before either wrote carry the same version, and so deliver once', async () => {
    for (let i = 0; i < 2; i += 1) {
      mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'invoices/inv1': { kinfolkId: 'fam1', receiptVersion: 1 } } }).db);
      await generateReceiptHandler(req('inv1'));
    }
    const keys = mocks.enqueue.mock.calls.map((c) => c[0].dedupeKey);
    expect(keys).toEqual(['invoice:inv1:receipt:2', 'invoice:inv1:receipt:2']);
  });
});
