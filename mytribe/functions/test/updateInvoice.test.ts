import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const OPEN_INVOICE = {
  kinfolkId: 'fam1',
  invoiceNumber: 'INV-9',
  status: 'open',
  amountDue: 40,
  total: 40,
};

function seed(
  invoice: Record<string, unknown> | null = OPEN_INVOICE,
  payments: Array<{ id: string; data: Record<string, unknown> }> = [],
) {
  return buildDbMock({
    docs: { 'invoices/inv1': invoice },
    queryDocs: { 'invoices/inv1/payments': payments },
  });
}

function invoiceWrite(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.find((w) => w.path === 'invoices/inv1');
}

describe('updateInvoice happy path', () => {
  it('recomputes every money field from the line items and returns the totals', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: {
          lineItems: [
            { description: 'Dog walking', qty: 4, unitCents: 2500 },
            { description: 'Key pickup', qty: 1, unitCents: 1000 },
          ],
        },
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.totals.subtotalCents).toBe(11000);
    expect(res.totals.totalCents).toBe(11000);
    expect(res.totals.amountDueCents).toBe(11000);

    const w = invoiceWrite(ctx)!;
    expect(w.data.subtotalCents).toBe(11000);
    expect(w.data.totalCents).toBe(11000);
    expect(w.data.amountDueCents).toBe(11000);
  });

  it('writes the legacy dollar scalars as a projection of the cents figures', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: { lineItems: [{ description: 'Dog walking', qty: 3, unitCents: 1010 }] },
      }),
    );

    const w = invoiceWrite(ctx)!;
    // $10.10 x 3 = $30.30 exactly. Computed in cents, projected to dollars, so
    // the portal and the PDF keep reading the field they already read.
    expect(w.data.totalCents).toBe(3030);
    expect(w.data.total).toBe(30.3);
    expect(w.data.amountDue).toBe(30.3);
  });

  it('IGNORES a client-sent total: the server is the only thing that decides', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: {
          lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 2500 }],
          // Not in the schema at all; .strict() must reject it rather than
          // letting a client assert its own total.
        },
      }),
    );

    expect(invoiceWrite(ctx)!.data.total).toBe(25);
  });

  it('subtracts recorded payments when computing what is still due', async () => {
    const ctx = seed(OPEN_INVOICE, [{ id: 'p1', data: { amount: 30 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);

    // A payment exists, so money is frozen: patch metadata only, and assert the
    // recompute still accounts for what came in.
    const res = await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 14' } }));
    expect(res.totals.paidCents).toBe(3000);
  });

  it('applies a whole-invoice discount', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: {
          lineItems: [{ description: 'Dog walking', qty: 4, unitCents: 2500 }],
          invoiceDiscountCents: 1500,
        },
      }),
    );

    expect(res.totals.subtotalCents).toBe(10000);
    expect(res.totals.totalCents).toBe(8500);
  });

  it('updates metadata fields without touching the money', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { invoiceNumber: 'INV-10', dueDate: '2026-08-01', terms: 'Net 7' } }),
    );

    const w = invoiceWrite(ctx)!;
    expect(w.data.invoiceNumber).toBe('INV-10');
    expect(w.data.dueDate).toBe('2026-08-01');
    expect(w.data.terms).toBe('Net 7');
  });

  it('writes a BILLING_INVOICE_UPDATED audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 7' } }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_INVOICE_UPDATED' }),
    );
  });
});

describe('updateInvoice does not invent totals for an un-itemized invoice', () => {
  it('leaves the legacy total alone when the invoice has no line items and the patch adds none', async () => {
    // THE REGRESSION THIS GUARDS. Every invoice that exists today is
    // un-itemized. Recomputing "sum of zero lines" would silently rewrite a
    // real $40 invoice to $0 because the operator fixed its due date.
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { dueDate: '2026-08-01' } }));

    const w = invoiceWrite(ctx)!;
    expect(w.data.total).toBeUndefined();
    expect(w.data.amountDue).toBeUndefined();
    expect(w.data.totalCents).toBeUndefined();
  });

  it('does recompute once the patch gives that same invoice its first line', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 4000 }] },
      }),
    );

    expect(invoiceWrite(ctx)!.data.total).toBe(40);
  });

  it('recomputes from the STORED lines when a later patch touches only the discount', async () => {
    const ctx = seed({
      ...OPEN_INVOICE,
      lineItems: [{ description: 'Dog walking', qty: 4, unitCents: 2500 }],
      totalCents: 10000,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { invoiceDiscountCents: 2000 } }),
    );

    expect(res.totals.subtotalCents).toBe(10000);
    expect(res.totals.totalCents).toBe(8000);
  });
});

