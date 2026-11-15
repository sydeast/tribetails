import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  parseArgs,
  planInvoiceBackfill,
  isAppliedCardLedgerRow,
  run,
  type StoredRow,
} from '../backfillCardInvoicePayments';

describe('backfillCardInvoicePayments parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', allowProd: false, pageSize: 300 });
  });

  it('--allow-prod is the only way to an apply run', () => {
    expect(parseArgs(['--allow-prod'])).toMatchObject({ mode: 'apply', allowProd: true });
  });

  it('an explicit --dry-run wins over --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('--project needs a value that is not a flag, and unknown args are refused', () => {
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--page-size', '0'])).toThrow();
  });
});

const PAID = {
  kinfolkId: 'fam1',
  invoiceNumber: '1029',
  status: 'paid',
  total: 40,
  totalCents: 4000,
  amountDue: 0,
  amountDueCents: 0,
  editScope: 'all',
};
const card = (id: string, cents: number, over: Record<string, unknown> = {}): StoredRow => ({
  id,
  data: {
    kinfolkId: 'fam1',
    invoiceId: 'inv1',
    amount: cents,
    amountCents: cents,
    amountResolved: true,
    amountSource: 'stripe-event',
    paymentMethod: 'stripe',
    referenceNumber: `pi_${id}`,
    stripeEventId: id,
    date: '2026-10-01T15:00:00.000Z',
    ...over,
  },
});
const hand = (id: string, cents: number): StoredRow => ({ id, data: { amount: cents / 100, amountCents: cents, method: 'cash' } });

describe('backfillCardInvoicePayments: which ledger rows are applied card payments', () => {
  it('a webhook row that paid an invoice is one', () => {
    expect(isAppliedCardLedgerRow(card('evt_1', 4000).data)).toBe(true);
  });

  it('a row held for the owner, decided by the owner, or not a card row is not', () => {
    expect(isAppliedCardLedgerRow(card('evt_1', 4000, { needsAdminDecision: true, appliedToInvoice: false, appliedTo: 'unapplied' }).data)).toBe(false);
    expect(isAppliedCardLedgerRow(card('evt_1', 4000, { appliedTo: 'adminDecision', adminDecision: {} }).data)).toBe(false);
    expect(isAppliedCardLedgerRow(card('evt_1', 4000, { appliedTo: 'accountCredit' }).data)).toBe(false);
    expect(isAppliedCardLedgerRow({ paymentMethod: 'venmo', invoiceId: 'inv1' })).toBe(false);
    expect(isAppliedCardLedgerRow(card('evt_1', 4000, { invoiceId: '' }).data)).toBe(false);
  });
});

