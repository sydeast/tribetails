import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832, re-aimed by #906: `postInvoiceEvent` over the REAL dispatcher.
 *
 * The original review case was an amount correction minutes after the invoice
 * went out: the household and the office copy both had to hear it once, and a
 * retry had to stay silent. #906 took the arbitrary merge away, so an amount
 * correction is no longer this callable's to make — `updateInvoice` owns it,
 * and this path REFUSES the payload rather than sending about it.
 *
 * What is left to prove over the real dispatcher is the one payload that
 * survived: the draft send reaches the household AND the office copy exactly
 * once, a repeat is refused rather than deduped (a stronger guarantee than
 * #832's content comparison, which a field no template rendered could defeat),
 * and a refused payload writes no notification at all.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));

import { postInvoiceEventHandler } from '../src/admin/postInvoiceEvent';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const DRAFT = { kinfolkId: 'fam1', status: 'draft', invoiceNumber: '1042', total: 40, amountDue: 40 };

function call(payload: unknown) {
  return { data: { familyId: 'fam1', invoiceId: 'inv1', payload }, auth: { uid: 'admin-uid' } } as any;
}

function sent(writes: Array<{ path: string; data: Record<string, unknown> }>, key: string, recipientUid: string) {
  return writes.filter(
    (w) => w.path.startsWith('notifications/') && w.data.key === key && w.data.recipientUid === recipientUid,
  );
}

function seed() {
  const ctx = buildDbMock({
    writeThrough: true,
    docs: { 'invoices/inv1': { ...DRAFT }, 'businessSettings/admins': { uids: ['admin1'] } },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('postInvoiceEvent over the real dispatcher', () => {
  it('the draft send reaches the household and the office copy, once each', async () => {
    const ctx = seed();
    await postInvoiceEventHandler(call({ status: 'sent' }));
    expect(sent(ctx.writes, 'invoice.new', 'kin-uid-1')).toHaveLength(1);
    expect(sent(ctx.writes, 'invoice.new', 'admin1')).toHaveLength(1);
  });

  it('a repeat two minutes later is REFUSED, and nothing goes out a second time', async () => {
    const ctx = seed();
    await postInvoiceEventHandler(call({ status: 'sent' }));
    vi.setSystemTime(NOW + 2 * 60_000);
    await expect(postInvoiceEventHandler(call({ status: 'sent' }))).rejects.toThrow(/not a draft/);
    expect(sent(ctx.writes, 'invoice.new', 'kin-uid-1')).toHaveLength(1);
    expect(sent(ctx.writes, 'invoice.new', 'admin1')).toHaveLength(1);
  });

  it('the amount correction this callable used to make writes no notification at all', async () => {
    const ctx = seed();
    await expect(postInvoiceEventHandler(call({ total: 55, amountDue: 55 }))).rejects.toThrow(
      /updateInvoice/,
    );
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toHaveLength(0);
    expect(ctx.writes.filter((w) => w.path === 'invoices/inv1')).toHaveLength(0);
  });

  it('a payload that would have marked it paid writes no notification and no invoice change', async () => {
    const ctx = seed();
    await expect(postInvoiceEventHandler(call({ status: 'paid', amountDue: 0 }))).rejects.toThrow(
      /markInvoicePaid/,
    );
    expect(ctx.writes.filter((w) => w.path.startsWith('notifications/'))).toHaveLength(0);
    expect(ctx.writes.filter((w) => w.path === 'invoices/inv1')).toHaveLength(0);
  });
});
