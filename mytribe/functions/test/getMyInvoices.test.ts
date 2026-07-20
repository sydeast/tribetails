import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

describe('getMyInvoicesHandler', () => {
  it('rejects unauth', async () => {
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    await expect(getMyInvoicesHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('splits open / paid / credit by explicit invoiceStatus', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { accountBalanceCents: 500 },
      },
      queryDocs: {
        'invoices': [
          { id: 'inv-open', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 50, total: 100, dueDate: '2026-09-01' } },
          { id: 'inv-paid', data: { kinfolkId: '3', invoiceStatus: 'paid', amountDue: 0, total: 200, date: '2026-08-01' } },
          { id: 'inv-credit', data: { kinfolkId: '3', invoiceStatus: 'credit', amountDue: -25, total: 0 } },
          { id: 'inv-draft', data: { kinfolkId: '3', invoiceStatus: 'draft' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open.map((i) => i.id).sort()).toEqual(['inv-draft', 'inv-open']);
    expect(res.paid.map((i) => i.id)).toEqual(['inv-paid']);
    expect(res.credits.map((i) => i.id)).toEqual(['inv-credit']);
    expect(res.accountBalanceCents).toBe(500);
  });

  it('NEW RULE: missing amountDue routes invoice to OPEN, not paid', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-noamt', data: { kinfolkId: '3', total: 100 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open).toHaveLength(1);
    expect(res.paid).toHaveLength(0);
  });

  it('NEW RULE: negative amountDue (refund) routes to credits bucket', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-credit', data: { kinfolkId: '3', total: -50, amountDue: -50 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.credits).toHaveLength(1);
    expect(res.credits[0].creditAmountCents).toBe(5000);
    expect(res.open).toHaveLength(0);
  });

  it('parses string-numeric amountDue / total', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'invoices': [{ id: 'i1', data: { kinfolkId: '3', amountDue: '0', total: '315.00' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.paid).toHaveLength(1);
    expect(res.paid[0].total).toBe(315);
    expect(res.paid[0].isPaid).toBe(true);
  });

  it('filters scope when caller does not own the invoice tribe', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    await expect(
      getMyInvoicesHandler({ data: { kinfolkId: '99' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('resolves lineItems from kin_care_sessions via sessionIds', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'kin_care_sessions/vis_1': { serviceType: '30Minute', startTime: '2026-07-01T10:00:00', rate: '25' },
        'kin_care_sessions/vis_2': { type: '2Hrs', date: '2026-07-02', price: 80 },
      },
      queryDocs: {
        invoices: [
          { id: 'inv-1', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 105, total: 105, sessionIds: ['vis_1', 'vis_2', 'vis_missing'] } },
          { id: 'inv-2', data: { kinfolkId: '3', invoiceStatus: 'paid', amountDue: 0, total: 50 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.open[0].lineItems).toEqual([
      { sessionId: 'vis_1', label: '30Minute', dateIso: '2026-07-01T10:00:00', amountCents: 2500 },
      { sessionId: 'vis_2', label: '2Hrs', dateIso: '2026-07-02', amountCents: 8000 },
    ]);
    // Invoice without sessionIds carries no lineItems field at all.
    expect(res.paid[0].lineItems).toBeUndefined();
  });

  it('returns invoices WITHOUT lineItems when the session lookup fails', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-1', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 25, total: 25, sessionIds: ['vis_1'] } }],
      },
    });
    ctx.db.getAll = vi.fn(async () => {
      throw new Error('firestore unavailable');
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.open).toHaveLength(1);
    expect(res.open[0].lineItems).toBeUndefined();
  });

  it('falls back to zero accountBalance when family doc absent', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: { invoices: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.accountBalanceCents).toBe(0);
    expect(res.open).toEqual([]);
    expect(res.paid).toEqual([]);
    expect(res.credits).toEqual([]);
  });
});
describe('invoice lineItem pure mappers', () => {
  it('mapSessionToLineItem maps the modern session shape (serviceType/startTime/rate)', async () => {
    const { mapSessionToLineItem } = await import('../src/portal/getMyInvoices');
    expect(mapSessionToLineItem('vis_1', { serviceType: '30Minute', startTime: '2026-07-01T10:00:00', rate: '25' })).toEqual({
      sessionId: 'vis_1',
      label: '30Minute',
      dateIso: '2026-07-01T10:00:00',
      amountCents: 2500,
    });
  });
  it('mapSessionToLineItem accepts older type/date/price fields', async () => {
    const { mapSessionToLineItem } = await import('../src/portal/getMyInvoices');
    expect(mapSessionToLineItem('vis_2', { type: '2Hrs', date: '2026-07-02', price: 80 })).toEqual({
      sessionId: 'vis_2',
      label: '2Hrs',
      dateIso: '2026-07-02',
      amountCents: 8000,
    });
  });
  it('mapSessionToLineItem degrades gracefully on sparse docs', async () => {
    const { mapSessionToLineItem } = await import('../src/portal/getMyInvoices');
    expect(mapSessionToLineItem('vis_3', {})).toEqual({
      sessionId: 'vis_3',
      label: 'Service',
      dateIso: null,
      amountCents: null,
    });
    expect(mapSessionToLineItem('vis_4', { rate: 'not-a-number' }).amountCents).toBeNull();
  });
  it('sessionIdsFrom filters non-strings and caps at 50 sessions per invoice', async () => {
    const { sessionIdsFrom, MAX_LINE_ITEM_SESSIONS } = await import('../src/portal/getMyInvoices');
    expect(sessionIdsFrom({})).toEqual([]);
    expect(sessionIdsFrom({ sessionIds: 'vis_1' })).toEqual([]);
    expect(sessionIdsFrom({ sessionIds: ['vis_1', 42, '', null, 'vis_2'] })).toEqual(['vis_1', 'vis_2']);
    const many = Array.from({ length: 60 }, (_, i) => `vis_${i}`);
    expect(sessionIdsFrom({ sessionIds: many })).toHaveLength(MAX_LINE_ITEM_SESSIONS);
  });
});
