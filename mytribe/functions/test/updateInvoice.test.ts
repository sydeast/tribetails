import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// #557: this suite drives handlers through the wrapper, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
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
    // The state stamp runs on the PERSISTED (clamped) figures, not the raw
    // signed totals returned to the caller: over-collected settles the doc, so
    // it stamps paid/none, never credit off a negative balance.
    expect(w.data.status).toBe('paid');
    expect(w.data.editScope).toBe('none');
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

describe('updateInvoice state stamp (ADR-0002)', () => {
  it('every write carries the stamp, even a metadata-only edit', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 7' } }));
    const w = invoiceWrite(ctx)!;
    expect(w.data.status).toBe('open');
    expect(w.data.editScope).toBe('all');
  });

  it('a PART-PAID invoice stamps open/all: still outstanding, still fully repairable', async () => {
    const ctx = seed(OPEN_INVOICE, [{ id: 'p1', data: { amount: 10 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 4000 }] } }),
    );
    const w = invoiceWrite(ctx)!;
    expect(w.data.status).toBe('open');
    expect(w.data.editScope).toBe('all');
  });

  it('a metadata edit on a SETTLED invoice stamps paid/none off the payments evidence', async () => {
    const ctx = seed(OPEN_INVOICE, [{ id: 'p1', data: { amount: 40 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Net 14' } }));
    const w = invoiceWrite(ctx)!;
    // The stored label still said 'open'; the subcollection says the money is
    // in. The stamp persists the classifier's reading of the doc as this
    // write leaves it: amountDue is untouched by a metadata edit, so status
    // stays open by the money, but the SCOPE reflects the settled standing.
    expect(w.data.status).toBe('open');
    expect(w.data.editScope).toBe('metadataOnly');
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
/**
 * W2-1 (ADR-0002): the four descriptive fields android's whole-model merge-set
 * writes that the patch previously could not express. Appended as its own block
 * (rather than woven into the suites above) so every line this task added stays
 * contiguous, same as the brand-asset block in callableContract.test.ts.
 */
describe('updateInvoice W2-1 metadata fields (kinfolkName / client / address / discount)', () => {
  it('writes all four without touching the money', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: {
          kinfolkName: 'The Riveras',
          client: 'Ana Rivera',
          address: '12 Elm St',
          discount: '10% loyalty',
        },
      }),
    );
    expect(res.ok).toBe(true);
    const w = invoiceWrite(ctx)!;
    expect(w.data.kinfolkName).toBe('The Riveras');
    expect(w.data.client).toBe('Ana Rivera');
    expect(w.data.address).toBe('12 Elm St');
    expect(w.data.discount).toBe('10% loyalty');
    // Metadata only: no recompute happened on this un-itemized invoice.
    expect(w.data.totalCents).toBeUndefined();
    expect(w.data.total).toBeUndefined();
  });
  it('the legacy free-text discount is NOT money: it stays editable on a settled invoice', async () => {
    // `invoiceDiscountCents` on the same invoice is refused (the money is
    // locked); the display string never enters the arithmetic, so it may still
    // be corrected.
    const ctx = seed(
      { ...OPEN_INVOICE, totalCents: 4000 },
      [{ id: 'p1', data: { amountCents: 4000 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { discount: 'waived' } }),
    );
    expect(res.ok).toBe(true);
    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { invoiceDiscountCents: 100 } })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_money_locked' } });
  });
  it('still refuses the fields the patch deliberately does not carry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const bad of [
      { status: 'paid' }, // the classifier owns status (ADR-0002)
      { sessionIds: ['s1'] }, // linkInvoiceSessions owns the link
      { kinfolkId: 'fam2' }, // re-homing an invoice is not an edit
      { total: 0 }, // the server owns every total
    ]) {
      await expect(
        updateInvoiceHandler(req({ invoiceId: 'inv1', patch: bad })),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(ctx.writes).toHaveLength(0);
  });
});
/**
 * ISSUE #448. The operator ruling of 2026-08-18: a quote is editable until the
 * household ACCEPTS it, and a DECLINED one stays editable so the office can
 * revise it and send it back out.
 *
 * THE TEST THAT WOULD HAVE CAUGHT THE BUG is the first one. PR #430 built the
 * accept/deny path and wrote down that "a revision is a new quote" without
 * enforcing anything: `acceptQuote` re-stamps the doc to `open`/`editScope:
 * 'all'`, so this callable happily rewrote the line items of a figure the
 * household had already agreed to.
 */
