import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { run } from '../backfillInvoiceStateStamp';

/**
 * The state stamp backfill's real write path against the emulator, including
 * the notification guard as #884 left it: the guard asks the invoice trigger's
 * own `isPaidTransition` about each stamp write, and a stamp never moves
 * invoiceStateOf, so nothing is refused. The legacy shape the old
 * `amountDue <= 0` guard refused (a `total` with no `amountDue`) is stamped
 * `paid`, and the trigger reads that write as paid to paid.
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
    // An unlabeled open bill, and one part paid through the subcollection.
    await inv.doc('open_bill').set({ kinfolkId: 'fam1', status: 'Sent', amountDue: 40, total: 40 });
    await inv.doc('part_paid').set({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40 });
    await inv.doc('part_paid').collection('payments').doc('p1').set({ amountCents: 1000, amount: 10 });
    // Already stamped.
    await inv.doc('stamped').set({ kinfolkId: 'fam1', status: 'open', editScope: 'all', amountDue: 40, total: 40 });
  }, 30_000);

  it('stamps every doc, refuses none, and a second run changes nothing', async () => {
    const first = await run('apply', 300);
    expect(first.scanned).toBe(4);
    expect(first.stamped).toBe(3);
    expect(first.skipped).toEqual({ stamp_current: 1, would_notify_household: 0 });
    expect(first.needsOperator).toEqual([]);

    const read = async (id: string) => (await db.collection('invoices').doc(id).get()).data() ?? {};
    expect(await read('legacy_total_only')).toMatchObject({ status: 'paid', editScope: 'none', total: 40 });
    expect((await read('legacy_total_only'))['amountDue']).toBeUndefined();
    expect(await read('open_bill')).toMatchObject({ status: 'open', editScope: 'all' });
    expect(await read('part_paid')).toMatchObject({ status: 'paid', editScope: 'all' });

    const second = await run('apply', 300);
    expect(second.stamped).toBe(0);
    expect(second.skipped).toEqual({ stamp_current: 4, would_notify_household: 0 });
  });
});
