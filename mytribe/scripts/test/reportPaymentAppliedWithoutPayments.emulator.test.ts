import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, Timestamp, type Firestore } from '../lib/firebaseAdmin';
import { buildReport } from '../reportPaymentAppliedWithoutPayments';

/**
 * The #884 report against a real Firestore (the emulator), seeded with every
 * shape it must and must not report. The seeded data is LEFT IN PLACE, so the
 * npm command can be run against the same emulator straight afterwards:
 *
 *   cd mytribe/functions
 *   npx firebase emulators:exec --only firestore --project paid-884-test \
 *     "npx vitest run --config vitest.scripts-emulator.config.ts ../scripts/test/reportPaymentAppliedWithoutPayments.emulator.test.ts && \
 *      npm run report:payment-applied-without-payments -- --project paid-884-test"
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'paid-884-test';
const T = Date.UTC(2026, 8, 1, 12, 0, 0);

async function allDocs(db: Firestore): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['invoices', 'payments', 'notifications']) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  }
  for (const inv of ['inv_admin', 'inv_zero']) {
    const snap = await db.collection('invoices').doc(inv).collection('payments').get();
    for (const d of snap.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  }
  return out.sort();
}

describe.runIf(EMULATOR)('the #884 report reads real stored notifications, invoices and payment rows', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: PROJECT });
    db = getFirestore();
    const at = (ms: number) => Timestamp.fromMillis(ms);
    const inv = db.collection('invoices');
    const n = db.collection('notifications');
    const applied = (invoiceId: string, extra: Record<string, unknown> = {}) => ({
      key: 'invoice.payment.applied',
      targetType: 'invoice',
      targetId: invoiceId,
      data: { kinfolkId: 'fam1', invoiceId, ...extra },
    });

    // 1. A $0 comped invoice announced on create (the trigger's copy, household and office).
    await inv.doc('inv_zero').set({ kinfolkId: 'fam1', status: 'zero', amountDue: 0, total: 0 });
    await n.doc('zero_household').set({ ...applied('inv_zero', { amountDue: 0 }), recipientUid: 'client_1', createdAt: at(T) });
    await n.doc('zero_office').set({ ...applied('inv_zero', { amountDue: 0 }), recipientUid: 'staff_1', createdAt: at(T + 1000) });
    // 2. An amount-less quote, announced on create.
    await inv.doc('inv_quote').set({ kinfolkId: 'fam1', status: 'quote' });
    await n.doc('quote_household').set({ ...applied('inv_quote'), recipientUid: 'client_1', createdAt: at(T) });
    // 3. A card payment: the root ledger row `payments/{eventId}` names the invoice. Not reported.
    await inv.doc('inv_card').set({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40 });
    await db.collection('payments').doc('evt_1').set({ kinfolkId: 'fam1', invoiceId: 'inv_card', amountCents: 4000, paymentMethod: 'stripe' });
    await n.doc('card_household').set({ ...applied('inv_card', { stripeEventId: 'evt_1' }), recipientUid: 'client_1', createdAt: at(T) });
    // 4. An admin payment: only the settlement subcollection row. Not reported.
    await inv.doc('inv_admin').set({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40, paidCents: 4000 });
    await inv.doc('inv_admin').collection('payments').doc('p1').set({ amountCents: 4000, method: 'cash' });
    await n.doc('admin_household').set({ ...applied('inv_admin', { paymentId: 'p1' }), recipientUid: 'client_1', createdAt: at(T) });
    // 5. A notice written before targets were stamped, about an invoice since deleted.
    await n.doc('gone_old').set({ key: 'invoice.payment.applied', recipientUid: 'client_2', data: { invoiceId: 'inv_gone' }, createdAt: at(T) });
    // 6. Another key about the unbacked $0 invoice. Not a payment notice, not counted.
    await n.doc('zero_updated').set({ key: 'invoice.updated', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv_zero', data: { invoiceId: 'inv_zero' }, createdAt: at(T) });
  }, 30_000);

  it('finds exactly the invoices with no payment row, and writes nothing', async () => {
    const before = await allDocs(db);
    const r = await buildReport(db);
    const after = await allDocs(db);

    expect(r.scannedNotices).toBe(6);
    expect(r.invoicesChecked).toBe(5);
    expect(r.unbacked.map((u) => [u.invoiceId, u.state, u.notices.length])).toEqual([
      ['inv_gone', 'missing', 1],
      ['inv_quote', 'quote', 1],
      ['inv_zero', 'zero', 2],
    ]);
    expect(r.unbacked.find((u) => u.invoiceId === 'inv_zero')!.notices.map((x) => x.path)).toEqual([
      'notifications/zero_household',
      'notifications/zero_office',
    ]);
    expect(r.recipients).toBe(3);
    expect(after).toEqual(before);
  });
});
