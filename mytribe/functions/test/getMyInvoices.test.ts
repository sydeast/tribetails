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
      { lineId: 'session:vis_1', source: 'session', sessionId: 'vis_1', label: '30Minute', dateIso: '2026-07-01T10:00:00', amountCents: 2500, qty: null, unitCents: null },
      { lineId: 'session:vis_2', source: 'session', sessionId: 'vis_2', label: '2Hrs', dateIso: '2026-07-02', amountCents: 8000, qty: null, unitCents: null },
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
      lineId: 'session:vis_1',
      source: 'session',
      sessionId: 'vis_1',
      label: '30Minute',
      dateIso: '2026-07-01T10:00:00',
      amountCents: 2500,
      qty: null,
      unitCents: null,
    });
  });
  it('mapSessionToLineItem accepts older type/date/price fields', async () => {
    const { mapSessionToLineItem } = await import('../src/portal/getMyInvoices');
    expect(mapSessionToLineItem('vis_2', { type: '2Hrs', date: '2026-07-02', price: 80 })).toEqual({
      lineId: 'session:vis_2',
      source: 'session',
      sessionId: 'vis_2',
      label: '2Hrs',
      dateIso: '2026-07-02',
      amountCents: 8000,
      qty: null,
      unitCents: null,
    });
  });
  it('mapSessionToLineItem degrades gracefully on sparse docs', async () => {
    const { mapSessionToLineItem } = await import('../src/portal/getMyInvoices');
    expect(mapSessionToLineItem('vis_3', {})).toEqual({
      lineId: 'session:vis_3',
      source: 'session',
      sessionId: 'vis_3',
      label: 'Service',
      dateIso: null,
      amountCents: null,
      qty: null,
      unitCents: null,
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

describe('getMyInvoices renders a part-paid invoice honestly', () => {
  async function load(invoice: Record<string, unknown>) {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: { invoices: [{ id: 'inv1', data: { kinfolkId: '3', ...invoice } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    return getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
  }
  it('flags a part-paid invoice as NEITHER paid NOR untouched', async () => {
    // $20 collected against $40. Rendering this as "unpaid" hides the $20 the
    // household already sent; rendering it "paid" hides the $20 they still owe.
    const res = await load({ status: 'open', total: 40, amountDue: 20, paidCents: 2000 });
    const inv = res.open[0];
    expect(inv.partiallyPaid).toBe(true);
    expect(inv.isPaid).toBe(false);
    expect(inv.paidCents).toBe(2000);
    expect(inv.amountDue).toBe(20);
    // It stays in the open bucket, so it is still payable and still chased.
    expect(res.open).toHaveLength(1);
    expect(res.paid).toHaveLength(0);
  });
  it('does NOT flag an untouched open invoice', async () => {
    const res = await load({ status: 'open', total: 40, amountDue: 40 });
    expect(res.open[0].partiallyPaid).toBe(false);
    expect(res.open[0].paidCents).toBe(0);
  });
  it('does NOT flag a settled invoice', async () => {
    const res = await load({ status: 'paid', total: 40, amountDue: 0, paidCents: 4000 });
    expect(res.paid[0].partiallyPaid).toBe(false);
    expect(res.paid[0].isPaid).toBe(true);
  });
  it('reports 0 collected on an invoice predating the field, rather than inferring one', () => {
    // total - amountDue would report the WHOLE total as collected on exactly the
    // invoices the pre-fix write zeroed, which is the opposite of the truth.
    return load({ status: 'paid', total: 40, amountDue: 0 }).then((res) => {
      expect(res.paid[0].paidCents).toBe(0);
      expect(res.paid[0].partiallyPaid).toBe(false);
    });
  });
  it('never flags a credit as part-paid', async () => {
    const res = await load({ status: 'credit', total: -25, amountDue: -25, paidCents: 500 });
    expect(res.credits[0].partiallyPaid).toBe(false);
  });
  it('ignores a non-integer paidCents rather than laundering it onto the household screen', async () => {
    const res = await load({ status: 'open', total: 40, amountDue: 20, paidCents: 20.5 });
    expect(res.open[0].paidCents).toBe(0);
    expect(res.open[0].partiallyPaid).toBe(false);
  });
});
/**
 * THE INVOICE'S OWN LINES WIN.
 *
 * Until 2026-07-25 this callable ignored the stored `lineItems` and rebuilt a
 * list from `sessionIds`, so an itemized invoice showed the household a
 * different set of rows from the one the operator billed, priced off the session
 * (usually absent, so usually blank). These tests pin that the stored lines are
 * used, that the session path is a FALLBACK and not a supplement, and that a
 * malformed stored line is dropped rather than shown as a $0.00 charge.
 */
describe('getMyInvoices prefers the stored line items', () => {
  const LINES = [
    { description: 'Daily visit', qty: 3, unitCents: 2000 },
    { description: 'Extra dog', qty: 1, unitCents: 500, discountCents: 100 },
  ];
  async function load(invoice: Record<string, unknown>, sessions: Record<string, unknown> = {}) {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, ...sessions },
      queryDocs: { invoices: [{ id: 'inv1', data: { kinfolkId: '3', ...invoice } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    return res;
  }
  it('renders the stored lines, with the same arithmetic the server totals with', async () => {
    const res = await load({ invoiceStatus: 'open', amountDue: 64, total: 64, lineItems: LINES });
    expect(res.open[0].lineItems).toEqual([
      { lineId: 'stored:0', source: 'stored', sessionId: '', label: 'Daily visit', dateIso: null, amountCents: 6000, qty: 3, unitCents: 2000 },
      // 500 gross minus a 100 line discount. Rounded once at the line, exactly as
      // invoiceMath.ts#lineAmountCents does, or the breakdown would not add up to
      // the total printed under it.
      { lineId: 'stored:1', source: 'stored', sessionId: '', label: 'Extra dog', dateIso: null, amountCents: 400, qty: 1, unitCents: 500 },
    ]);
  });
  it('IGNORES sessionIds entirely when the invoice has its own lines', async () => {
    // The bug in one assertion: this invoice has both, and the household must
    // see what was billed, not a second list rebuilt from the visits.
    const res = await load(
      { invoiceStatus: 'open', amountDue: 64, total: 64, lineItems: LINES, sessionIds: ['vis_1'] },
      { 'kin_care_sessions/vis_1': { serviceType: '30Minute', startTime: '2026-07-01T10:00:00', rate: '25' } },
    );
    expect(res.open[0].lineItems?.every((l) => l.source === 'stored')).toBe(true);
    expect(res.open[0].lineItems).toHaveLength(2);
  });
  it('still falls back to sessions for a legacy invoice with no stored lines', async () => {
    // Every invoice predating the line-item editor. The fallback is the only
    // breakdown those will ever have, so it stays.
    const res = await load(
      { invoiceStatus: 'open', amountDue: 25, total: 25, sessionIds: ['vis_1'] },
      { 'kin_care_sessions/vis_1': { serviceType: '30Minute', startTime: '2026-07-01T10:00:00', rate: '25' } },
    );
    expect(res.open[0].lineItems).toEqual([
      { lineId: 'session:vis_1', source: 'session', sessionId: 'vis_1', label: '30Minute', dateIso: '2026-07-01T10:00:00', amountCents: 2500, qty: null, unitCents: null },
    ]);
  });
  it('gives every row a key that is unique within the invoice', async () => {
    // Keying on sessionId collapsed every stored row onto one empty key, which
    // is a rendering bug the server can prevent rather than hope about.
    const res = await load({ invoiceStatus: 'open', amountDue: 64, total: 64, lineItems: LINES });
    const ids = (res.open[0].lineItems ?? []).map((l) => l.lineId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
describe('storedLineItemsFrom', () => {
  it('drops a malformed line rather than billing the household $0.00 for it', async () => {
    // `firestore.rules` grants `allow update: if isAuntie()` over the whole
    // collection and postInvoiceEvent merges an arbitrary payload, so neither
    // the presence nor the shape of this array is guaranteed.
    const { storedLineItemsFrom } = await import('../src/portal/getMyInvoices');
    expect(
      storedLineItemsFrom([
        { description: 'Good', qty: 1, unitCents: 100 },
        { description: '', qty: 1, unitCents: 100 },
        { description: 'No qty', qty: 0, unitCents: 100 },
        { description: 'Float cents', qty: 1, unitCents: 10.5 },
        { description: 'Negative discount', qty: 1, unitCents: 100, discountCents: -5 },
        null,
        'not an object',
      ]),
    ).toEqual([{ description: 'Good', qty: 1, unitCents: 100, discountCents: 0 }]);
  });
  it('reads a missing or non-array field as no lines', async () => {
    const { storedLineItemsFrom } = await import('../src/portal/getMyInvoices');
    expect(storedLineItemsFrom(undefined)).toEqual([]);
    expect(storedLineItemsFrom({})).toEqual([]);
    expect(storedLineItemsFrom('lineItems')).toEqual([]);
  });
  it('caps the list so one bad doc cannot build an unbounded response', async () => {
    const { storedLineItemsFrom, MAX_LINE_ITEM_SESSIONS } = await import('../src/portal/getMyInvoices');
    const many = Array.from({ length: 60 }, (_, i) => ({ description: `L${i}`, qty: 1, unitCents: 100 }));
    expect(storedLineItemsFrom(many)).toHaveLength(MAX_LINE_ITEM_SESSIONS);
  });
});