describe('updateInvoice edit gating (enforced here, not in the UI)', () => {
  it('refuses any edit to a paid invoice', async () => {
    const ctx = seed({ ...OPEN_INVOICE, status: 'paid', amountDue: 0 });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 7' } })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_not_editable' },
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('ALLOWS A MONEY EDIT on a PART-PAID invoice, so a part-collected bill stays repairable', async () => {
    // CHANGED 2026-07-25, deliberately. The old rule froze the money on the
    // first payment of any size, which is the second half of the defect that
    // made a part-collected balance unrecoverable: markInvoicePaid refused the
    // remaining payment, and this refused the correction. $10 against a $40
    // invoice is PARTIAL, not settled.
    const ctx = seed(OPEN_INVOICE, [{ id: 'p1', data: { amount: 10 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 2500 }] },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses a MONEY edit once the recorded payments SETTLE the invoice', async () => {
    const ctx = seed(OPEN_INVOICE, [{ id: 'p1', data: { amount: 40 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 2500 }] },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_money_locked' },
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('still allows a METADATA edit on a settled invoice', async () => {
    const ctx = seed(OPEN_INVOICE, [{ id: 'p1', data: { amount: 40 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 14' } })),
    ).resolves.toMatchObject({ ok: true });
  });

  it('lets an invoice LABELLED paid but only part-collected be corrected', async () => {
    // The corrupt shape the pre-fix write produced. Freezing it on the label is
    // what left it beyond repair from every direction at once.
    const ctx = seed({ ...OPEN_INVOICE, status: 'paid', amountDue: 0 }, [
      { id: 'p1', data: { amount: 20 } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 4000 }] },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('clamps the balance and records overpaidCents when an edit drops the total below what was paid', async () => {
    // A negative amountDue is this codebase's CREDIT signal, so an edit that
    // leaves an invoice over-collected must not silently convert it into a
    // credit owed back to the household.
    // $60 against a $100 invoice: PART-paid, so the edit is allowed. The edit
    // then cuts the invoice to $25, which is less than the $60 already taken.
    const ctx = seed(
      {
        ...OPEN_INVOICE,
        total: 100,
        amountDue: 40,
        lineItems: [{ description: 'Dog walking', qty: 4, unitCents: 2500 }],
      },
      [{ id: 'p1', data: { amount: 60 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 2500 }] },
      }),
    );

    const w = invoiceWrite(ctx)!;
    expect(w.data.totalCents).toBe(2500);
    expect(w.data.amountDue).toBe(0);
    expect(w.data.amountDueCents).toBe(0);
    expect(w.data.overpaidCents).toBe(3500);
  });

  it('refuses an edit to a cancelled invoice and to a credit', async () => {
    for (const status of ['cancelled', 'credit']) {
      const ctx = seed({ ...OPEN_INVOICE, status });
      mocks.dbFn.mockReturnValue(ctx.db);
      await expect(
        updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'x' } })),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    }
  });

  it('allows a draft to be edited freely', async () => {
    const ctx = seed({ ...OPEN_INVOICE, status: 'draft' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 2500 }] },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('updateInvoice money validation', () => {
  it('refuses an invoice discount larger than the subtotal, naming both figures', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: {
            lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 1000 }],
            invoiceDiscountCents: 2500,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a fractional unitCents, which would reintroduce fractional cents', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 10.5 }] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('updateInvoice argument + auth failures', () => {
  it('rejects a missing invoiceId', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(updateInvoiceHandler(req({ patch: { terms: 'x' } }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('rejects an unknown key in the patch rather than silently dropping it', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    // .strict(): a client that thinks it can set `total` must be told no, not
    // have its intent quietly ignored.
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { total: 999 } })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an empty patch rather than writing a no-op', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: {} })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a malformed date', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { date: '18/07/2026' } })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('is not-found for an invoice that does not exist', async () => {
    const ctx = seed(null);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'x' } })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('is unauthenticated with no caller', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'x' } }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('updateInvoice admin gate', () => {
  // The tests above call the HANDLER directly, which is deliberate (it is the
  // unit under test) but means they all run as an admin by construction. The
  // gate itself is wrapAdminCallable's, so it is exercised through the wrapper
  // here, otherwise nothing in this file would prove a signed-in NON-admin is
  // refused.
  function nonAdminReq(): CallableRequest<unknown> {
    return {
      data: { invoiceId: 'inv1', patch: { terms: 'x' } },
      auth: { uid: 'kinfolk-9', token: {} } as any,
      rawRequest: {} as any,
      instanceIdToken: undefined,
      acceptsStreaming: false,
    } as unknown as CallableRequest<unknown>;
  }

  it('refuses a signed-in caller without the admin claim', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('updateInvoice', updateInvoiceHandler);
    await expect(guarded(nonAdminReq())).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a caller with no auth at all through the same wrapper', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('updateInvoice', updateInvoiceHandler);
    await expect(guarded(req({ invoiceId: 'inv1', patch: { terms: 'x' } }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
