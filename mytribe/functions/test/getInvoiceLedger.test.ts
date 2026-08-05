import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { getInvoiceLedgerHandler } from '../src/admin/getInvoiceLedger';

beforeEach(() => mocks.dbFn.mockReset());

/** A staff caller. `admin: true` is what `isStaff` reads. */
function req(data: unknown, token: Record<string, unknown> = { admin: true }, uid: string | null = 'admin1') {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

interface Seed {
  invoice?: Record<string, unknown> | null;
  /** Rows of `invoices/inv1/payments`, the settlement authority. */
  subPayments?: Array<{ id: string; data: Record<string, unknown> }>;
  /** Rows of the ROOT `payments` collection. */
  rootPayments?: Array<{ id: string; data: Record<string, unknown> }>;
  sessions?: Record<string, Record<string, unknown>>;
  /** Rows the reverse `invoiceId ==` query on kin_care_sessions should see. */
  sessionQuery?: Array<{ id: string; data: Record<string, unknown> }>;
}

function seed(s: Seed = {}) {
  const invoice = s.invoice === undefined ? { kinfolkId: 'fam1', total: 40 } : s.invoice;
  const docs: Record<string, Record<string, unknown> | null> = {
    'invoices/inv1': invoice,
  };
  for (const [id, data] of Object.entries(s.sessions ?? {})) {
    docs[`kin_care_sessions/${id}`] = data;
  }
  return buildDbMock({
    docs,
    queryDocs: {
      'invoices/inv1/payments': s.subPayments ?? [],
      payments: s.rootPayments ?? [],
      kin_care_sessions: s.sessionQuery ?? [],
    },
  });
}

function run(data: unknown = { invoiceId: 'inv1' }, token?: Record<string, unknown>) {
  return getInvoiceLedgerHandler(req(data, token));
}

describe('getInvoiceLedger payments (the settlement authority)', () => {
  it('returns the invoices/{id}/payments subcollection, which no client can read directly', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        subPayments: [
          {
            id: 'p1',
            data: {
              amount: 20,
              amountCents: 2000,
              method: 'check',
              reference: '#881',
              paidAt: '2026-07-20T10:00:00Z',
              recordedBy: 'admin1',
            },
          },
        ],
      }).db,
    );

    const res = await run();
    expect(res.payments).toEqual([
      {
        paymentId: 'p1',
        amountCents: 2000,
        method: 'check',
        reference: '#881',
        paidAt: '2026-07-20T10:00:00Z',
        recordedBy: 'admin1',
        // NULL on a markInvoicePaid row: one payment, one invoice, no split to
        // point back at. It is non-null only when one root payment was applied
        // across several bills (lib/paymentApply.ts).
        sourcePaymentId: null,
      },
    ]);
    expect(res.paidCents).toBe(2000);
  });
  it('carries sourcePaymentId back to the one payment a split settlement came in on', async () => {
    // Without it, a $300 payment split across three invoices reads as three
    // separate payments and nothing on any screen says the money arrived once.
    mocks.dbFn.mockReturnValue(
      seed({
        subPayments: [
          { id: 'p1', data: { amountCents: 12750, sourcePaymentId: 'rootpay1' } },
        ],
      }).db,
    );
    const res = await run();
    expect(res.payments[0]!.sourcePaymentId).toBe('rootpay1');
  });

  it('reports the balance a PARTIAL payment leaves, not a settled invoice', async () => {
    // The 2026-07-25 defect in miniature: $20 against a $40 invoice is $20 still
    // owed. The panel renders this figure, so it must come from the payments, not
    // from a stored `amountDue` the old write had already zeroed.
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, amountDue: 0, status: 'paid' },
        subPayments: [{ id: 'p1', data: { amount: 20, amountCents: 2000 } }],
      }).db,
    );

    const res = await run();
    expect(res.totalCents).toBe(4000);
    expect(res.paidCents).toBe(2000);
    expect(res.amountDueCents).toBe(2000);
  });

  it('reads a legacy payment that carries only float DOLLARS, rounding once', async () => {
    mocks.dbFn.mockReturnValue(
      seed({ subPayments: [{ id: 'old', data: { amount: 12.34 } }] }).db,
    );

    const res = await run();
    expect(res.payments[0]!.amountCents).toBe(1234);
    expect(res.paidCents).toBe(1234);
  });

  it('reports a blank method/reference/signature as null rather than an empty string', async () => {
    // markInvoicePaid writes an explicit `null` when the operator left the field
    // blank. A client must be able to tell "no method recorded" from "".
    mocks.dbFn.mockReturnValue(
      seed({
        subPayments: [{ id: 'p1', data: { amountCents: 500, method: null, reference: null } }],
      }).db,
    );

    const res = await run();
    expect(res.payments[0]!.method).toBeNull();
    expect(res.payments[0]!.reference).toBeNull();
    expect(res.payments[0]!.paidAt).toBeNull();
    expect(res.payments[0]!.recordedBy).toBeNull();
  });

  it('orders payments newest first and sorts an undated row last without dropping it', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        subPayments: [
          { id: 'old', data: { amountCents: 100, paidAt: '2026-07-01T00:00:00Z' } },
          { id: 'undated', data: { amountCents: 100 } },
          { id: 'new', data: { amountCents: 100, paidAt: '2026-07-30T00:00:00Z' } },
        ],
      }).db,
    );

    const res = await run();
    expect(res.payments.map((p) => p.paymentId)).toEqual(['new', 'old', 'undated']);
    expect(res.paidCents).toBe(300);
  });

  it('answers zero payments with an empty list, never an invented one', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await run();
    expect(res.payments).toEqual([]);
    expect(res.paidCents).toBe(0);
    expect(res.amountDueCents).toBe(4000);
  });
});

