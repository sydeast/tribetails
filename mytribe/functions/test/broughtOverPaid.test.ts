import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2470: AN INVOICE BROUGHT OVER PART PAID.
 *
 * The reload copies the old system's invoices with their total and stated
 * balance, and their earlier payments are not rows in `invoices/{id}/payments`.
 * So the reload stamps `broughtOverPaidCents` (total less stated, once) and
 * every reader of "applied" counts it (ruling #2435: the balance is the total
 * less payments and credits).
 *
 * THE NAMED CASE: total $40, stated $25, so $15 brought over. Before any new
 * payment every path measures $25. After $10 is recorded, $25 is applied and
 * $15 is owed everywhere. Before this fix Record payment left $30 owed.
 *
 * Every handler below runs for real against one in-memory Firestore; only
 * Stripe and the notice dispatcher are stubbed.
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  events: {} as Record<string, unknown>,
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => hooks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: hooks.log }));
vi.mock('../src/lib/writeAuditEntry', async () => ({
  ...(await vi.importActual<object>('../src/lib/writeAuditEntry')),
  writeAuditEntry: hooks.audit,
}));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: async () => 'kin-uid-1' }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: async () => 'kin-uid-1' }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: async (args: unknown) => hooks.enqueue(args),
}));
vi.mock('../src/lib/stripe', () => ({
  getStripe: async () => ({
    checkout: { sessions: { create: hooks.createSession, retrieve: hooks.retrieveSession } },
    paymentIntents: { retrieve: async () => ({ latest_charge: { balance_transaction: { fee: 146 } } }) },
    charges: { retrieve: vi.fn() },
  }),
  verifyStripeWebhook: (_body: Buffer, sig: string) => {
    const event = hooks.events[sig];
    if (!event) throw new Error('bad signature');
    return event;
  },
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
      delete: () => undefined,
      arrayUnion: (...values: unknown[]) => ({ __arrayUnion: values }),
    },
  };
});

import { recordPaymentHandler } from '../src/admin/recordPayment';
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { applyAccountCreditHandler } from '../src/admin/applyAccountCredit';
import { getInvoiceLedgerHandler } from '../src/admin/getInvoiceLedger';
import { writeOffInvoiceHandler } from '../src/admin/archiveInvoice';
import { appliedPaymentCentsOf, withdrawQuoteHandler, CANCEL_PAID_REFUSAL_CODE } from '../src/admin/quoteActions';
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { payInvoiceHandler } from '../src/portal/payInvoice';
import { getMyInvoicesHandler, openBalanceCentsOf } from '../src/portal/getMyInvoices';
import { stripeWebhookHandler } from '../src/billing/stripeWebhook';
import { amountDueCentsOf } from '../src/lib/amountDueRule';
import {
  appliedCentsOf,
  broughtOverPaidCentsOf,
  paidCentsFromPayments,
  settleInvoiceDoc,
  type PaymentAmount,
} from '../src/lib/invoiceMath';
import { invoiceStateOf } from '../src/lib/invoiceEditPolicy';
import { invoiceStateStampOf } from '../src/lib/invoiceStateStamp';
import { invoiceIsPaid } from '../src/lib/invoicePaidGate';
import { chaseRefusalOf } from '../src/lib/invoiceChase';
import { repairPlanFor } from '../src/lib/invoicePaymentRepair';
import { balanceToSettle, planApply } from '../src/lib/paymentApply';
import { cardCheckoutRefusal, decideCardApply } from '../src/lib/cardPaymentApply';
import { invoiceAcceptsCredit } from '../src/lib/accountCredit';
import { invoiceForPdf } from '../src/lib/invoicePdf';
import { checkoutRoundOf } from '../src/lib/invoiceCheckoutDedupe';
import { enrichTemplateData } from '../src/notifications/enrichTemplateData';

type Docs = Record<string, Record<string, any> | null>;
let docs: Docs;

const INVOICE = 'invoices/inv1';
const KIN_UID = 'kin-uid-1';

/** Total $40, stated $25 when brought over, so $15 brought over paid. No rows. */
const BROUGHT = {
  kinfolkId: 'fam1',
  kinfolkName: 'The Wrens',
  status: 'open',
  invoiceNumber: '1031',
  date: '2026-07-14',
  total: 40,
  amountDue: 25,
  broughtOverPaidCents: 1500,
  paymentsHistory: 'Paid $15.00 by check',
};

