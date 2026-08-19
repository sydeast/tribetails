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

  // MIGRATED (was "NEW RULE: missing amountDue routes invoice to OPEN, not
  // paid"): same doc, same bucket, different reasoning. The money heuristic
  // that used to place this doc is retired (ADR-0002 W2-5); an unstamped doc
  // now fail-softs to `open` so it stays VISIBLE, and is reported below.
  it('FAIL-SOFT: a doc with no stamp routes to OPEN, not paid', async () => {
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

  // MIGRATED (was "NEW RULE: negative amountDue (refund) routes to credits
  // bucket", which pinned the retired money heuristic): a credit reaches the
  // credits bucket by its STAMP now. The unstamped half of the old test lives
  // on in the fail-soft describe below, where the same negative-money doc
  // routes to open — re-deriving credit from the sign of the balance is
  // exactly the read-side classification ADR-0002 W2-5 retired.
  it('a STAMPED credit routes to the credits bucket, with its cents derived', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-credit', data: { kinfolkId: '3', status: 'credit', total: -50, amountDue: -50 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.credits).toHaveLength(1);
    expect(res.credits[0].creditAmountCents).toBe(5000);
    expect(res.open).toHaveLength(0);
  });

  // MIGRATED: the doc now carries the stamp its production twin would (the
  // old version relied on the retired money fallback to land in `paid`); the
  // string-numeric parsing this pins is unchanged.
  it('parses string-numeric amountDue / total', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'invoices': [{ id: 'i1', data: { kinfolkId: '3', status: 'paid', amountDue: '0', total: '315.00' } }],
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

/**
 * THE STORED STAMP IS THE STATUS (ADR-0002 W2-5).
 *
 * The 5-state `resolveStatus` money heuristic is retired: this handler ships
 * the doc's stamped `status` (all eight states) plus `editScope` verbatim, and
 * buckets by a table over that stored string. These pin the 8→3 table, the
 * stamp passthrough, and the fail-soft — which is string-only and NEVER a
 * re-derivation from amountDue/total.
 */
describe('getMyInvoices ships the stored state stamp', () => {
  async function load(invoices: Array<{ id: string; data: Record<string, unknown> }>) {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: { invoices: invoices.map((i) => ({ id: i.id, data: { kinfolkId: '3', ...i.data } })) },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    return getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
  }

  it('buckets all eight stamped states by the table: 4 open, 1 paid, 2 credits, cancelled nowhere', async () => {
    const res = await load([
      { id: 'i-open', data: { status: 'open', amountDue: 50, total: 50 } },
      { id: 'i-draft', data: { status: 'draft', total: 20 } },
      { id: 'i-quote', data: { status: 'quote', total: 80 } },
      { id: 'i-zero', data: { status: 'zero', amountDue: 0, total: 0 } },
      { id: 'i-paid', data: { status: 'paid', amountDue: 0, total: 40 } },
      { id: 'i-credit', data: { status: 'credit', amountDue: -25, total: -25 } },
      { id: 'i-redeemed', data: { status: 'redeemed', amountDue: -10, total: -10, creditRedeemedAt: 1_750_000_000_000 } },
      { id: 'i-cancelled', data: { status: 'cancelled', amountDue: 30, total: 30 } },
    ]);
    expect(res.open.map((i) => i.id).sort()).toEqual(['i-draft', 'i-open', 'i-quote', 'i-zero']);
    expect(res.paid.map((i) => i.id)).toEqual(['i-paid']);
    expect(res.credits.map((i) => i.id).sort()).toEqual(['i-credit', 'i-redeemed']);
    // Cancelled is EXCLUDED, not re-bucketed: the household is not shown a
    // bill that no longer stands.
    const everywhere = [...res.open, ...res.paid, ...res.credits].map((i) => i.id);
    expect(everywhere).not.toContain('i-cancelled');
  });

  it('ships `quote` verbatim, so no client can render it payable as `open`', async () => {
    // The retired fallback had no quote state, so a quote doc leaked out as
    // `open` and grew a Pay button. A quote is not a bill.
    const res = await load([{ id: 'q1', data: { status: 'quote', total: 80 } }]);
    expect(res.open[0].status).toBe('quote');
    expect(res.open[0].isPaid).toBe(false);
  });

  it('a redeemed credit keeps its credit fields (amount, redemption time)', async () => {
    const res = await load([
      { id: 'r1', data: { status: 'redeemed', amountDue: -10, total: -10, creditTarget: 'accountBalance', creditRedeemedAt: 1_750_000_000_000 } },
    ]);
    expect(res.credits[0].status).toBe('redeemed');
    expect(res.credits[0].creditAmountCents).toBe(1000);
    expect(res.credits[0].creditTarget).toBe('accountBalance');
    expect(res.credits[0].creditRedeemedAtMs).toBe(1_750_000_000_000);
  });

  it('ships the stored editScope, and null when the doc carries none', async () => {
    const res = await load([
      { id: 'e1', data: { status: 'open', amountDue: 50, total: 50, editScope: 'metadataOnly' } },
      { id: 'e2', data: { status: 'open', amountDue: 50, total: 50 } },
      { id: 'e3', data: { status: 'open', amountDue: 50, total: 50, editScope: 'EVERYTHING' } },
    ]);
    const byId = new Map(res.open.map((i) => [i.id, i]));
    expect(byId.get('e1')?.editScope).toBe('metadataOnly');
    // Absent and unrecognized both read null: the portal reports "no stored
    // scope" rather than inventing one.
    expect(byId.get('e2')?.editScope).toBeNull();
    expect(byId.get('e3')?.editScope).toBeNull();
  });

  it('FAIL-SOFT: an unstamped doc routes to open even when its money says credit', async () => {
    // The old heuristic read `amountDue < 0` as credit. Re-deriving state from
    // money on the read side is exactly the divergence ADR-0002 retired: an
    // unstamped doc stays VISIBLE (open bucket) and gets REPORTED, and the
    // write-side classifier is the only thing that may call it a credit.
    const res = await load([{ id: 'u1', data: { total: -50, amountDue: -50 } }]);
    expect(res.open.map((i) => i.id)).toEqual(['u1']);
    expect(res.credits).toHaveLength(0);
    expect(res.open[0].status).toBe('open');
  });

  it('reports unstamped docs once per call, aggregated, and stays silent when all are stamped', async () => {
    const { logEvent } = await import('../src/lib/logger');
    vi.mocked(logEvent).mockClear();
    await load([
      { id: 'ok', data: { status: 'paid', amountDue: 0, total: 40 } },
      { id: 'bad-1', data: { total: 10 } },
      { id: 'bad-2', data: { status: 'sent', total: 10 } },
    ]);
    const warns = vi.mocked(logEvent).mock.calls.filter((c) => c[0]?.event === 'portal.invoices.stampMissing');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ severity: 'warn', extra: expect.objectContaining({ count: 2, invoiceIds: ['bad-1', 'bad-2'] }) });

    vi.mocked(logEvent).mockClear();
    await load([{ id: 'ok', data: { status: 'paid', amountDue: 0, total: 40 } }]);
    expect(vi.mocked(logEvent).mock.calls.some((c) => c[0]?.event === 'portal.invoices.stampMissing')).toBe(false);
  });
});

