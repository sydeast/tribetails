import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import {
  ACCOUNT_BALANCE_FIELD,
  ACCOUNT_CREDIT_METHOD,
  drawAccountCredit,
  invoiceAcceptsCredit,
  planCreditDraw,
  readAccountBalanceCents,
} from '../src/lib/accountCredit';

beforeEach(() => mocks.dbFn.mockReset());

/**
 * ACCOUNT CREDIT, and the auto-apply that spends it.
 *
 * The credit ledger is `families/{id}.accountBalanceCents`, which already
 * existed: `redeemCredit` filled it, `getMyInvoices` shipped it, the portal
 * showed it, and NOTHING EVER SPENT IT. These tests cover the consumer that
 * closes that loop, plus the guards that stop it spending credit somewhere it
 * should not.
 */

describe('planCreditDraw: how much credit to spend', () => {
  it('spends the whole balance when the invoice is owed more than is held', () => {
    expect(planCreditDraw({ amountDueCents: 20000, accountBalanceCents: 12000 })).toBe(12000);
  });

  it('spends only what is owed when the balance is larger', () => {
    // The remainder stays on account for the invoice after this one, which is
    // what "future invoices", plural, means.
    expect(planCreditDraw({ amountDueCents: 5000, accountBalanceCents: 12000 })).toBe(5000);
  });

  it('NEVER creates an overpayment out of credit the household did not choose to spend', () => {
    const draw = planCreditDraw({ amountDueCents: 5000, accountBalanceCents: 12000 });
    expect(draw).toBeLessThanOrEqual(5000);
  });

  it('draws nothing when there is no credit', () => {
    expect(planCreditDraw({ amountDueCents: 20000, accountBalanceCents: 0 })).toBe(0);
  });

  it('draws nothing when nothing is owed', () => {
    expect(planCreditDraw({ amountDueCents: 0, accountBalanceCents: 12000 })).toBe(0);
  });

  it('treats a negative balance as no credit rather than as a debt to collect', () => {
    // A negative here would otherwise be drawn as a negative payment, which
    // would RAISE the invoice's balance.
    expect(planCreditDraw({ amountDueCents: 20000, accountBalanceCents: -500 })).toBe(0);
  });

  it('treats a negative amountDue as nothing owed', () => {
    expect(planCreditDraw({ amountDueCents: -500, accountBalanceCents: 12000 })).toBe(0);
  });
});

describe('readAccountBalanceCents: a broken balance is no credit, never a negative one', () => {
  it('reads a stored integer', () => {
    expect(readAccountBalanceCents(12000)).toBe(12000);
  });

  it('reads an absent or broken balance as zero', () => {
    expect(readAccountBalanceCents(undefined)).toBe(0);
    expect(readAccountBalanceCents(null)).toBe(0);
    expect(readAccountBalanceCents('12000')).toBe(0);
    expect(readAccountBalanceCents(Number.NaN)).toBe(0);
  });

  it('names the stored field once, so redeemCredit and this cannot drift', () => {
    expect(ACCOUNT_BALANCE_FIELD).toBe('accountBalanceCents');
  });
});

describe('invoiceAcceptsCredit: the same refusals a manual payment gets', () => {
  const open = { kinfolkId: 'fam1', status: 'open', total: 127.5 };

  it('accepts an open invoice with a balance', () => {
    expect(invoiceAcceptsCredit(open, [])).toBe(true);
  });

  it('refuses a draft, a quote, a cancelled invoice and a credit note', () => {
    // Credit landing on a credit note is exactly as wrong when a trigger did it,
    // and worse, because nobody was watching.
    for (const status of ['draft', 'quote', 'cancelled', 'credit']) {
      expect(invoiceAcceptsCredit({ ...open, status }, []), status).toBe(false);
    }
  });

  it('refuses an invoice its payments already cover', () => {
    expect(invoiceAcceptsCredit(open, [{ amountCents: 12750 }])).toBe(false);
  });

  it('refuses a paid-labelled invoice with no recorded payments', () => {
    expect(invoiceAcceptsCredit({ ...open, status: 'paid' }, [])).toBe(false);
  });

  it('refuses an invoice worth nothing, which classifies as settled', () => {
    expect(invoiceAcceptsCredit({ kinfolkId: 'fam1', status: 'open' }, [])).toBe(false);
  });

  it('ACCEPTS a part-paid invoice, which is the ordinary case for a top-up', () => {
    expect(invoiceAcceptsCredit(open, [{ amountCents: 2000 }])).toBe(true);
  });
});

interface Seed {
  invoice?: Record<string, unknown> | null;
  subPayments?: Array<{ id: string; data: Record<string, unknown> }>;
  family?: Record<string, unknown> | null;
}

function seed(s: Seed = {}) {
  return buildDbMock({
    docs: {
      'invoices/inv1': s.invoice === undefined ? { kinfolkId: 'fam1', status: 'open', total: 127.5 } : s.invoice,
      'families/fam1': s.family === undefined ? { accountBalanceCents: 12000 } : s.family,
    },
    queryDocs: { 'invoices/inv1/payments': s.subPayments ?? [] },
  });
}