/** Brought over paid in full: stated $0, so the whole $40 brought over. */
const BROUGHT_PAID = { ...BROUGHT, amountDue: 0, broughtOverPaidCents: 4000 };

function seed(invoice: Record<string, unknown>, rows: PaymentAmount[] = [], extra: Docs = {}) {
  docs = {
    'clients/kin-uid-1': { kinfolkIds: ['fam1'] },
    'families/fam1': { accountBalanceCents: 10000 },
    [INVOICE]: { ...invoice },
    ...extra,
  };
  rows.forEach((row, i) => {
    docs[`${INVOICE}/payments/row${i + 1}`] = { ...row };
  });
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
  return ctx;
}

const admin = (data: unknown) => ({ data, auth: { uid: 'owner1', token: { admin: true } }, rawRequest: {} }) as any;
const kinfolk = (data: unknown) => ({ data, auth: { uid: KIN_UID, token: {} } }) as any;

function invoiceRows(): PaymentAmount[] {
  return Object.entries(docs)
    .filter(([k, v]) => k.startsWith(`${INVOICE}/payments/`) && v !== null)
    .map(([, v]) => v as PaymentAmount);
}

/** Records $`dollars` against the invoice through Record payment. */
async function recordTen(dollars = 10) {
  return recordPaymentHandler(
    admin({
      kinfolkId: 'fam1',
      kinfolkName: 'The Wrens',
      date: '2026-11-20',
      paymentMethod: 'check',
      referenceNumber: 'CK-7',
      amount: dollars,
      invoiceId: 'inv1',
      invoiceNumber: '1031',
      apply: { invoiceId: 'inv1', invoiceNumber: '1031', amount: dollars },
    }),
  );
}

async function listed() {
  const res = await getMyInvoicesHandler(kinfolk({ kinfolkId: 'fam1' }));
  return [...res.open, ...res.paid, ...res.credits].find((i) => i.id === 'inv1');
}

async function pay(): Promise<{ ok?: { amountCents: number }; err?: any }> {
  return payInvoiceHandler(
    kinfolk({
      invoiceId: 'inv1',
      successUrl: 'https://kinfolk.tribetails.com/invoices/inv1?checkout=done',
      cancelUrl: 'https://kinfolk.tribetails.com/invoices/inv1',
    }),
  ).then(
    (ok) => ({ ok }),
    (err) => ({ err }),
  );
}

async function cardPaymentLands(cents: number): Promise<Record<string, any>> {
  hooks.events['session-1'] = {
    id: 'evt_cs_1',
    type: 'checkout.session.completed',
    created: 1_763_000_001,
    data: {
      object: {
        id: 'cs_1',
        payment_intent: 'pi_1',
        payment_status: 'paid',
        amount_total: cents,
        metadata: {
          familyId: 'fam1',
          kinfolkId: 'fam1',
          invoiceId: 'inv1',
          uid: KIN_UID,
          checkoutRound: String(checkoutRoundOf(docs[INVOICE]?.stripeCheckoutRound)),
        },
      },
    },
  };
  let code = 0;
  const res = {
    status: (c: number) => {
      code = c;
      return res;
    },
    json: () => res,
    end: () => res,
  };
  await (stripeWebhookHandler as any)(
    { method: 'POST', headers: { 'stripe-signature': 'session-1' }, rawBody: Buffer.from('{}') },
    res,
  );
  expect(code).toBe(200);
  return docs['payments/evt_cs_1'] ?? {};
}

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.audit.mockReset();
  hooks.audit.mockResolvedValue('audit-1');
  hooks.log.mockReset();
  hooks.createSession.mockReset();
  hooks.createSession.mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/test' });
  hooks.retrieveSession.mockReset();
  hooks.retrieveSession.mockRejectedValue(new Error('No such checkout.session'));
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
});