describe('statusFromStamp', () => {
  it('reads each of the eight stamped states as itself', async () => {
    const { statusFromStamp } = await import('../src/portal/getMyInvoices');
    for (const s of ['quote', 'draft', 'cancelled', 'credit', 'redeemed', 'paid', 'zero', 'open']) {
      expect(statusFromStamp({ status: s })).toEqual({ status: s, stamped: true });
    }
  });
  it('normalizes case and whitespace, as every classifier in this codebase does', async () => {
    const { statusFromStamp } = await import('../src/portal/getMyInvoices');
    expect(statusFromStamp({ status: ' PAID ' })).toEqual({ status: 'paid', stamped: true });
  });
  it('falls back to the legacy `invoiceStatus` spelling the sandbox seeds still write', async () => {
    const { statusFromStamp } = await import('../src/portal/getMyInvoices');
    expect(statusFromStamp({ invoiceStatus: 'credit' })).toEqual({ status: 'credit', stamped: true });
    // The canonical field wins when both are present.
    expect(statusFromStamp({ status: 'paid', invoiceStatus: 'open' })).toEqual({ status: 'paid', stamped: true });
  });
  it('routes an absent or unrecognized string to open, unstamped — money is never consulted', async () => {
    const { statusFromStamp } = await import('../src/portal/getMyInvoices');
    expect(statusFromStamp({})).toEqual({ status: 'open', stamped: false });
    expect(statusFromStamp({ status: 'sent' })).toEqual({ status: 'open', stamped: false });
    expect(statusFromStamp({ status: 42 })).toEqual({ status: 'open', stamped: false });
    // A doc screaming "credit" through its money still reads open when the
    // string is unreadable: fail-soft is string-only by design (ADR-0002).
    expect(statusFromStamp({ status: '', amountDue: -50, total: -50 })).toEqual({ status: 'open', stamped: false });
  });
});

