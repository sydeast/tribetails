import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { run } from '../backfillInvoiceStateStamp';

/**
 * The state stamp backfill's real write path against the emulator (#884), as
 * #902 leaves it.
 *
 * The legacy shape (a `total`, no `amountDue`) used to classify `paid` only
 * because the missing balance read as 0, and was refused as
 * `would_assert_payment`. #902's shared rule derives the balance, so an unpaid
 * one now stamps `open`/`all` — the bill it is — and nothing is left for the
 * operator. The root-payment-backed one stamps `open` too: a root ledger row is
 * evidence that money came in, never a measurement of how much, and only the
 * invoice's own subcollection settles a balance.
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

  it('#902: stamps both legacy docs OPEN, refuses nothing, and a second run changes nothing', async () => {
    const first = await run('apply', 300);
    expect(first.scanned).toBe(5);
    expect(first.stamped).toBe(4);
    expect(first.skipped).toEqual({ stamp_current: 1, would_assert_payment: 0, would_notify_household: 0 });
    expect(first.needsOperator).toEqual([]);

    const read = async (id: string) => (await db.collection('invoices').doc(id).get()).data() ?? {};
    // Stamped open, and the money fields are untouched: the stamp writes two
    // fields. Writing the balance itself is backfillInvoiceAmountDue's job.
    expect(await read('legacy_total_only')).toEqual({
      kinfolkId: 'fam1',
      status: 'open',
      editScope: 'all',
      total: 40,
    });
    expect(await read('legacy_root_paid')).toMatchObject({ status: 'open', editScope: 'all', total: 40 });
    expect(await read('open_bill')).toMatchObject({ status: 'open', editScope: 'all' });
    expect(await read('part_paid')).toMatchObject({ status: 'paid', editScope: 'all' });

    const second = await run('apply', 300);
    expect(second.stamped).toBe(0);
    expect(second.skipped).toEqual({ stamp_current: 5, would_assert_payment: 0, would_notify_household: 0 });
  });
});
