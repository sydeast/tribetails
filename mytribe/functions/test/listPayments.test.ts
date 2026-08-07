import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import { listPaymentsHandler, type ListPaymentsResult } from '../src/admin/listPayments';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

/** A staff caller. `admin: true` is what `isStaff` reads. */
function req(
  data: unknown,
  token: Record<string, unknown> = { admin: true },
  uid: string | null = 'admin1',
) {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(rootPayments: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { payments: rootPayments } });
}

function run(data: unknown = {}, token?: Record<string, unknown>) {
  return listPaymentsHandler(req(data, token));
}

/** The one row a test cares about, by id. Fails loudly rather than returning undefined. */
function rowById(res: ListPaymentsResult, id: string) {
  const found = res.payments.find((p) => p.paymentId === id);
  expect(found, `no row '${id}' in the response`).toBeDefined();
  return found!;
}

describe('listPayments — the four storage conventions the root collection carries', () => {
  // These four shapes ALL exist in production simultaneously. The whole reason
  // this callable exists is that a client reading `amount` raw cannot tell them
  // apart, so every case below asserts a CENTS VALUE, not a shape.
  it('reads a stripe-event row as ALREADY CENTS, never multiplying by 100', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-stripe', data: { amount: 13750, amountSource: 'stripe-event', amountResolved: true } },
      ]).db,
    );

    const res = await run();
    // The 100x defect in one assertion: $137.50, not $13,750.00.
    expect(rowById(res, 'p-stripe').amountCents).toBe(13750);
    expect(rowById(res, 'p-stripe').amountResolved).toBe(true);
  });

  it('reads a local-invoice fallback row as DOLLARS', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-local', data: { amount: 30, amountSource: 'local-invoice', amountResolved: true } },
      ]).db,
    );

    const res = await run();
    expect(rowById(res, 'p-local').amountCents).toBe(3000);
    expect(rowById(res, 'p-local').amountResolved).toBe(true);
  });

  it('reads a row with NO amountSource marker at all as dollars', async () => {
    // Every `recordPayment.ts` row and every pre-webhook legacy row. The marker
    // has never been written by that path, so absence means "the only convention
    // a marker-less row can mean", not "unknown".
    mocks.dbFn.mockReturnValue(seed([{ id: 'p-bare', data: { amount: 45.5 } }]).db);

    const res = await run();
    expect(rowById(res, 'p-bare').amountCents).toBe(4550);
    expect(rowById(res, 'p-bare').amountResolved).toBe(true);
  });

  it('lets a backfilled amountCents beat a bogus amount on the same row', async () => {
    // 29a's backfill stamps `amountCents`; the ambiguous `amount` is left alone
    // on purpose (payment code is never "cleaned up"). The stamped figure wins.
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-backfilled', data: { amount: 1, amountCents: 13750, amountSource: 'stripe-event' } },
      ]).db,
    );

    const res = await run();
    expect(rowById(res, 'p-backfilled').amountCents).toBe(13750);
  });
});

describe('listPayments — fail loud, never fake', () => {
  it('reports an unresolved row as unresolved and does NOT guess a number', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-bad', data: { amount: null, amountSource: 'unresolved', amountResolved: false } },
        { id: 'p-ok', data: { amount: 12, amountSource: 'local-invoice' } },
      ]).db,
    );

    const res = await run();
    const bad = rowById(res, 'p-bad');
    // 0 is the CentsSchema floor, not a claim that nothing was collected —
    // which is exactly why the row carries the flag beside it.
    expect(bad.amountCents).toBe(0);
    expect(bad.amountResolved).toBe(false);
    expect(rowById(res, 'p-ok').amountResolved).toBe(true);
    expect(res.unresolvedAmountCount).toBe(1);
  });

  it('fires exactly one warn log for the page, not one per unresolved row', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-bad1', data: { amountSource: 'unresolved' } },
        { id: 'p-bad2', data: { amount: 'not a number', amountSource: 'stripe-event' } },
      ]).db,
    );

    const res = await run();
    expect(res.unresolvedAmountCount).toBe(2);
    const warns = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.severity === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      function: 'listPayments',
      event: 'payments.amount.unresolved',
      extra: { unresolvedAmountCount: 2 },
    });
  });

  it('fires no warn log when every row resolved', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'p1', data: { amount: 10 } }]).db);

    const res = await run();
    expect(res.unresolvedAmountCount).toBe(0);
    expect(mocks.logEventFn.mock.calls.map((c) => c[0]).filter((e: any) => e.severity === 'warn')).toHaveLength(0);
  });
});