describe('getInvoiceLedger ledgerPayments (the display ledger)', () => {
  it('returns ROOT payments rows that name this invoice, in the legacy shape', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        rootPayments: [
          {
            id: 'r1',
            data: {
              invoiceId: 'inv1',
              amount: 30,
              tip: 5,
              paymentMethod: 'card',
              referenceNumber: 'ch_123',
              date: '2026-07-22',
              notes: 'stripe',
              recordedBy: 'admin1',
            },
          },
        ],
      }).db,
    );

    const res = await run();
    expect(res.ledgerPayments).toEqual([
      {
        paymentId: 'r1',
        amountCents: 3000,
        tipCents: 500,
        // NO FEE ON A LEGACY ROW, and `reconciles: false` is the whole point of
        // this case. The row carries a tip whose basis nobody recorded, so
        // `amount = applied + tipGross` cannot be checked against it and the
        // panel has to say so instead of printing figures that do not add up.
        feeCents: 0,
        tipBasis: 'unknown',
        reconciles: false,
        appliedCents: 0,
        unappliedCents: 2500,
        proceedsCents: 3000,
        autoApply: false,
        appliedInvoiceId: '',
        appliedInvoiceNumber: '',
        method: 'card',
        reference: 'ch_123',
        date: '2026-07-22',
        notes: 'stripe',
        recordedBy: 'admin1',
      },
    ]);
  });
  it('reads invoice #1029: the gross tip, the fee beside it, and a row that reconciles', async () => {
    // The live shape this whole tranche exists for. $137.50 collected, $127.50
    // applied to the bill, a $10.00 GROSS tip, and the $2.71 processor fee that
    // used to be dropped. amount = applied + tipGross closes exactly.
    mocks.dbFn.mockReturnValue(
      seed({
        rootPayments: [
          {
            id: 'r1029',
            data: {
              invoiceId: 'inv1',
              amount: 137.5,
              amountCents: 13750,
              tip: 10,
              tipCents: 1000,
              fee: 2.71,
              feeCents: 271,
              tipBasis: 'gross',
              autoApply: false,
              appliedCents: 12750,
              appliedInvoiceId: 'inv1',
              appliedInvoiceNumber: '1029',
              paymentMethod: 'venmo',
              referenceNumber: 'VN-1029',
              date: 'February 17, 2026',
              notes: 'took the fee out of the tip',
              recordedBy: 'admin1',
            },
          },
        ],
      }).db,
    );
    const row = (await run()).ledgerPayments[0]!;
    expect(row.amountCents).toBe(13750);
    expect(row.tipCents).toBe(1000);
    expect(row.feeCents).toBe(271);
    expect(row.tipBasis).toBe('gross');
    expect(row.reconciles).toBe(true);
    expect(row.appliedCents).toBe(12750);
    // amount - applied - tipGross
    expect(row.unappliedCents).toBe(0);
    // amount - fee: what she actually banks
    expect(row.proceedsCents).toBe(13479);
    // The "Applied to #n" column. ONE invoice, never a list.
    expect(row.appliedInvoiceId).toBe('inv1');
    expect(row.appliedInvoiceNumber).toBe('1029');
  });
  it('prefers the stored cents over the dollar float, per field', async () => {
    // The same precedence `paidCentsFromPayments` uses on the subcollection. A
    // disagreeing pair can only mean the float lost precision, so the integer
    // wins and nothing re-derives cents from dollars downstream.
    mocks.dbFn.mockReturnValue(
      seed({
        rootPayments: [
          {
            id: 'r1',
            data: { invoiceId: 'inv1', amount: 1, amountCents: 13750, fee: 1, feeCents: 271 },
          },
        ],
      }).db,
    );
    const row = (await run()).ledgerPayments[0]!;
    expect(row.amountCents).toBe(13750);
    expect(row.feeCents).toBe(271);
  });
  it('reconciles a row with no tip at all, whatever its basis says', async () => {
    // A Stripe row, and every payment nobody tipped on. There is no convention
    // to be wrong about when the number is zero, and a caveat on all of them is
    // the noise that trains an operator to stop reading caveats.
    mocks.dbFn.mockReturnValue(
      seed({ rootPayments: [{ id: 'r1', data: { invoiceId: 'inv1', amount: 30 } }] }).db,
    );
    const row = (await run()).ledgerPayments[0]!;
    expect(row.tipCents).toBe(0);
    expect(row.tipBasis).toBe('unknown');
    expect(row.reconciles).toBe(true);
  });
  it('reports an Applied-to that names a DIFFERENT invoice than the one being viewed', async () => {
    // A payment can be linked here for display and applied elsewhere. Saying so
    // is the point of the column: the alternative is a row on this invoice's
    // history that looks like it paid this invoice and did not.
    mocks.dbFn.mockReturnValue(
      seed({
        rootPayments: [
          {
            id: 'r1',
            data: {
              invoiceId: 'inv1',
              amount: 50,
              appliedCents: 5000,
              appliedInvoiceId: 'inv9',
              appliedInvoiceNumber: '1042',
            },
          },
        ],
      }).db,
    );
    const row = (await run()).ledgerPayments[0]!;
    expect(row.appliedInvoiceId).toBe('inv9');
    expect(row.appliedInvoiceNumber).toBe('1042');
    expect(row.appliedCents).toBe(5000);
  });
  it('reports the unapplied leftover a household is holding as credit', async () => {
    // $300 collected, $180 applied, auto-apply on. $120 is the Balance column,
    // and it is sitting in families/{id}.accountBalanceCents waiting for a
    // future invoice.
    mocks.dbFn.mockReturnValue(
      seed({
        rootPayments: [
          {
            id: 'r1',
            data: {
              invoiceId: 'inv1',
              amountCents: 30000,
              appliedCents: 18000,
              appliedInvoiceId: 'inv1',
              autoApply: true,
              tipBasis: 'gross',
            },
          },
        ],
      }).db,
    );
    const row = (await run()).ledgerPayments[0]!;
    expect(row.unappliedCents).toBe(12000);
    expect(row.autoApply).toBe(true);
    expect(row.reconciles).toBe(true);
  });

  it('does NOT count the display ledger toward paidCents', async () => {
    // The two collections have two jobs. stripeWebhook and recordPayment write
    // the root ledger; only the subcollection settles the invoice. Summing both
    // would double-collect a payment recorded through Android's two-step flow,
    // which writes one row in each.
    mocks.dbFn.mockReturnValue(
      seed({
        subPayments: [{ id: 'p1', data: { amountCents: 2000 } }],
        rootPayments: [{ id: 'r1', data: { invoiceId: 'inv1', amount: 20 } }],
      }).db,
    );

    const res = await run();
    expect(res.paidCents).toBe(2000);
    expect(res.amountDueCents).toBe(2000);
    expect(res.ledgerPayments).toHaveLength(1);
  });

  it('excludes a ledger row belonging to a different invoice', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        rootPayments: [
          { id: 'mine', data: { invoiceId: 'inv1', amount: 10 } },
          { id: 'theirs', data: { invoiceId: 'inv9', amount: 10 } },
          { id: 'standalone', data: { invoiceId: '', amount: 10 } },
        ],
      }).db,
    );

    const res = await run();
    expect(res.ledgerPayments.map((p) => p.paymentId)).toEqual(['mine']);
  });
});