describe('backfillCardInvoicePayments planInvoiceBackfill', () => {
  it('a part payment by hand plus the card payoff: writes the card row, and the rows then cover the total', () => {
    const plan = planInvoiceBackfill('inv1', PAID, [hand('h1', 1500)], [card('evt_1', 2500)]);
    expect(plan).toMatchObject({
      action: 'write',
      invoiceNumber: '1029',
      invoiceUpdate: { paymentStatus: 'PAID', totalCents: 4000, paidCents: 4000, overpaidCents: 0, status: 'paid', editScope: 'none' },
    });
    expect(plan.action === 'write' && plan.rows).toEqual([
      {
        rowId: 'stripe_pi_evt_1',
        ledgerId: 'evt_1',
        amountCents: 2500,
        row: {
          amount: 25,
          amountCents: 2500,
          method: 'stripe',
          reference: 'pi_evt_1',
          paidAt: '2026-10-01T15:00:00.000Z',
          recordedBy: 'system:stripe',
          sourcePaymentId: 'evt_1',
          stripeEventId: 'evt_1',
          stripePaymentIntentId: 'pi_evt_1',
          backfilledBy: 'backfillCardInvoicePayments',
        },
      },
    ]);
    // It never states a balance or a status the invoice did not already have.
    expect(plan.action === 'write' && 'amountDueCents' in plan.invoiceUpdate).toBe(false);
  });

  it('an invoice paid by card alone gets its one row', () => {
    const plan = planInvoiceBackfill('inv1', PAID, [], [card('evt_1', 4000)]);
    expect(plan.action === 'write' && plan.rows.map((r) => [r.rowId, r.amountCents])).toEqual([['stripe_pi_evt_1', 4000]]);
  });

  it('two card payments on one invoice are written together when they close it', () => {
    const invoice = { ...PAID, total: 187.5, totalCents: 18750 };
    const plan = planInvoiceBackfill('inv1', invoice, [], [card('evt_1', 13750), card('evt_2', 5000)]);
    expect(plan.action === 'write' && plan.rows.map((r) => r.amountCents)).toEqual([13750, 5000]);
  });

  it('both events of one charge, from before the per-payment claim, are one row', () => {
    const plan = planInvoiceBackfill('inv1', PAID, [], [card('evt_a', 4000, { referenceNumber: 'pi_1' }), card('evt_b', 4000, { referenceNumber: 'pi_1' })]);
    expect(plan.action === 'write' && plan.rows.map((r) => r.rowId)).toEqual(['stripe_pi_1']);
  });

  it('is idempotent: a row already on the invoice is skipped, by id or by its source', () => {
    const byId = planInvoiceBackfill('inv1', PAID, [{ id: 'stripe_pi_evt_1', data: { amountCents: 4000 } }], [card('evt_1', 4000)]);
    expect(byId).toEqual({ action: 'skip', invoiceId: 'inv1', reason: 'already_recorded' });
    const bySource = planInvoiceBackfill('inv1', PAID, [{ id: 'auto', data: { amountCents: 4000, sourcePaymentId: 'evt_1' } }], [card('evt_1', 4000)]);
    expect(bySource.action).toBe('skip');
  });

  it('only fills the gap the missing row leaves when another is already there', () => {
    const invoice = { ...PAID, total: 187.5, totalCents: 18750 };
    const plan = planInvoiceBackfill('inv1', invoice, [{ id: 'stripe_pi_evt_2', data: { amountCents: 5000, sourcePaymentId: 'evt_2' } }], [card('evt_1', 13750), card('evt_2', 5000)]);
    expect(plan.action === 'write' && plan.rows.map((r) => r.ledgerId)).toEqual(['evt_1']);
  });

  it('reports, and writes nothing, when the rows would come to more than the total', () => {
    // The card-paid part was since recorded again by hand, or the card paid a tip.
    const plan = planInvoiceBackfill('inv1', PAID, [hand('h1', 1500), hand('h2', 2500)], [card('evt_1', 2500)]);
    expect(plan).toMatchObject({ action: 'report', reason: 'would_overpay', totalCents: 4000, rowsCents: 4000, cardCents: 2500 });
  });

  it('reports when they would still fall short: a paid invoice is not turned into a part-paid one', () => {
    expect(planInvoiceBackfill('inv1', PAID, [], [card('evt_1', 2500)])).toMatchObject({ action: 'report', reason: 'still_short' });
  });

  it('reports an invoice that is open again or states a balance: it never lowers what is owed', () => {
    const reopened = { ...PAID, status: 'open', amountDue: 25, amountDueCents: 2500 };
    expect(planInvoiceBackfill('inv1', reopened, [hand('h1', 1500)], [card('evt_1', 2500)])).toMatchObject({ action: 'report', reason: 'not_marked_paid' });
    const paidWithBalance = { ...PAID, amountDue: 25, amountDueCents: 2500 };
    expect(planInvoiceBackfill('inv1', paidWithBalance, [hand('h1', 1500)], [card('evt_1', 2500)])).toMatchObject({ reason: 'not_marked_paid' });
  });

  it('reports a missing invoice, a missing total and an amount Stripe never gave', () => {
    expect(planInvoiceBackfill('inv1', null, [], [card('evt_1', 4000)])).toMatchObject({ action: 'report', reason: 'invoice_missing' });
    expect(planInvoiceBackfill('inv1', { status: 'paid', amountDue: 0 }, [], [card('evt_1', 4000)])).toMatchObject({ reason: 'no_total' });
    const unresolved = card('evt_1', 0, { amount: null, amountCents: null, amountResolved: false, amountSource: 'unresolved' });
    expect(planInvoiceBackfill('inv1', PAID, [], [unresolved])).toMatchObject({ reason: 'amount_unresolved' });
  });

  it('reads a ledger amount stored only as cents-in-amount by the shared rule', () => {
    const legacy = card('evt_1', 4000);
    delete legacy.data['amountCents'];
    const plan = planInvoiceBackfill('inv1', PAID, [], [legacy]);
    expect(plan.action === 'write' && plan.rows[0]!.amountCents).toBe(4000);
  });
});