describe('listPayments — bounding, and saying so', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      // Zero-padded so document-id order is also insertion order, which is what
      // makes the paging assertions below readable.
      id: `p${String(i).padStart(3, '0')}`,
      data: { amount: i + 1 },
    }));

  it('returns the whole collection unTRUNCATED when it fits inside the limit', async () => {
    mocks.dbFn.mockReturnValue(seed(many(3)).db);

    const res = await run({ limit: 3 });
    expect(res.payments.map((p) => p.paymentId)).toEqual(['p000', 'p001', 'p002']);
    expect(res.truncated).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it('says TRUNCATED and hands back a cursor when there is more', async () => {
    // The defect this callable must not reproduce: `unlinkedKinfolkPayments`
    // bounds its read and the response has no field that can say so, so a short
    // list is indistinguishable from a complete one.
    mocks.dbFn.mockReturnValue(seed(many(5)).db);

    const res = await run({ limit: 2 });
    expect(res.payments.map((p) => p.paymentId)).toEqual(['p000', 'p001']);
    expect(res.truncated).toBe(true);
    expect(res.nextCursor).toBe('p001');
  });

  it('pages the rest of the collection through the cursor, ending truthfully', async () => {
    mocks.dbFn.mockReturnValue(seed(many(5)).db);

    const page2 = await run({ limit: 2, startAfterId: 'p001' });
    expect(page2.payments.map((p) => p.paymentId)).toEqual(['p002', 'p003']);
    expect(page2.truncated).toBe(true);

    const page3 = await run({ limit: 2, startAfterId: page2.nextCursor });
    expect(page3.payments.map((p) => p.paymentId)).toEqual(['p004']);
    expect(page3.truncated).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it('keeps truncated and nextCursor from ever disagreeing', async () => {
    // Two fields that can contradict each other are their own defect: a client
    // that trusts one and not the other is right half the time.
    for (const [total, limit] of [[0, 5], [5, 5], [6, 5], [1, 1], [2, 1]] as const) {
      mocks.dbFn.mockReturnValue(seed(many(total)).db);
      const res = await run({ limit });
      expect(res.truncated, `total=${total} limit=${limit}`).toBe(res.nextCursor !== null);
      expect(res.payments.length).toBeLessThanOrEqual(limit);
    }
  });

  it('returns an empty page rather than throwing when the collection is empty', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);

    const res = await run();
    expect(res.payments).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.nextCursor).toBeNull();
  });
});