/**
 * ISSUE #409: payment options resolved PER INVOICE.
 *
 * `getMyHome` already carried a business-wide list. It cannot answer the
 * question this field answers, which is "what was THIS bill issued with",
 * and that question is the whole of what makes turning a method off safe.
 */
describe('getMyInvoices per-invoice payMethods (issue #409)', () => {
  it('resolves live settings for an invoice carrying no snapshot', async () => {
    // Every invoice issued before this shipped. Nothing is backfilled, and
    // this fallback is why nothing needs to be.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { venmoHandle: '@auntie' },
      },
      queryDocs: {
        invoices: [
          { id: 'inv-old', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 50, total: 50 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open[0].payMethods.map((m) => m.id)).toEqual(['stripe', 'venmo']);
  });

  it("prefers the invoice's own snapshot over settings that have since changed", async () => {
    // The operator turned Venmo off this morning. Last week's bill still
    // offers it; a bill issued today would not.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          venmoHandle: '@auntie',
          paymentOptions: { venmo: { enabled: false } },
        },
      },
      queryDocs: {
        invoices: [
          {
            id: 'inv-issued',
            data: {
              kinfolkId: '3',
              invoiceStatus: 'open',
              amountDue: 50,
              total: 50,
              payMethodSettingsSnapshot: {
                capturedAt: '2026-08-12T00:00:00.000Z',
                venmoHandle: '@auntie',
                paymentOptions: { venmo: { enabled: true } },
              },
            },
          },
          {
            id: 'inv-today',
            data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 50, total: 50 },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const byId = Object.fromEntries(res.open.map((i) => [i.id, i.payMethods.map((m) => m.id)]));
    expect(byId['inv-issued']).toEqual(['stripe', 'venmo']);
    expect(byId['inv-today']).toEqual(['stripe']);
  });

  it('carries the instructions kind, which the business-wide list withholds', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          paymentOptions: { cash: { enabled: true, instructions: 'Leave it with Auntie at pickup.' } },
        },
      },
      queryDocs: {
        invoices: [{ id: 'inv-1', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 50, total: 50 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open[0].payMethods.find((m) => m.id === 'cash')).toEqual({
      id: 'cash',
      label: 'Pay in cash',
      kind: 'instructions',
      url: null,
      instructions: 'Leave it with Auntie at pickup.',
    });
  });

  it('offers nothing on a settled invoice or a credit', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { venmoHandle: '@auntie' },
      },
      queryDocs: {
        invoices: [
          { id: 'inv-paid', data: { kinfolkId: '3', invoiceStatus: 'paid', amountDue: 0, total: 200 } },
          { id: 'inv-credit', data: { kinfolkId: '3', invoiceStatus: 'credit', amountDue: -25, total: 0 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.paid[0].payMethods).toEqual([]);
    expect(res.credits[0].payMethods).toEqual([]);
  });

  it('reads the integer cents field in preference to the dollars float', async () => {
    // The cents seam is real: this collection's `amountDue` is a legacy
    // dollars float while the resolver reads cents. An invoice whose float
    // was left at 0 by the pre-2026-07-25 partial-payment write still owes
    // money, and `amountDueCents` is the field that knows it.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { venmoHandle: '@auntie' },
      },
      queryDocs: {
        invoices: [
          {
            id: 'inv-centsonly',
            data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 0, amountDueCents: 2000, total: 50 },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open[0].payMethods.map((m) => m.id)).toEqual(['stripe', 'venmo']);
  });

  it('shows the bill without payment buttons when settings will not load', async () => {
    // A settings doc that fails to read is a reason to offer no buttons,
    // never a reason to hide a household's invoices.
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        invoices: [{ id: 'inv-1', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 50, total: 50 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.open).toHaveLength(1);
    expect(res.open[0].payMethods.map((m) => m.id)).toEqual(['stripe']);
  });

  it('never ships a processor fee to a household', async () => {
    // Standing ruling, asserted on the payload a kinfolk actually receives.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          venmoHandle: '@auntie',
          paymentOptions: { klarna: { enabled: true } },
        },
      },
      queryDocs: {
        invoices: [{ id: 'inv-1', data: { kinfolkId: '3', invoiceStatus: 'open', amountDue: 50, total: 50 } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyInvoicesHandler } = await import('../src/portal/getMyInvoices');
    const res = await getMyInvoicesHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(JSON.stringify(res)).not.toMatch(/feeBps|feeFixedCents/);
  });
});