/**
 * A fake Firestore over a flat path map. Reads are served; every write goes
 * through `onWrite`, which a dry-run test makes throw.
 */
function fakeDb(docs: Record<string, Record<string, unknown>>, onWrite: (kind: string, path: string, data: unknown) => void) {
  const snap = (path: string) => ({
    id: path.split('/').pop()!,
    exists: docs[path] !== undefined,
    data: () => docs[path],
    ref: docRef(path),
  });
  const children = (col: string) =>
    Object.keys(docs)
      .filter((p) => p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes('/'))
      .sort();
  const docRef = (path: string): any => ({
    path,
    id: path.split('/').pop()!,
    collection: (sub: string) => collection(`${path}/${sub}`),
    get: async () => snap(path),
    set: (data: unknown) => onWrite('ref.set', path, data),
    update: (data: unknown) => onWrite('ref.update', path, data),
    delete: () => onWrite('ref.delete', path, null),
  });
  const query = (col: string, after: string | null, limit: number): any => ({
    limit: (n: number) => query(col, after, n),
    startAfter: (cursor: string) => query(col, cursor, limit),
    get: async () => {
      const all = children(col);
      const start = after === null ? 0 : all.indexOf(`${col}/${after}`) + 1;
      return { docs: all.slice(start, start + limit).map(snap) };
    },
  });
  const collection = (col: string): any => ({
    path: col,
    doc: (id: string) => docRef(`${col}/${id}`),
    orderBy: () => query(col, null, Number.MAX_SAFE_INTEGER),
    get: async () => ({ docs: children(col).map(snap) }),
    add: (data: unknown) => onWrite('collection.add', col, data),
  });
  const db = {
    collection,
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const staged: Array<() => void> = [];
      const result = await fn({
        get: (target: any) => target.get(),
        create: (ref: any, data: Record<string, unknown>) =>
          staged.push(() => {
            if (docs[ref.path] !== undefined) throw new Error(`ALREADY_EXISTS: ${ref.path}`);
            onWrite('tx.create', ref.path, data);
            docs[ref.path] = data;
          }),
        set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
          staged.push(() => {
            onWrite('tx.set', ref.path, data);
            docs[ref.path] = opts?.merge ? { ...(docs[ref.path] ?? {}), ...data } : data;
          }),
      });
      for (const apply of staged) apply();
      return result;
    },
  };
  return db as unknown as Firestore;
}

