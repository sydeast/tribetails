import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: `generateReceipt` over the REAL dispatcher. A receipt is named by what
 * it receipts (the total and the payments), so:
 *   - a retry after the first press committed receipts the same payments and
 *     is deduped (the counter this replaced read one higher and sent again);
 *   - a receipt after a new payment landed is a different receipt and sends.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));

import { generateReceiptHandler, receiptDedupeKey } from '../src/admin/generateReceipt';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function press() {
  return generateReceiptHandler({ data: { invoiceId: 'inv1' }, auth: { uid: 'admin1' } } as never);
}

function receipts(writes: Array<{ path: string; data: Record<string, unknown> }>) {
  return writes.filter(
    (w) => w.path.startsWith('notifications/') && w.data.key === 'invoice.receipt' && w.data.recipientUid === 'kin-uid-1',
  );
}

describe('generateReceipt names a receipt by what it receipts (#832)', () => {
  it('a retry after the first press committed does not send a second receipt', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: {
        'invoices/inv1': { kinfolkId: 'fam1', totalCents: 4000 },
        'invoices/inv1/payments/p1': { amountCents: 4000 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await press();
    vi.setSystemTime(NOW + 20_000);
    await press();

    expect(receipts(ctx.writes)).toHaveLength(1);
  });

  it('a receipt issued after a new payment landed sends', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: {
        'invoices/inv1': { kinfolkId: 'fam1', totalCents: 4000 },
        'invoices/inv1/payments/p1': { amountCents: 2000 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await press();
    await ctx.db.collection('invoices').doc('inv1').collection('payments').doc('p2').set({ amountCents: 2000 });
    vi.setSystemTime(NOW + 60_000);
    await press();

    expect(receipts(ctx.writes)).toHaveLength(2);
  });

  it('the key ignores payment order and changes with the paid amount or the payment set', () => {
    const one = receiptDedupeKey('inv1', { totalCents: 4000 }, [
      { id: 'p1', data: { amountCents: 2000 } as never },
      { id: 'p2', data: { amountCents: 2000 } as never },
    ]);
    const reordered = receiptDedupeKey('inv1', { totalCents: 4000 }, [
      { id: 'p2', data: { amountCents: 2000 } as never },
      { id: 'p1', data: { amountCents: 2000 } as never },
    ]);
    const fewer = receiptDedupeKey('inv1', { totalCents: 4000 }, [{ id: 'p1', data: { amountCents: 2000 } as never }]);
    expect(reordered).toBe(one);
    expect(fewer).not.toBe(one);
  });
});