describe('getInvoiceLedger sessions', () => {
  it('resolves the invoice sessionIds into real visits, newest first', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, sessionIds: ['s-old', 's-new'] },
        sessions: {
          's-old': {
            serviceType: 'dogWalking30',
            status: 'COMPLETED',
            startTime: '2026-07-01T14:00:00Z',
            completedAt: '2026-07-01T14:30:00Z',
            serviceDurationMinutes: 30,
            invoiceId: 'inv1',
          },
          's-new': {
            serviceType: 'dropIn',
            status: 'COMPLETED',
            startTime: '2026-07-15T09:00:00Z',
            serviceDurationMinutes: 60,
            invoiceId: 'inv1',
          },
        },
      }).db,
    );

    const res = await run();
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['s-new', 's-old']);
    expect(res.sessions[1]).toEqual({
      sessionId: 's-old',
      serviceType: 'dogWalking30',
      status: 'COMPLETED',
      startTime: '2026-07-01T14:00:00Z',
      completedAt: '2026-07-01T14:30:00Z',
      durationMinutes: 30,
      linkedBack: true,
    });
  });

  it('reports a duration the visit never recorded as null, never as zero minutes', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, sessionIds: ['s1'] },
        sessions: { s1: { serviceType: 'dropIn', startTime: '2026-07-01T00:00:00Z' } },
      }).db,
    );

    const res = await run();
    expect(res.sessions[0]!.durationMinutes).toBeNull();
    expect(res.sessions[0]!.completedAt).toBeNull();
  });

  it('reports an id the invoice claims with no session behind it, and drops no row silently', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, sessionIds: ['s1', 'ghost'] },
        sessions: { s1: { serviceType: 'dropIn', startTime: '2026-07-01T00:00:00Z' } },
      }).db,
    );

    const res = await run();
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(res.missingSessionIds).toEqual(['ghost']);
  });

  it('flags a HALF-WRITTEN link: the invoice claims the session, the session points elsewhere', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, sessionIds: ['s1'] },
        sessions: {
          s1: { serviceType: 'dropIn', startTime: '2026-07-01T00:00:00Z', invoiceId: 'inv9' },
        },
      }).db,
    );

    const res = await run();
    expect(res.sessions[0]!.linkedBack).toBe(false);
  });

  it('reports a session pointing AT this invoice that the invoice does not claim back', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, sessionIds: ['s1'] },
        sessions: {
          s1: { serviceType: 'dropIn', startTime: '2026-07-01T00:00:00Z', invoiceId: 'inv1' },
        },
        sessionQuery: [
          { id: 's1', data: { invoiceId: 'inv1' } },
          { id: 'orphan', data: { invoiceId: 'inv1' } },
        ],
      }).db,
    );

    const res = await run();
    expect(res.orphanSessionIds).toEqual(['orphan']);
  });

  it('tolerates an invoice whose sessionIds field is absent or junk', async () => {
    // normalizeInvoice on the React side exists because a real production doc
    // (`test-kinfolk-001-invoice-1`) has no sessionIds at all.
    mocks.dbFn.mockReturnValue(seed({ invoice: { kinfolkId: 'fam1', total: 40 } }).db);
    expect((await run()).sessions).toEqual([]);

    mocks.dbFn.mockReturnValue(
      seed({ invoice: { kinfolkId: 'fam1', total: 40, sessionIds: 'nope' } }).db,
    );
    expect((await run()).sessions).toEqual([]);
  });

  it('collapses duplicate session ids rather than showing a visit twice', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        invoice: { kinfolkId: 'fam1', total: 40, sessionIds: ['s1', 's1'] },
        sessions: { s1: { serviceType: 'dropIn', startTime: '2026-07-01T00:00:00Z' } },
      }).db,
    );
    expect((await run()).sessions).toHaveLength(1);
  });
});

