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
 * ACCOUNT CREDIT, and the draw that spends an entered amount of it.
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

const KEY = 'acr_1790000000000_abc123';

/** One draw of an entered amount, with the fields every call needs. */
function draw(ctx: ReturnType<typeof seed>, amountCents: number, over: Record<string, unknown> = {}) {
  return drawAccountCredit(ctx.db as any, {
    invoiceId: 'inv1',
    actorUid: 'admin1',
    amountCents,
    paymentId: KEY,
    ...over,
  });
}

describe('drawAccountCredit: the amount the admin entered, exactly (#1872)', () => {
  it('puts that amount on the bill, takes it off the balance, and leaves the invoice open', async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'open', total: 100 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await draw(ctx, 2500);
    expect(res.refused).toBeNull();
    expect(res.replayed).toBe(false);
    expect(res.appliedCents).toBe(2500);

    // $100 owed, $25 applied; $120 held, $95 left. It did NOT take the $100 it could have.
    expect(res.amountDueCents).toBe(7500);
    expect(res.accountBalanceCents).toBe(9500);

    // THE MONEY AUTHORITY gets a row at the caller's key.
    const sub = ctx.writes.find((w) => w.path === `invoices/inv1/payments/${KEY}`);
    expect(sub?.data).toMatchObject({
      amountCents: 2500,
      amount: 25,
      method: ACCOUNT_CREDIT_METHOD,
      recordedBy: 'admin1',
      fromAccountCredit: true,
      accountBalanceAfterCents: 9500,
      amountDueAfterCents: 7500,
    });
    // The family balance is written as an ABSOLUTE remainder, derived from the
    // balance read inside the SAME transaction (#830).
    const fam = writeAt(ctx, 'families/fam1');
    expect(fam?.data[ACCOUNT_BALANCE_FIELD]).toBe(9500);
    const inv = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(inv?.data).toMatchObject({ status: 'open', paymentStatus: 'PARTIAL', amountDueCents: 7500 });
  });
  it('pays the invoice off when the amount entered is the whole balance due', async () => {
    const ctx = seed({ invoice: { kinfolkId: 'fam1', status: 'open', total: 100 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await draw(ctx, 10000);
    expect(res.appliedCents).toBe(10000);
    expect(res.amountDueCents).toBe(0);
    expect(res.accountBalanceCents).toBe(2000);
    const inv = ctx.writes.find((w) => w.path === 'invoices/inv1');
    expect(inv?.data).toMatchObject({ status: 'paid', paymentStatus: 'PAID', overpaidCents: 0 });
  });
  it('may take the household balance to exactly zero', async () => {
    const ctx = seed({ family: { accountBalanceCents: 5000 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await draw(ctx, 5000);
    expect(res.accountBalanceCents).toBe(0);
    expect(res.amountDueCents).toBe(7750);
  });
  it('Q6: records the draw in the credit history, in the same transaction, with the balance before and after', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', total: 20, invoiceNumber: 'INV-1042' },
      family: { accountBalanceCents: 12000 },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await draw(ctx, 2000);
    const event = ctx.writes.find((w) => w.path === `families/fam1/creditLedger/draw_${KEY}`);
    expect(event?.data).toMatchObject({
      kind: 'draw',
      amountCents: 2000,
      invoiceId: 'inv1',
      invoiceNumber: 'INV-1042',
      paymentId: KEY,
      heldBeforeCents: 12000,
      heldAfterCents: 10000,
      actorUid: 'admin1',
    });
    expect(typeof event?.data['atMs']).toBe('number');
  });
  it('writes the Activity Log line in the same transaction, sealed onto the chain', async () => {
    const ctx = seed({
      invoice: { kinfolkId: 'fam1', status: 'open', total: 100, invoiceNumber: '1026' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await draw(ctx, 2500);

    // Every write of the draw went through the ONE transaction.
    expect((ctx.db as any).runTransaction).toHaveBeenCalledTimes(1);
    const entry = ctx.writes.find((w) => w.path === `activity_log/account_credit_applied_${KEY}`);
    expect(entry?.data).toMatchObject({
      actionType: 'BILLING_ACCOUNT_CREDIT_APPLIED',
      description: 'Applied $25.00 account credit to invoice 1026',
      status: 'SUCCESS',
      actorId: 'admin1',
      targetId: 'inv1',
      targetCollection: 'invoices',
      familyId: 'fam1',
      seq: 1,
    });
    expect(entry?.data['payload']).toMatchObject({
      amountCents: 2500,
      balanceBeforeCents: 12000,
      balanceAfterCents: 9500,
      amountDueBeforeCents: 10000,
      amountDueAfterCents: 7500,
    });
    expect(String(entry?.data['entryHash'])).toMatch(/^[0-9a-f]{64}$/);
    const head = ctx.writes.find((w) => w.path === 'activity_log_chain_head/current');
    expect(head?.data).toMatchObject({ seq: 1, lastEntryId: `account_credit_applied_${KEY}` });
  });
});
describe('drawAccountCredit: every refusal names its reason and writes nothing', () => {
  async function refusal(s: Seed, amountCents = 1000) {
    const ctx = seed(s);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await draw(ctx, amountCents);
    expect(ctx.writes).toHaveLength(0);
    expect(res.appliedCents).toBe(0);
    return res;
  }

  it('more than the household holds', async () => {
    const res = await refusal({ family: { accountBalanceCents: 500 } }, 501);
    expect(res.refused).toBe('over_credit');
    expect(res.accountBalanceCents).toBe(500);
  });
  it('a household with no credit at all, and one with no family document', async () => {
    expect((await refusal({ family: { accountBalanceCents: 0 } })).refused).toBe('over_credit');
    expect((await refusal({ family: null })).refused).toBe('over_credit');
  });
  it('an ALREADY negative stored balance is no credit', async () => {
    expect((await refusal({ family: { accountBalanceCents: -500 } })).refused).toBe('over_credit');
  });

  it('more than the invoice still owes, with a part payment counted', async () => {
    // $127.50 total, $100 already paid: $27.50 left.
    const res = await refusal({ subPayments: [{ id: 'p1', data: { amountCents: 10000 } }] }, 2751);
    expect(res.refused).toBe('over_balance');
    expect(res.amountDueCents).toBe(2750);
  });

  it('never trims a request down to what fits', async () => {
    // The old pass would have drawn $127.50 of the $200 asked. Now: refused.
    const res = await refusal({ family: { accountBalanceCents: 50000 } }, 20000);
    expect(res.refused).toBe('over_balance');
  });

  it('zero, a negative amount and a fraction of a cent', async () => {
    expect((await refusal({}, 0)).refused).toBe('amount_invalid');
    expect((await refusal({}, -500)).refused).toBe('amount_invalid');
    expect((await refusal({}, 10.5)).refused).toBe('amount_invalid');
    expect((await refusal({}, Number.NaN)).refused).toBe('amount_invalid');
  });

  it('a draft', async () => {
    expect((await refusal({ invoice: { kinfolkId: 'fam1', status: 'draft', total: 40 } })).refused).toBe(
      'invoice_draft',
    );
  });

  it('a quote', async () => {
    expect((await refusal({ invoice: { kinfolkId: 'fam1', status: 'quote', total: 40 } })).refused).toBe(
      'invoice_quote',
    );
  });

  it('a paid invoice, by its payments or by its label', async () => {
    expect((await refusal({ subPayments: [{ id: 'p1', data: { amountCents: 12750 } }] })).refused).toBe(
      'invoice_paid',
    );
    expect((await refusal({ invoice: { kinfolkId: 'fam1', status: 'paid', total: 40 } })).refused).toBe(
      'invoice_paid',
    );
  });

  it('an archived invoice, even one still owed', async () => {
    const res = await refusal({
      invoice: { kinfolkId: 'fam1', status: 'open', total: 40, archivedAt: '__TS__' },
    });
    expect(res.refused).toBe('invoice_archived');
  });
  it('a cancelled invoice and a credit note', async () => {
    for (const status of ['cancelled', 'credit']) {
      const res = await refusal({ invoice: { kinfolkId: 'fam1', status, total: 40 } });
      expect(res.refused, status).toBe('invoice_not_collectable');
    }
  });
  it('a missing invoice, and an invoice with no household', async () => {
    expect((await refusal({ invoice: null })).refused).toBe('invoice_missing');
    expect((await refusal({ invoice: { status: 'open', total: 40 } })).refused).toBe('no_household');
  });
});

describe('drawAccountCredit: the key is the double-tap guard', () => {
  function live(over: Record<string, Record<string, unknown> | null> = {}) {
    return buildDbMock({
      docs: {
        'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 100 },
        'families/fam1': { accountBalanceCents: 12000 },
        ...over,
      },
      queryDocs: { 'invoices/inv1/payments': [] },
      writeThrough: true,
    });
  }

  it('a second call with the same key draws nothing and returns the first answer', async () => {
    const ctx = live();
    mocks.dbFn.mockReturnValue(ctx.db);
    const first = await draw(ctx as any, 2500);
    const writesAfterFirst = ctx.writes.length;
    const second = await draw(ctx as any, 2500);
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      refused: null,
      replayed: true,
      paymentId: KEY,
      appliedCents: 2500,
      accountBalanceCents: 9500,
      amountDueCents: 7500,
    });
    expect(ctx.writes).toHaveLength(writesAfterFirst);
  });
  it('a retry after a PAY-OFF reports the success, not "already paid"', async () => {
    const ctx = live({
      // The stored row and the paid invoice, as the first call left them.
      'invoices/inv1': { kinfolkId: 'fam1', status: 'paid', total: 100, paidCents: 10000, amountDueCents: 0 },
      [`invoices/inv1/payments/${KEY}`]: {
        amountCents: 10000,
        recordedBy: 'admin1',
        fromAccountCredit: true,
        accountBalanceAfterCents: 2000,
        amountDueAfterCents: 0,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await draw(ctx as any, 10000);
    expect(res).toMatchObject({ refused: null, replayed: true, appliedCents: 10000, accountBalanceCents: 2000 });
  });

  it('refuses the same key from another admin', async () => {
    const ctx = live({
      [`invoices/inv1/payments/${KEY}`]: { amountCents: 2500, recordedBy: 'someone-else', fromAccountCredit: true },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(draw(ctx as any, 2500)).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('a NEW key is a new draw: the admin applying a second amount on purpose', async () => {
    const ctx = live();
    mocks.dbFn.mockReturnValue(ctx.db);
    await draw(ctx as any, 2500);
    const res = await draw(ctx as any, 1000, { paymentId: 'acr_1790000000001_def456' });
    expect(res.replayed).toBe(false);
    expect(res.appliedCents).toBe(1000);
    expect(res.accountBalanceCents).toBe(8500);
  });
});
