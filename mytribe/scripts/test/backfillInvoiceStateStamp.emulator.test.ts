import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { run } from '../backfillInvoiceStateStamp';

/**
 * The state stamp backfill's real write path against the emulator (#884). The
 * legacy shape (a `total`, no `amountDue`, no payment rows) classifies paid only
 * because the missing amountDue reads as 0, so it is refused as
 * `would_assert_payment` and left exactly as it was, until #902 rules.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'stamp-884-test';

describe.runIf(EMULATOR)('backfillInvoiceStateStamp against the emulator (#884 guard)', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: PROJECT });
    db = getFirestore();
    const inv = db.collection('invoices');
    // The legacy shape: a total, no amountDue, a free-text label.
    await inv.doc('legacy_total_only').set({ kinfolkId: 'fam1', status: 'sent', total: 40 });
    // The same shape, paid by card: the Stripe webhook's row is in the ROOT
    // payments collection, naming the invoice, and nothing is in its subcollection.
    await inv.doc('legacy_root_paid').set({ kinfolkId: 'fam1', status: 'sent', total: 40 });
    await db.collection('payments').doc('evt_legacy').set({ kinfolkId: 'fam1', invoiceId: 'legacy_root_paid', amountCents: 4000, paymentMethod: 'stripe' });
    // An unlabeled open bill, and one part paid through the subcollection.
    await inv.doc('open_bill').set({ kinfolkId: 'fam1', status: 'Sent', amountDue: 40, total: 40 });
    await inv.doc('part_paid').set({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40 });
    await inv.doc('part_paid').collection('payments').doc('p1').set({ amountCents: 1000, amount: 10 });
    // Already stamped.
    await inv.doc('stamped').set({ kinfolkId: 'fam1', status: 'open', editScope: 'all', amountDue: 40, total: 40 });
  }, 30_000);

  it('refuses the unbacked legacy doc, stamps the root-payment-backed one paid, and a second run changes nothing', async () => {
    const first = await run('apply', 300);
    expect(first.scanned).toBe(5);
    expect(first.stamped).toBe(3);
    expect(first.skipped).toEqual({ stamp_current: 1, would_assert_payment: 1, would_notify_household: 0 });
    expect(first.needsOperator).toEqual(['legacy_total_only']);

    const read = async (id: string) => (await db.collection('invoices').doc(id).get()).data() ?? {};
    expect(await read('legacy_total_only')).toEqual({ kinfolkId: 'fam1', status: 'sent', total: 40 });
    expect(await read('legacy_root_paid')).toMatchObject({ status: 'paid', editScope: 'none', total: 40 });
    expect(await read('open_bill')).toMatchObject({ status: 'open', editScope: 'all' });
    expect(await read('part_paid')).toMatchObject({ status: 'paid', editScope: 'all' });

    const second = await run('apply', 300);
    expect(second.stamped).toBe(0);
    expect(second.skipped).toEqual({ stamp_current: 4, would_assert_payment: 1, would_notify_household: 0 });
  });
});