function writeAt(ctx: ReturnType<typeof seed>, prefix: string) {
  return ctx.writes.find((w) => w.path.startsWith(prefix));
}

describe('drawAccountCredit: the pass that finally spends the balance', () => {
  it('puts the credit on the bill, decrements the balance, and settles the invoice', async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'open', total: 100 } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await drawAccountCredit(ctx.db as any, { invoiceId: 'inv1', actorUid: 'admin1' });

    expect(res.skipped).toBeNull();
    expect(res.appliedCents).toBe(10000);
    expect(res.amountDueCents).toBe(0);
    // $120 held, $100 spent, $20 left for the invoice after this one.
    expect(res.accountBalanceCents).toBe(2000);

    // THE MONEY AUTHORITY gets a row, so the balance is derived from payments
    // and not from a scalar somebody set.
    const sub = writeAt(ctx, 'invoices/inv1/payments/');
    expect(sub?.data).toMatchObject({
      amountCents: 10000,
      amount: 100,
      method: ACCOUNT_CREDIT_METHOD,
      recordedBy: 'admin1',
      fromAccountCredit: true,
    });

    // The family balance moves by an INCREMENT, not a read-then-write, so two
    // invoices created in the same second cannot each spend the same credit.
    const fam = writeAt(ctx, 'families/fam1');
    expect(fam?.data[ACCOUNT_BALANCE_FIELD]).toEqual({ __increment: -10000 });

    const inv = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(inv?.data).toMatchObject({ status: 'paid', paymentStatus: 'PAID', amountDueCents: 0 });
  });

  it('leaves the invoice OPEN and part paid when the credit does not cover it', () => {
    const ctx = seed({ family: { accountBalanceCents: 5000 } });
    mocks.dbFn.mockReturnValue(ctx.db);

    return drawAccountCredit(ctx.db as any, { invoiceId: 'inv1', actorUid: 'admin1' }).then((res) => {
      expect(res.appliedCents).toBe(5000);
      expect(res.amountDueCents).toBe(7750);
      expect(res.accountBalanceCents).toBe(0);
      const inv = ctx.writes.find((w) => w.path === 'invoices/inv1');
      expect(inv?.data).toMatchObject({ status: 'open', paymentStatus: 'PARTIAL' });
    });
  });

  it('never overdraws: a balance bigger than the bill leaves the rest on account', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', total: 20 },
      family: { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await drawAccountCredit(ctx.db as any, { invoiceId: 'inv1', actorUid: 'a' });
    expect(res.appliedCents).toBe(2000);
    expect(res.accountBalanceCents).toBe(10000);
    const inv = ctx.writes.find((w) => w.path === 'invoices/inv1');
    // Settled, NOT overpaid: auto-apply must not manufacture an excess the
    // operator then has to unpick.
    expect(inv?.data).toMatchObject({ status: 'paid', overpaidCents: 0 });
  });
});

describe('drawAccountCredit: every way it correctly does nothing', () => {
  async function skipReason(s: Seed) {
    const ctx = seed(s);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await drawAccountCredit(ctx.db as any, { invoiceId: 'inv1', actorUid: 'a' });
    return { res, ctx };
  }

  it('reports a missing invoice rather than throwing at a trigger', async () => {
    const { res, ctx } = await skipReason({ invoice: null });
    expect(res.skipped).toBe('invoice_missing');
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports an invoice with no household', async () => {
    const { res, ctx } = await skipReason({ invoice: { status: 'open', total: 40 } });
    expect(res.skipped).toBe('no_household');
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports a draft as not collectable, and writes nothing', async () => {
    const { res, ctx } = await skipReason({
      invoice: { kinfolkId: 'fam1', status: 'draft', total: 40 },
    });
    expect(res.skipped).toBe('invoice_not_collectable');
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports an already-settled invoice as not collectable', async () => {
    const { res, ctx } = await skipReason({ subPayments: [{ id: 'p1', data: { amountCents: 12750 } }] });
    expect(res.skipped).toBe('invoice_not_collectable');
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports no credit when the household holds none, and writes nothing', async () => {
    const { res, ctx } = await skipReason({ family: { accountBalanceCents: 0 } });
    expect(res.skipped).toBe('no_credit');
    expect(res.amountDueCents).toBe(12750);
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports no credit when the family doc does not exist at all', async () => {
    const { res } = await skipReason({ family: null });
    expect(res.skipped).toBe('no_credit');
  });

  it('is IDEMPOTENT: a second pass over a drained balance finds nothing', async () => {
    // The whole reason `runAutoApply` is safe to press twice.
    const { res } = await skipReason({ family: { accountBalanceCents: 0 } });
    expect(res.skipped).toBe('no_credit');
    expect(res.appliedCents).toBe(0);
  });
});