describe('#2470: the shared helper for what has been applied', () => {
  it('reads only a positive whole number of cents', () => {
    expect(broughtOverPaidCentsOf({ broughtOverPaidCents: 1500 })).toBe(1500);
    expect(broughtOverPaidCentsOf({})).toBe(0);
    expect(broughtOverPaidCentsOf(null)).toBe(0);
    expect(broughtOverPaidCentsOf({ broughtOverPaidCents: -5 })).toBe(0);
    expect(broughtOverPaidCentsOf({ broughtOverPaidCents: 12.5 })).toBe(0);
    expect(broughtOverPaidCentsOf({ broughtOverPaidCents: '1500' })).toBe(0);
  });

  it('adds it to the rows, and settles on both while storing the rows alone', () => {
    expect(appliedCentsOf(BROUGHT, 1000)).toBe(2500);
    expect(appliedCentsOf({}, 1000)).toBe(1000);
    const s = settleInvoiceDoc(BROUGHT, 1000);
    expect(s).toMatchObject({ totalCents: 4000, paidCents: 2500, rowsPaidCents: 1000, broughtOverPaidCents: 1500, amountDueCents: 1500, state: 'partial' });
  });

  it('the balance rule counts it: $25 with no rows, $15 after a $10 row', () => {
    expect(amountDueCentsOf(BROUGHT, null)).toBe(2500);
    expect(amountDueCentsOf(BROUGHT, 0)).toBe(2500);
    // The stated balance as a payment path rewrites it after $10.
    expect(amountDueCentsOf({ ...BROUGHT, amountDue: 15, amountDueCents: 1500 }, 1000)).toBe(1500);
    // Even a stale stated $25 left behind after the $10 row owes $15.
    expect(amountDueCentsOf(BROUGHT, 1000)).toBe(1500);
  });

  it('an invoice brought over before the field existed keeps its lower stated balance', () => {
    const unstamped = { ...BROUGHT, broughtOverPaidCents: undefined };
    expect(amountDueCentsOf(unstamped, null)).toBe(2500);
  });
});

describe('#2470: an invoice brought over paid in full (stated $0)', () => {
  it('reads paid, is not chased, takes no payment and is never reopened by the repair pass', () => {
    expect(invoiceStateOf(BROUGHT_PAID)).toBe('paid');
    expect(invoiceIsPaid(BROUGHT_PAID, 0)).toBe(true);
    expect(chaseRefusalOf(BROUGHT_PAID, { rows: 0, paidCents: 0 })).toMatchObject({ reason: 'not_open' });
    expect(invoiceAcceptsCredit(BROUGHT_PAID, [])).toBe(false);
    const plan = planApply({
      invoice: { invoiceId: 'inv1', doc: BROUGHT_PAID, existingPayments: [] },
      appliedCents: 100,
      kinfolkId: 'fam1',
      spendableCents: 100,
    });
    expect(plan).toMatchObject({ ok: false, refusal: { code: 'invoice_already_settled' } });
    // Even with a stray row, its total is covered.
    expect(repairPlanFor('inv1', BROUGHT_PAID, [{ amountCents: 100 }])).toEqual({ skipped: 'payments_cover_total' });
  });

  it('Mark paid refuses it as already covered', async () => {
    seed(BROUGHT_PAID);
    await expect(markInvoicePaidHandler(admin({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_already_settled' },
    });
  });

  it('a part-paid one is still chased', () => {
    expect(chaseRefusalOf(BROUGHT, { rows: 0, paidCents: 0 })).toBeNull();
  });
});

describe('#2470: Record payment', () => {
  it('$10 on $40 brought over at $25 leaves $15 owed, not $30', async () => {
    seed(BROUGHT);
    await recordTen();
    expect(docs[INVOICE]).toMatchObject({
      status: 'open',
      paymentStatus: 'PARTIAL',
      totalCents: 4000,
      paidCents: 1000,
      amountDueCents: 1500,
      amountDue: 15,
      broughtOverPaidCents: 1500,
    });
  });

  it('Settle the balance (Amount left blank) takes $25, not $40', () => {
    expect(balanceToSettle({ invoiceId: 'inv1', doc: BROUGHT, existingPayments: [] }, 'fam1')).toEqual({
      ok: true,
      amountDueCents: 2500,
    });
  });

  it('refuses more than the $25 owed', () => {
    const plan = planApply({
      invoice: { invoiceId: 'inv1', doc: BROUGHT, existingPayments: [] },
      appliedCents: 3000,
      kinfolkId: 'fam1',
      spendableCents: 3000,
    });
    expect(plan).toMatchObject({ ok: false, refusal: { amountDueCents: 2500 } });
  });

  it('$10 then $15 settles it: stored paidCents is the rows, the brought-over field is untouched', async () => {
    seed(BROUGHT);
    await recordTen(10);
    await recordTen(15);
    expect(paidCentsFromPayments(invoiceRows())).toBe(2500);
    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      paymentStatus: 'PAID',
      paidCents: 2500,
      amountDueCents: 0,
      amountDue: 0,
      overpaidCents: 0,
      broughtOverPaidCents: 1500,
    });
  });
});