const fixture = (): Record<string, Record<string, unknown>> => ({
  // Part paid by hand, paid off by card: the one this issue is about.
  'invoices/inv1': { ...PAID },
  'invoices/inv1/payments/h1': hand('h1', 1500).data,
  'payments/evt_1': card('evt_1', 2500).data,
  // Paid by card alone.
  'invoices/inv2': { ...PAID, invoiceNumber: '1030' },
  'payments/evt_2': card('evt_2', 4000, { invoiceId: 'inv2' }).data,
  // Reopened after the card payment: reported, not written.
  'invoices/inv3': { ...PAID, status: 'open', amountDue: 25, amountDueCents: 2500 },
  'invoices/inv3/payments/h3': hand('h3', 1500).data,
  'payments/evt_3': card('evt_3', 2500, { invoiceId: 'inv3' }).data,
  // Held for the owner: not a payment the webhook applied.
  'payments/evt_4': card('evt_4', 4000, { invoiceId: 'inv2', needsAdminDecision: true, appliedToInvoice: false, appliedTo: 'unapplied' }).data,
  // A hand-recorded ledger row: not a card payment.
  'payments/pay_5': { kinfolkId: 'fam1', invoiceId: 'inv1', paymentMethod: 'cash', amountCents: 1500 },
});

describe('backfillCardInvoicePayments run()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a dry run plans the writes and writes nothing, against a db where any write throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const docs = fixture();
    const before = JSON.stringify(docs);
    const db = fakeDb(docs, (kind, path) => {
      throw new Error(`ILLEGAL WRITE in dry-run: ${kind} ${path}`);
    });

    const result = await run('dry-run', 2, db);

    expect(result).toMatchObject({ scanned: 5, cardPayments: 3, invoices: 3, invoicesWritten: 2, rowsWritten: 2, alreadyRecorded: 0 });
    expect(result.reported.not_marked_paid).toBe(1);
    expect(result.reports.map((r) => r.invoiceId)).toEqual(['inv3']);
    expect(JSON.stringify(docs)).toBe(before);
  });

  it('the same fake does catch a write, so the tripwire is armed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = fakeDb(fixture(), (kind, path) => {
      throw new Error(`ILLEGAL WRITE in dry-run: ${kind} ${path}`);
    });
    await expect(run('apply', 2, db)).rejects.toThrow(/ILLEGAL WRITE in dry-run: tx\.create/);
  });

  it('apply writes the rows, the invoice figures and the ledger link, and nothing on the reported invoice', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const docs = fixture();
    const written: string[] = [];
    const db = fakeDb(docs, (_kind, path) => {
      written.push(path);
    });

    const result = await run('apply', 2, db);

    expect(result).toMatchObject({ invoicesWritten: 2, rowsWritten: 2 });
    expect([...written].sort()).toEqual([
      'invoices/inv1',
      'invoices/inv1/payments/stripe_pi_evt_1',
      'invoices/inv2',
      'invoices/inv2/payments/stripe_pi_evt_2',
      'payments/evt_1',
      'payments/evt_2',
    ]);
    expect(docs['invoices/inv1/payments/stripe_pi_evt_1']).toMatchObject({ amountCents: 2500, method: 'stripe', sourcePaymentId: 'evt_1' });
    expect(docs['invoices/inv1']).toMatchObject({
      status: 'paid',
      amountDueCents: 0,
      paymentStatus: 'PAID',
      paidCents: 4000,
      totalCents: 4000,
      editScope: 'none',
    });
    expect(docs['payments/evt_1']).toMatchObject({
      amountCents: 2500,
      appliedInvoiceId: 'inv1',
      appliedInvoiceNumber: '1029',
      appliedCents: 2500,
      invoicePaymentId: 'stripe_pi_evt_1',
    });
    // The reopened invoice and the held payment are exactly as they were.
    expect(docs['invoices/inv3']).toEqual(fixture()['invoices/inv3']);
    expect(docs['payments/evt_3']).toEqual(fixture()['payments/evt_3']);
    expect(docs['payments/evt_4']).toEqual(fixture()['payments/evt_4']);

    // A second run finds nothing left to write.
    written.length = 0;
    const again = await run('apply', 2, db);
    expect(again).toMatchObject({ invoicesWritten: 0, rowsWritten: 0, alreadyRecorded: 2 });
    expect(written).toEqual([]);
  });
});
