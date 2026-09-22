import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { run } from '../backfillInvoiceAmountDue';
import { run as runReport } from '../reportLegacyAmountDue';

/**
 * #902's backfill and its report, against a real Firestore.
 *
 * What the unit tests cannot prove: that the write lands as exactly the four
 * fields planned, that everything else on a MIGRATED document survives it
 * untouched — its original `createdAt` and `date` above all — and that a second
 * run plans nothing.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'amount-due-902-test';

/** The dates a migrated record carries. They are the old system's, and they stay. */
const ORIGINAL = { createdAt: '2024-03-02T09:15:00.000Z', date: '2024-03-02', dueDate: '2024-03-16' };

describe.runIf(EMULATOR)('backfillInvoiceAmountDue against the emulator (#902)', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: PROJECT });
    db = getFirestore();
    const inv = db.collection('invoices');
    // The shape this issue is about: a total, no balance, a free-text label, and
    // the dates it was migrated with.
    await inv.doc('legacy_unpaid').set({ kinfolkId: 'fam1', status: 'sent', total: 40, ...ORIGINAL });
    // The same shape, part collected through its own payments subcollection.
    await inv.doc('legacy_part_paid').set({ kinfolkId: 'fam1', status: 'sent', total: 40, ...ORIGINAL });
    await inv.doc('legacy_part_paid').collection('payments').doc('p1').set({ amountCents: 1500, amount: 15 });
    // The same shape, already covered by its rows. Writing a zero balance here is
    // an open-to-paid transition, which is what fires invoice.payment.applied, so
    // the notification guard refuses it and the operator gets the id.
    await inv.doc('legacy_settled').set({ kinfolkId: 'fam1', status: 'sent', total: 40, ...ORIGINAL });
    await inv.doc('legacy_settled').collection('payments').doc('p1').set({ amountCents: 4000, amount: 40 });
    // A migrated draft: it gets its balance and stays a draft.
    await inv.doc('legacy_draft').set({ kinfolkId: 'fam1', status: 'draft', total: 60, ...ORIGINAL });
    // Out of scope: states its own balance.
    await inv.doc('modern_open').set({ kinfolkId: 'fam1', status: 'open', editScope: 'all', amountDue: 40, total: 40 });
    // Out of scope: states no money at all.
    await inv.doc('no_money').set({ kinfolkId: 'fam1', status: 'sent' });
  }, 30_000);

  const read = async (id: string) => (await getFirestore().collection('invoices').doc(id).get()).data() ?? {};

  it('the report counts the population before anything is written, grouped by stored status', async () => {
    const r = await runReport(25);
    expect(r.scanned).toBe(6);
    expect(r.legacy).toBe(4);
    expect(r.byStatus['sent']).toMatchObject({ invoices: 3, ruleOwed: 2, ruleSettled: 1, withPaymentRows: 2 });
    expect(r.byStatus['draft']).toMatchObject({ invoices: 1, ruleOwed: 1 });
  });

  it('writes the derived balance, refuses the settled one, and touches no other field', async () => {
    const first = await run('apply', 300);
    expect(first.scanned).toBe(6);
    expect(first.written).toBe(3);
    expect(first.skipped).toEqual({
      states_balance: 1,
      no_total: 1,
      would_notify_household: 1,
      would_draw_credit: 0,
    });
    expect(first.needsOperator).toEqual(['legacy_settled']);

    expect(await read('legacy_unpaid')).toEqual({
      kinfolkId: 'fam1',
      total: 40,
      ...ORIGINAL,
      amountDue: 40,
      amountDueCents: 4000,
      status: 'open',
      editScope: 'all',
    });
    expect(await read('legacy_part_paid')).toMatchObject({ amountDue: 25, amountDueCents: 2500, status: 'open' });
    expect(await read('legacy_draft')).toMatchObject({ amountDue: 60, status: 'draft', editScope: 'all' });
    // Refused, and left EXACTLY as it was.
    expect(await read('legacy_settled')).toEqual({ kinfolkId: 'fam1', status: 'sent', total: 40, ...ORIGINAL });
  });

  it('KEEPS THE ORIGINAL TIMESTAMPS: every migrated date is the one it arrived with', async () => {
    for (const id of ['legacy_unpaid', 'legacy_part_paid', 'legacy_draft', 'legacy_settled']) {
      const doc = await read(id);
      expect(doc['createdAt'], id).toBe(ORIGINAL.createdAt);
      expect(doc['date'], id).toBe(ORIGINAL.date);
      expect(doc['dueDate'], id).toBe(ORIGINAL.dueDate);
      expect(doc['updatedAt'], id).toBeUndefined();
    }
  });

  it('a second run plans nothing: its own output is out of scope', async () => {
    const second = await run('apply', 300);
    expect(second.written).toBe(0);
    expect(second.skipped).toEqual({
      states_balance: 4,
      no_total: 1,
      would_notify_household: 1,
      would_draw_credit: 0,
    });
  });

  it('and the report now shows only what a guard refused', async () => {
    const r = await runReport(25);
    expect(r.legacy).toBe(1);
    expect(r.byStatus['sent']).toMatchObject({ invoices: 1, ruleSettled: 1 });
  });
});