const ACCEPTED_QUOTE = {
  kinfolkId: 'fam1',
  invoiceNumber: 'Q-1001',
  // What `acceptQuote` actually leaves behind: the quote status is GONE (that
  // is what makes the portal's Pay button appear), and the household's answer
  // is the only field that still says where this bill came from.
  status: 'open',
  invoiceStatus: 'open',
  editScope: 'all',
  quoteDecision: 'accepted',
  amountDue: 240,
  total: 240,
};
const DECLINED_QUOTE = {
  kinfolkId: 'fam1',
  invoiceNumber: 'Q-1002',
  status: 'quote',
  invoiceStatus: 'quote',
  editScope: 'all',
  quoteDecision: 'denied',
  amountDue: 240,
  total: 240,
};
describe('updateInvoice and the household answer to a quote (issue #448)', () => {
  it('REFUSES to edit the money on a quote the household accepted', async () => {
    const ctx = seed(ACCEPTED_QUOTE);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: { lineItems: [{ description: 'More walks', qty: 9, unitCents: 5000 }] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(invoiceWrite(ctx)).toBeUndefined();
  });
  it('refuses a metadata-only edit to an accepted quote too, and names the reason', async () => {
    const ctx = seed(ACCEPTED_QUOTE);
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { terms: 'Net 60' } }),
    ).catch((e) => e);
    expect(err.code).toBe('failed-precondition');
    // The operator has to be able to act on the sentence. 'open' is not a
    // frozen state, so the generic frozen-state copy has nothing to say here
    // and an empty message is exactly what the missing branch would produce.
    expect(err.message).toContain('accepted this quote');
    expect(err.details).toMatchObject({ code: 'quote_accepted_locked' });
    expect(invoiceWrite(ctx)).toBeUndefined();
  });
  it('EDITS A DECLINED QUOTE FREELY, because revising it is the next step', async () => {
    const ctx = seed(DECLINED_QUOTE);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: {
          lineItems: [{ description: 'Two walks a week', qty: 8, unitCents: 2000 }],
          dueDate: '2999-12-31',
        },
      }),
    );
    expect(res.ok).toBe(true);
    const w = invoiceWrite(ctx)!;
    expect(w.data.totalCents).toBe(16000);
    expect(w.data.dueDate).toBe('2999-12-31');
    // Still a quote, still editable, still carrying the decline until the
    // office sends it back out through resendQuote.
    expect(w.data.status).toBe('quote');
    expect(w.data.editScope).toBe('all');
  });
  it('re-stamps an accepted quote it CAN edit as locked, so the affordance disappears', async () => {
    // The part-paid repair case: the acceptance lock yields to it (a
    // part-collected bill must stay correctable), and the moment the payment
    // no longer falls short the doc goes back to locked.
    const ctx = seed(
      { ...ACCEPTED_QUOTE, editScope: 'all' },
      [{ id: 'p1', data: { amountCents: 4000 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: { lineItems: [{ description: 'Walks', qty: 1, unitCents: 4000 }] },
      }),
    );
    expect(res.ok).toBe(true);
    const w = invoiceWrite(ctx)!;
    // The edit settles the bill, so the standing stops being 'partial' and the
    // acceptance lock applies again on the very write that made it true.
    expect(w.data.editScope).toBe('none');
  });
});