describe('#2470: Mark paid', () => {
  it('$10 leaves $15, then Mark paid with no amount settles the $15', async () => {
    seed(BROUGHT);
    const first = await markInvoicePaidHandler(admin({ invoiceId: 'inv1', amount: 10 }));
    expect(first).toMatchObject({ amountDueCents: 1500, paidCents: 2500, state: 'partial' });
    expect(docs[INVOICE]).toMatchObject({ paidCents: 1000, amountDueCents: 1500, amountDue: 15 });

    const rest = await markInvoicePaidHandler(admin({ invoiceId: 'inv1' }));
    expect(rest).toMatchObject({ amountDueCents: 0, state: 'settled' });
    expect(paidCentsFromPayments(invoiceRows())).toBe(2500);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 2500, amountDueCents: 0, broughtOverPaidCents: 1500 });
  });

  it('Mark paid with no amount on a fresh one records $25', async () => {
    seed(BROUGHT);
    await markInvoicePaidHandler(admin({ invoiceId: 'inv1' }));
    expect(paidCentsFromPayments(invoiceRows())).toBe(2500);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 2500, amountDueCents: 0 });
  });
});

describe('#2470: Apply credit', () => {
  it('is measured against $25: $30 is refused, $10 leaves $15', async () => {
    seed(BROUGHT);
    await expect(
      applyAccountCreditHandler(admin({ invoiceId: 'inv1', amountCents: 3000, idempotencyKey: 'acr_1790000000000_abc123' })),
    ).rejects.toThrow('This invoice has $25.00 left to pay.');

    const ok = await applyAccountCreditHandler(
      admin({ invoiceId: 'inv1', amountCents: 1000, idempotencyKey: 'acr_1790000000001_abc124' }),
    );
    expect(ok).toMatchObject({ ok: true, appliedCents: 1000, amountDueCents: 1500 });
    expect(docs[INVOICE]).toMatchObject({ paidCents: 1000, amountDueCents: 1500, broughtOverPaidCents: 1500 });
  });
});

describe('#2470: card checkout and the webhook', () => {
  it('charges $25 before any payment and $15 after $10, and the $15 card settles it with no tip', async () => {
    seed(BROUGHT);
    expect(cardCheckoutRefusal({ invoiceId: 'inv1', doc: BROUGHT, existingPayments: [], kinfolkId: 'fam1' })).toBeNull();
    expect((await pay()).ok).toMatchObject({ amountCents: 2500 });

    seed(BROUGHT);
    await recordTen();
    expect((await pay()).ok).toMatchObject({ amountCents: 1500 });

    const row = await cardPaymentLands(1500);
    expect(row).toMatchObject({ appliedCents: 1500, tipCents: 0 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0, paidCents: 2500, broughtOverPaidCents: 1500 });
  });

  it('a $25 card on the fresh invoice is planned onto it, not a fallback', () => {
    const d = decideCardApply({ invoiceId: 'inv1', doc: BROUGHT, existingPayments: [], cardCents: 2500, kinfolkId: 'fam1' });
    expect(d).toMatchObject({ kind: 'planned', appliedCents: 2500, tipCents: 0 });
    if (d.kind === 'planned') expect(d.step.after).toMatchObject({ state: 'settled', rowsPaidCents: 2500 });
  });
});

describe('#2470: what the screens are told', () => {
  it('MyTribe: $15 due, $25 of $40 paid', async () => {
    seed(BROUGHT);
    expect(await listed()).toMatchObject({ amountDue: 25, paidCents: 1500, partiallyPaid: true });
    await recordTen();
    expect(await listed()).toMatchObject({ amountDue: 15, paidCents: 2500, partiallyPaid: true });
  });

  it('Home Balance due counts $15 after $10', () => {
    expect(openBalanceCentsOf([{ ...BROUGHT, status: 'open', paidCents: 1000 }], [1000])).toBe(1500);
  });

  it('the admin ledger ships the applied figure and the brought-over line', async () => {
    seed(BROUGHT);
    await recordTen();
    const ledger = await getInvoiceLedgerHandler(admin({ invoiceId: 'inv1' }));
    expect(ledger).toMatchObject({ paidCents: 2500, broughtOverPaidCents: 1500, totalCents: 4000, amountDueCents: 1500 });
    expect(ledger.payments.reduce((s, p) => s + p.amountCents, 0) + ledger.broughtOverPaidCents).toBe(ledger.paidCents);
  });

  it('the PDF and the notice amount token print $15 after $10', async () => {
    const after = { ...BROUGHT, amountDue: 25, paidCents: 1000 };
    expect(invoiceForPdf('inv1', after).amountDue).toBe(15);
    const ctx = buildDbMock({ docs: { 'invoices/inv1': after, 'families/fam1': { displayName: 'The Wrens' } } });
    hooks.db.current = ctx.db;
    const out = await enrichTemplateData('invoice.reminder', 'cli1', { invoiceId: 'inv1', kinfolkId: 'fam1' });
    expect(out.amount).toBe('$15.00');
  });
});