describe('listPayments — the request shape', () => {
  it('refuses an unknown argument rather than ignoring it', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(run({ kinfolkId: 'fam1' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a limit outside the page bounds', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(run({ limit: 0 })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ limit: 501 })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ limit: 2.5 })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a blank cursor rather than silently paging from the start', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(run({ startAfterId: '' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('listPayments — the gate', () => {
  it('refuses an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(listPaymentsHandler(req({}, {}, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses a signed-in caller who is neither staff nor a sandbox test admin', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(run({}, {})).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('SCOPES a sandbox test admin to their own household and nobody else', async () => {
    // The highest-stakes line in the handler. Without the scoping clause a
    // sandbox token would receive every household's payments — a wider read
    // than `firestore.rules` grants the same token directly.
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-sandbox', data: { kinfolkId: 'sandbox1', amount: 10 } },
        { id: 'p-live', data: { kinfolkId: 'fam1', amount: 20 } },
        { id: 'p-nokinfolk', data: { amount: 30 } },
      ]).db,
    );

    const res = await run({}, { testTribeId: 'sandbox1' });
    expect(res.payments.map((p) => p.paymentId)).toEqual(['p-sandbox']);
    expect(res.payments[0]!.amountCents).toBe(1000);
  });

  it('gives staff every household, unscoped', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p-a', data: { kinfolkId: 'fam1', amount: 10 } },
        { id: 'p-b', data: { kinfolkId: 'fam2', amount: 20 } },
      ]).db,
    );

    const res = await run();
    expect(res.payments.map((p) => p.paymentId)).toEqual(['p-a', 'p-b']);
  });
});

describe('listPayments — what a row carries', () => {
  it('projects a recordPayment row whole, in cents, with the household named', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        {
          id: 'p1',
          data: {
            kinfolkId: 'fam1',
            kinfolkName: 'The Alvarez Tribe',
            amount: 137.5,
            amountCents: 13750,
            tip: 10,
            tipCents: 1000,
            fee: 2.71,
            feeCents: 271,
            tipBasis: 'gross',
            appliedCents: 12750,
            autoApply: true,
            invoiceId: 'inv1',
            invoiceNumber: '1029',
            appliedInvoiceId: 'inv1',
            appliedInvoiceNumber: '1029',
            paymentMethod: 'venmo',
            referenceNumber: '#881',
            date: 'February 17, 2026',
            notes: 'left on the porch',
            recordedBy: 'admin1',
          },
        },
      ]).db,
    );

    const res = await run();
    expect(res.payments).toEqual([
      {
        paymentId: 'p1',
        kinfolkId: 'fam1',
        kinfolkName: 'The Alvarez Tribe',
        amountCents: 13750,
        amountResolved: true,
        tipCents: 1000,
        feeCents: 271,
        tipBasis: 'gross',
        reconciles: true,
        appliedCents: 12750,
        // 13750 - 12750 - 1000
        unappliedCents: 0,
        // 13750 - 271
        proceedsCents: 13479,
        autoApply: true,
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        appliedInvoiceId: 'inv1',
        appliedInvoiceNumber: '1029',
        method: 'venmo',
        reference: '#881',
        date: 'February 17, 2026',
        notes: 'left on the porch',
        recordedBy: 'admin1',
      },
    ]);
  });

  it('says a legacy tip of unknown basis does not reconcile, rather than printing figures that do not add up', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'p1', data: { amount: 137.5, tip: 7.29 } }]).db);

    const res = await run();
    expect(res.payments[0]!.tipBasis).toBe('unknown');
    expect(res.payments[0]!.reconciles).toBe(false);
  });

  it('renders a stripe row with a Timestamp date as a BLANK date, exactly as getInvoiceLedger does', async () => {
    // `stripeWebhook.ts` writes `date: serverTimestamp()`; `recordPayment.ts`
    // writes free text. The two readers of this collection must not disagree
    // about the same field, so this one reads it the same way: strings only.
    mocks.dbFn.mockReturnValue(
      seed([{ id: 'p1', data: { amount: 100, amountSource: 'stripe-event', date: new Date('2026-07-20') } }]).db,
    );

    const res = await run();
    expect(res.payments[0]!.date).toBe('');
  });

  it('reports a missing signature as null and a missing text field as an empty string', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'p1', data: { amount: 10 } }]).db);

    const res = await run();
    expect(res.payments[0]!.recordedBy).toBeNull();
    expect(res.payments[0]!.kinfolkName).toBe('');
    expect(res.payments[0]!.invoiceNumber).toBe('');
    expect(res.payments[0]!.notes).toBe('');
  });
});

describe('listPayments — the read log', () => {
  it('records what the page actually returned, including whether it was bounded', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'p1', data: { amount: 10 } },
        { id: 'p2', data: { amount: 20 } },
      ]).db,
    );

    await run({ limit: 1 });
    const infos = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.severity === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      function: 'listPayments',
      event: 'admin.payments.listRead',
      extra: { returned: 1, truncated: true, testMode: false },
    });
  });
});