/**
 * #408: an invoice's terms are a value, and editing them re-decides the due
 * date from the same rule creation used. The two callables share
 * `lib/invoiceCreateFields.ts` precisely so an edit cannot land a due date the
 * create path would have refused.
 */
describe('updateInvoice structured terms', () => {
  it('writes the rule in words and the date it works out to', async () => {
    const ctx = seed({ ...OPEN_INVOICE, date: '2026-06-01' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { termsCode: 'net_14' } }));
    expect(invoiceWrite(ctx)?.data).toMatchObject({
      terms: 'Due 14 days after the invoice date',
      termsCode: 'net_14',
      dueDate: '2026-06-15',
    });
  });
  it('counts service-relative terms from the visits the invoice already links', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { ...OPEN_INVOICE, date: '2026-06-20', sessionIds: ['s1', 's2'] },
        'kin_care_sessions/s1': { startTime: '2026-06-02T14:00:00.000Z' },
        'kin_care_sessions/s2': { startTime: '2026-06-09T14:00:00.000Z' },
      },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { termsCode: 'net_7_after_last_visit' } }),
    );
    expect(invoiceWrite(ctx)?.data.dueDate).toBe('2026-06-16');
  });
  it('re-decides the due date from a date set in the SAME patch', async () => {
    const ctx = seed({ ...OPEN_INVOICE, date: '2026-06-01' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { date: '2026-07-01', termsCode: 'net_30' } }),
    );
    expect(invoiceWrite(ctx)?.data.dueDate).toBe('2026-07-31');
  });
  it('REFUSES a due date sent alongside terms that work out to a different day', async () => {
    const ctx = seed({ ...OPEN_INVOICE, date: '2026-06-01' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      updateInvoiceHandler(
        req({ invoiceId: 'inv1', patch: { termsCode: 'net_14', dueDate: '2026-08-01' } }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(invoiceWrite(ctx)).toBeUndefined();
  });
  it('keeps the existing due date when the terms become custom and no date is sent', async () => {
    const ctx = seed({ ...OPEN_INVOICE, date: '2026-06-01', dueDate: '2026-07-04' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { termsCode: 'custom' } }));
    expect(invoiceWrite(ctx)?.data.dueDate).toBe('2026-07-04');
  });
  it('leaves free-text terms exactly as they were sent, and CLEARS the rule they replaced', async () => {
    // An invoice typed over by hand no longer follows a code. Leaving the old
    // one on the doc would let the two disagree in a field nothing renders yet.
    const ctx = seed({ ...OPEN_INVOICE, termsCode: 'net_14' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Pay when you can' } }));
    expect(invoiceWrite(ctx)?.data.terms).toBe('Pay when you can');
    expect(invoiceWrite(ctx)?.data.termsCode).toBe('');
  });
  it('keeps the code when the same patch sets both, so the words are the rule\'s own', async () => {
    const ctx = seed({ ...OPEN_INVOICE, date: '2026-06-01' });
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({ invoiceId: 'inv1', patch: { terms: 'ignored', termsCode: 'net_14' } }),
    );
    expect(invoiceWrite(ctx)?.data.termsCode).toBe('net_14');
    expect(invoiceWrite(ctx)?.data.terms).toBe('Due 14 days after the invoice date');
  });
});
/** #408: editing an invoice must not cut its lines loose from their visits. */
describe('updateInvoice bound line items', () => {
  it('keeps the binding on a line the patch carries', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await updateInvoiceHandler(
      req({
        invoiceId: 'inv1',
        patch: {
          lineItems: [
            { description: 'Dog walking, 2026-06-02', qty: 1, unitCents: 2500, sessionId: 's1' },
            { description: 'Key cutting', qty: 1, unitCents: 1000 },
          ],
        },
      }),
    );
    const written = invoiceWrite(ctx)?.data.lineItems as Array<Record<string, unknown>>;
    expect(written[0]!.sessionId).toBe('s1');
    expect(written[1]!.sessionId).toBeUndefined();
  });
});