describe('getInvoiceLedger gate and refusals', () => {
  it('refuses an unknown invoice rather than answering an empty ledger', async () => {
    mocks.dbFn.mockReturnValue(seed({ invoice: null }).db);
    await expect(run()).rejects.toThrow(/not found/i);
  });

  it('refuses a signed-out caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(getInvoiceLedgerHandler(req({ invoiceId: 'inv1' }, {}, null))).rejects.toThrow(
      /Sign-in required/i,
    );
  });

  it('refuses a caller who is neither staff nor a sandbox test admin', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(run({ invoiceId: 'inv1' }, {})).rejects.toThrow(/Admin claim required/i);
  });

  it('lets a sandbox test admin read an invoice inside their own tribe', async () => {
    mocks.dbFn.mockReturnValue(seed({ invoice: { kinfolkId: 'sandbox1', total: 40 } }).db);
    const res = await run({ invoiceId: 'inv1' }, { testTribeId: 'sandbox1' });
    expect(res.invoiceId).toBe('inv1');
  });

  it('refuses a sandbox test admin an invoice outside their tribe', async () => {
    mocks.dbFn.mockReturnValue(seed({ invoice: { kinfolkId: 'live-household', total: 40 } }).db);
    await expect(run({ invoiceId: 'inv1' }, { testTribeId: 'sandbox1' })).rejects.toThrow(
      /outside your test sandbox/i,
    );
  });

  it('refuses a malformed request', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(run({})).rejects.toThrow(/validation failed/i);
    await expect(run({ invoiceId: 'inv1', extra: 1 })).rejects.toThrow(/validation failed/i);
  });
});
