import { describe, it, expect } from 'vitest';
import { parseArgs, planInvoice, run } from '../backfillBroughtOverPaid';

/** Brought over: the old system's text payment record marks it. Total $40, stated $25. */
const BROUGHT = { total: 40, amountDue: 25, status: 'open', paymentsHistory: 'Paid $15.00 by check' };

describe('backfillBroughtOverPaid parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', allowProd: false, pageSize: 300 });
  });
  it('--allow-prod applies, and an explicit --dry-run wins in either order', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('refuses a flag as the project and a nonsense page size', () => {
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow();
    expect(() => parseArgs(['--page-size', '0'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});

describe('backfillBroughtOverPaid planInvoice', () => {
  it('stamps total minus stated on a brought-over invoice with no rows', () => {
    expect(planInvoice(BROUGHT, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 1500 });
  });
  it('stamps the whole total on one brought over paid in full', () => {
    expect(planInvoice({ ...BROUGHT, status: 'paid', amountDue: 0 }, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 4000 });
  });
  it('stamps when the old system answers "Yes" and states $0, or "No" and states money', () => {
    expect(planInvoice({ ...BROUGHT, status: 'Yes', amountDue: 0 }, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 4000 });
    expect(planInvoice({ ...BROUGHT, status: ' no ', amountDue: 25 }, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 1500 });
  });
  it('with no status, the figures alone decide', () => {
    const { status: _drop, ...noStatus } = BROUGHT;
    expect(planInvoice(noStatus, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 1500 });
    expect(planInvoice({ ...BROUGHT, status: '' }, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 1500 });
    expect(planInvoice({ ...BROUGHT, status: null }, 0)).toMatchObject({ verdict: 'stamp', broughtOverPaidCents: 1500 });
  });
  it('lists, never stamps, "No" with $0 stated: the data contradicts itself', () => {
    expect(planInvoice({ ...BROUGHT, status: 'No', amountDue: 0 }, 0)).toMatchObject({ verdict: 'status_disagrees', broughtOverPaidCents: null });
    // Named as the contradiction even when the total is $0 as well.
    expect(planInvoice({ ...BROUGHT, status: 'No', total: 0, amountDue: 0 }, 0).verdict).toBe('status_disagrees');
    // The app's own unpaid labels read the same way.
    expect(planInvoice({ ...BROUGHT, status: 'open', amountDue: 0 }, 0).verdict).toBe('status_disagrees');
    expect(planInvoice({ ...BROUGHT, status: 'overdue', amountDue: 0 }, 0).verdict).toBe('status_disagrees');
  });
  it('lists, never stamps, "Yes" with money still stated', () => {
    expect(planInvoice({ ...BROUGHT, status: 'Yes', total: 127.5, amountDue: 117.5 }, 0)).toMatchObject({
      verdict: 'status_disagrees',
      broughtOverPaidCents: null,
    });
    expect(planInvoice({ ...BROUGHT, status: 'paid', amountDue: 25 }, 0).verdict).toBe('status_disagrees');
  });
  it('lists a status that answers neither, a write-off above all', () => {
    // A write-off zeroes the stated balance; read as paid in full it would invent $40 of payments.
    expect(planInvoice({ ...BROUGHT, status: 'written_off', amountDue: 0 }, 0)).toMatchObject({
      verdict: 'status_unreadable',
      broughtOverPaidCents: null,
    });
    for (const status of ['cancelled', 'draft', 'quote', 'maybe', true, 1]) {
      expect(planInvoice({ ...BROUGHT, status }, 0).verdict).toBe('status_unreadable');
    }
  });
  it('a $0 invoice with $0 stated had nothing paid and is not listed', () => {
    expect(planInvoice({ ...BROUGHT, status: 'Yes', total: 0, amountDue: 0 }, 0).verdict).toBe('nothing_paid');
    expect(planInvoice({ ...BROUGHT, status: 'zero', total: 0, amountDue: 0 }, 0).verdict).toBe('nothing_paid');
  });
  it('prefers the integer cents fields when present', () => {
    expect(planInvoice({ ...BROUGHT, totalCents: 4001, amountDueCents: 2499 }, 0)).toMatchObject({ broughtOverPaidCents: 1502 });
  });
  it('never stamps an invoice whose stated balance is missing', () => {
    const { amountDue: _drop, ...noStated } = BROUGHT;
    expect(planInvoice(noStated, 0)).toMatchObject({ verdict: 'no_stated_balance', broughtOverPaidCents: null });
  });
  it('lists one with payment rows: total minus stated is then the rows', () => {
    expect(planInvoice(BROUGHT, 1)).toMatchObject({ verdict: 'has_payment_rows', broughtOverPaidCents: null });
  });
  it('leaves alone what was not brought over, is stamped, or had nothing paid', () => {
    const { paymentsHistory: _drop, ...native } = BROUGHT;
    expect(planInvoice(native, 0).verdict).toBe('not_brought_over');
    expect(planInvoice({ ...BROUGHT, broughtOverPaidCents: 1500 }, 0).verdict).toBe('already_stamped');
    expect(planInvoice({ ...BROUGHT, amountDue: 40 }, 0).verdict).toBe('nothing_paid');
  });
  it('lists a credit, a balance above the total and a missing total', () => {
    expect(planInvoice({ ...BROUGHT, amountDue: -5 }, 0).verdict).toBe('credit');
    expect(planInvoice({ ...BROUGHT, amountDue: 50 }, 0).verdict).toBe('stated_above_total');
    expect(planInvoice({ ...BROUGHT, total: 0 }, 0).verdict).toBe('no_total');
  });
});

/** A minimal paged Firestore: one page, `payments` sizes by id, batch writes captured. */
function fakeDb(invoices: Record<string, Record<string, unknown>>, rows: Record<string, number> = {}) {
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  let commits = 0;
  const docSnaps = Object.entries(invoices).map(([id, data]) => ({
    id,
    data: () => data,
    ref: {
      id,
      collection: () => ({ limit: () => ({ get: async () => ({ size: rows[id] ?? 0 }) }) }),
    },
  }));
  const query = {
    orderBy: () => query,
    limit: () => query,
    startAfter: () => ({ get: async () => ({ docs: [] }) }),
    get: async () => ({ docs: docSnaps }),
  };
  const db = {
    collection: () => query,
    batch: () => ({
      set: (ref: { id: string }, data: Record<string, unknown>) => writes.push({ id: ref.id, data }),
      commit: async () => {
        commits += 1;
      },
    }),
  };
  return { db: db as never, writes, commits: () => commits };
}

describe('backfillBroughtOverPaid run', () => {
  it('a dry run plans the stamp and commits nothing', async () => {
    const f = fakeDb({ a: BROUGHT, b: { ...BROUGHT }, c: { total: 40, amountDue: 25 } }, { b: 1 });
    const r = await run('dry-run', 300, f.db);
    expect(r).toMatchObject({ scanned: 3, stamped: 1 });
    expect(r.byVerdict).toMatchObject({ stamp: 1, has_payment_rows: 1, not_brought_over: 1 });
    expect(r.listed).toEqual([
      { invoiceId: 'b', verdict: 'has_payment_rows', totalCents: 4000, statedCents: 2500, paymentRowCount: 1, status: 'open' },
    ]);
    expect(f.commits()).toBe(0);
  });

  it('an apply writes nothing on a contradiction and lists it with its status', async () => {
    const f = fakeDb({
      no: { ...BROUGHT, status: 'No', amountDue: 0 },
      yes: { ...BROUGHT, status: 'Yes', amountDue: 0 },
      off: { ...BROUGHT, status: 'written_off', amountDue: 0 },
    });
    const r = await run('apply', 300, f.db);
    expect(f.writes).toEqual([{ id: 'yes', data: { broughtOverPaidCents: 4000 } }]);
    expect(r.byVerdict).toMatchObject({ stamp: 1, status_disagrees: 1, status_unreadable: 1 });
    expect(r.listed.map((l) => [l.invoiceId, l.verdict, l.status])).toEqual([
      ['no', 'status_disagrees', 'No'],
      ['off', 'status_unreadable', 'written_off'],
    ]);
  });

  it('an apply writes the field alone', async () => {
    const f = fakeDb({ a: BROUGHT });
    await run('apply', 300, f.db);
    expect(f.writes).toEqual([{ id: 'a', data: { broughtOverPaidCents: 1500 } }]);
    expect(f.commits()).toBe(1);
  });
});
