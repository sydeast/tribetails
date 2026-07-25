import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));

import { repairInvoicePaymentsHandler } from '../src/admin/repairInvoicePayments';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** A $40 invoice reading paid with $0 due, over a subcollection recording $20. */
const CORRUPT = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'paid', amountDue: 0, total: 40 };
/** A $40 invoice genuinely paid off. */
const HEALTHY = { kinfolkId: 'fam2', invoiceNumber: 'INV-10', status: 'paid', amountDue: 0, total: 40 };

function seed(
  invoices: Array<{ id: string; data: Record<string, unknown> }>,
  paymentsByInvoice: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {},
) {
  const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {
    invoices,
  };
  for (const [invoiceId, payments] of Object.entries(paymentsByInvoice)) {
    queryDocs[`invoices/${invoiceId}/payments`] = payments;
  }
  return buildDbMock({ queryDocs });
}

describe('repairInvoicePayments: detect mode', () => {
  it('DEFAULTS TO DETECT and writes nothing at all', async () => {
    // The destructive mode has to be asked for by name. A tool that mutates a
    // billing collection on its default setting is one misclick from an
    // unreviewed mass write.
    const ctx = seed([{ id: 'inv1', data: CORRUPT }], { inv1: [{ id: 'p1', data: { amount: 20 } }] });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({}));

    expect(res.mode).toBe('detect');
    expect(res.findings).toHaveLength(1);
    expect(res.repaired).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports the before and after figures so the operator can review before repairing', async () => {
    const ctx = seed([{ id: 'inv1', data: CORRUPT }], { inv1: [{ id: 'p1', data: { amount: 20 } }] });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({ mode: 'detect' }));

    expect(res.findings[0]).toMatchObject({
      invoiceId: 'inv1',
      invoiceNumber: 'INV-9',
      kinfolkId: 'fam1',
      totalCents: 4000,
      paidCents: 2000,
      claimedAmountDueCents: 0,
      correctAmountDueCents: 2000,
      understatedCents: 2000,
    });
  });

  it('counts why each untouched invoice was untouched, so a clean run is not a silent one', async () => {
    const ctx = seed(
      [
        { id: 'inv1', data: HEALTHY },
        { id: 'inv2', data: { status: 'open', amountDue: 40, total: 40 } },
      ],
      { inv1: [{ id: 'p1', data: { amount: 40 } }] },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({}));

    expect(res.findings).toHaveLength(0);
    expect(res.skipped.payments_cover_total).toBe(1);
    expect(res.skipped.no_payments).toBe(1);
  });

  it('audits the read-only pass too, since it sweeps every household billing record', async () => {
    const ctx = seed([{ id: 'inv1', data: CORRUPT }], { inv1: [{ id: 'p1', data: { amount: 20 } }] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await repairInvoicePaymentsHandler(req({}));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ mode: 'detect', found: 1 }) }),
    );
  });
});

describe('repairInvoicePayments: repair mode', () => {
  it('FIXES A CORRUPT FIXTURE, restoring the balance the payments imply', async () => {
    const ctx = seed([{ id: 'inv1', data: CORRUPT }], { inv1: [{ id: 'p1', data: { amount: 20 } }] });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.repaired).toBe(1);
    const w = ctx.writes.find((x) => x.path === 'invoices/inv1')!;
    expect(w.data.status).toBe('open');
    expect(w.data.amountDue).toBe(20);
    expect(w.data.amountDueCents).toBe(2000);
    expect(w.data.paidCents).toBe(2000);
    expect(w.merge).toBe(true);
  });

  it('IS A NO-OP ON A HEALTHY FIXTURE', async () => {
    const ctx = seed(
      [
        { id: 'inv1', data: HEALTHY },
        { id: 'inv2', data: { status: 'open', amountDue: 40, total: 40 } },
      ],
      { inv1: [{ id: 'p1', data: { amount: 40 } }] },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.repaired).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('IS IDEMPOTENT: re-running against the repaired doc changes nothing', async () => {
    const first = seed([{ id: 'inv1', data: CORRUPT }], { inv1: [{ id: 'p1', data: { amount: 20 } }] });
    mocks.dbFn.mockReturnValue(first.db);
    await repairInvoicePaymentsHandler(req({ mode: 'repair' }));
    const repairedDoc = { ...CORRUPT, ...first.writes.find((x) => x.path === 'invoices/inv1')!.data };

    const second = seed([{ id: 'inv1', data: repairedDoc }], { inv1: [{ id: 'p1', data: { amount: 20 } }] });
    mocks.dbFn.mockReturnValue(second.db);
    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.repaired).toBe(0);
    expect(res.skipped.balance_already_correct).toBe(1);
    expect(second.writes).toHaveLength(0);
  });

  it('NEVER LOWERS A BALANCE, even when the arithmetic disagrees the other way', async () => {
    // The doc claims $40 owed; the payments say $20. Correcting downward would
    // forgive $20 of a real debt on unreviewed arithmetic, so it declines.
    const ctx = seed(
      [{ id: 'inv1', data: { status: 'open', amountDue: 40, total: 40 } }],
      { inv1: [{ id: 'p1', data: { amount: 20 } }] },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.repaired).toBe(0);
    expect(res.skipped.would_lower_balance).toBe(1);
    expect(ctx.writes).toHaveLength(0);
  });

  it('repairs only the corrupt rows in a mixed page', async () => {
    const ctx = seed(
      [
        { id: 'inv1', data: CORRUPT },
        { id: 'inv2', data: HEALTHY },
        { id: 'inv3', data: { status: 'open', amountDue: 40, total: 40 } },
      ],
      {
        inv1: [{ id: 'p1', data: { amount: 20 } }],
        inv2: [{ id: 'p2', data: { amount: 40 } }],
      },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.scanned).toBe(3);
    expect(res.repaired).toBe(1);
    expect(ctx.writes.map((w) => w.path)).toEqual(['invoices/inv1']);
  });
});

describe('repairInvoicePayments: paging and gating', () => {
  it('reports a null cursor when the page is short, so the operator knows to stop', async () => {
    const ctx = seed([{ id: 'inv1', data: HEALTHY }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await repairInvoicePaymentsHandler(req({ limit: 200 }));
    expect(res.nextCursor).toBeNull();
  });

  it('returns a resume cursor when the page came back full', async () => {
    const ctx = seed([
      { id: 'inv1', data: HEALTHY },
      { id: 'inv2', data: HEALTHY },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await repairInvoicePaymentsHandler(req({ limit: 2 }));
    expect(res.nextCursor).toBe('inv2');
  });

  it('refuses an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(repairInvoicePaymentsHandler(req({}, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses an unknown mode rather than guessing at it', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(repairInvoicePaymentsHandler(req({ mode: 'delete' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('refuses a limit beyond the cap', async () => {
    mocks.dbFn.mockReturnValue(seed([]).db);
    await expect(repairInvoicePaymentsHandler(req({ limit: 5000 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});