describe('#2470: stamping the field changes no stored state stamp', () => {
  // The backfill writes `broughtOverPaidCents` alone. That is right only if
  // the stamp an invoice already carries is the stamp it would get with the
  // field, for every shape the backfill stamps.
  const without = (doc: Record<string, unknown>) => {
    const { broughtOverPaidCents: _drop, ...rest } = doc;
    return rest;
  };
  it.each([
    ['part paid', BROUGHT],
    ['paid in full', BROUGHT_PAID],
    ['a quote part paid', { ...BROUGHT, status: 'quote' }],
    ['a draft part paid', { ...BROUGHT, status: 'draft' }],
  ])('%s', (_label, doc) => {
    expect(invoiceStateStampOf(doc, 0)).toEqual(invoiceStateStampOf(without(doc), 0));
  });
});

describe('#2470: write-off, withdraw, edit and the repair pass', () => {
  it('write-off gives up the $15 owed, never money already paid', async () => {
    seed(BROUGHT);
    await recordTen();
    await expect(writeOffInvoiceHandler(admin({ invoiceId: 'inv1', amountCents: 3000 }))).rejects.toMatchObject({
      details: { code: 'write_off_amount_changed', owedCents: 1500 },
    });
    const res = await writeOffInvoiceHandler(admin({ invoiceId: 'inv1', amountCents: 1500 }));
    expect(res).toMatchObject({ ok: true, writtenOffCents: 1500 });
    const entry = Object.entries(docs).find(([k]) => k.startsWith(`${INVOICE}/writeOffs/`))?.[1];
    expect(entry).toMatchObject({ amountCents: 1500, paidCents: 2500, totalCents: 4000 });
  });

  it('a quote brought over with money paid cannot be withdrawn', async () => {
    expect(appliedPaymentCentsOf({ broughtOverPaidCents: 1500 }, [])).toBe(1500);
    seed({ ...BROUGHT, status: 'quote' });
    await expect(withdrawQuoteHandler(admin({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      details: { code: CANCEL_PAID_REFUSAL_CODE },
    });
  });

  it('an edit that raises the total keeps counting what was brought over', async () => {
    seed(BROUGHT, [{ amountCents: 1000 }]);
    await updateInvoiceHandler(
      admin({ invoiceId: 'inv1', patch: { lineItems: [{ description: 'Drop-in visits', qty: 2, unitCents: 2500 }] } }),
    );
    expect(docs[INVOICE]).toMatchObject({ totalCents: 5000, paidCents: 1000, amountDueCents: 2500, broughtOverPaidCents: 1500 });
  });

  it('the repair pass leaves a part-paid brought-over invoice at $15, not reopened at $30', () => {
    const after = { ...BROUGHT, amountDue: 15, amountDueCents: 1500, paidCents: 1000 };
    expect(repairPlanFor('inv1', after, [{ amountCents: 1000 }])).toEqual({ skipped: 'balance_already_correct' });
  });

  it('the repair pass reopens a zeroed part-paid brought-over invoice at $15 and stores the rows alone', () => {
    // The pre-2026-07-25 shape: a $10 row marked paid with nothing owed.
    const zeroed = { ...BROUGHT, status: 'paid', amountDue: 0, amountDueCents: 0, paidCents: 1000 };
    const plan = repairPlanFor('inv1', zeroed, [{ amountCents: 1000 }]);
    if (!('update' in plan)) throw new Error(`expected a repair plan, got ${JSON.stringify(plan)}`);
    expect(plan.update).toMatchObject({ status: 'open', paidCents: 1000, amountDueCents: 1500, amountDue: 15 });
    expect(plan.update).not.toHaveProperty('broughtOverPaidCents');
    expect(plan.finding).toMatchObject({ paidCents: 2500, correctAmountDueCents: 1500 });
  });
});
