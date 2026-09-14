import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: `postInvoiceEvent` over the REAL dispatcher.
 *
 * The review case: an invoice goes out, and minutes later the office corrects
 * the amount. The household must get the correction, and so must the office
 * copy (invoice.updated has businessAdmins as its secondary resolver). A retry
 * of that same correction must not send it twice.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));

import { postInvoiceEventHandler } from '../src/admin/postInvoiceEvent';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

function call(payload: Record<string, unknown>) {
  return { data: { familyId: 'fam1', invoiceId: 'inv1', payload }, auth: { uid: 'admin-uid' } } as any;
}

function sent(writes: Array<{ path: string; data: Record<string, unknown> }>, key: string, recipientUid: string) {
  return writes.filter(
    (w) => w.path.startsWith('notifications/') && w.data.key === key && w.data.recipientUid === recipientUid,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('postInvoiceEvent over the real dispatcher', () => {
  it('an amount correction two minutes after the invoice went out reaches the household and the office', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'businessSettings/admins': { uids: ['admin1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await postInvoiceEventHandler(call({ invoiceNumber: '1042', total: 40, amountDue: 40, dueDate: '2026-10-01' }));
    vi.setSystemTime(NOW + 2 * 60_000);
    await postInvoiceEventHandler(call({ total: 55, amountDue: 55 }));

    expect(sent(ctx.writes, 'invoice.new', 'kin-uid-1')).toHaveLength(1);
    expect(sent(ctx.writes, 'invoice.updated', 'kin-uid-1')).toHaveLength(1);
    expect(sent(ctx.writes, 'invoice.updated', 'admin1')).toHaveLength(1);
  });

  it('a second, different correction inside the window sends too; a retry of it does not', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': { kinfolkId: 'fam1', invoiceNumber: '1042', total: 40, amountDue: 40 } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await postInvoiceEventHandler(call({ total: 55, amountDue: 55 }));
    vi.setSystemTime(NOW + 60_000);
    await postInvoiceEventHandler(call({ dueDate: '2026-11-01' }));
    expect(sent(ctx.writes, 'invoice.updated', 'kin-uid-1')).toHaveLength(2);

    // The retry of the due-date fix read the invoice BEFORE its first attempt
    // committed, so the unchanged check passes it; the content identity does not.
    await ctx.db.collection('invoices').doc('inv1').set(
      { kinfolkId: 'fam1', invoiceNumber: '1042', total: 55, amountDue: 55 },
    );
    vi.setSystemTime(NOW + 90_000);
    await postInvoiceEventHandler(call({ dueDate: '2026-11-01' }));
    expect(sent(ctx.writes, 'invoice.updated', 'kin-uid-1')).toHaveLength(2);
  });
});
