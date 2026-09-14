import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly: the client and
// the seeded Timestamps must come from the same copy the script reads with, and
// emulatorTestImports.test.ts fails on a direct import (#870).
import { getApps, initializeApp, getFirestore, Timestamp, type Firestore } from '../lib/firebaseAdmin';
import { buildReport } from '../reportDuplicateNotifications';

/**
 * The #832 duplicate report, and its #866 payment-confirmation pass, against a
 * real Firestore (the emulator), seeded with duplicates of each shape the report
 * must and must not find.
 *
 * The seeded data is deliberately LEFT IN PLACE after the run, so the npm
 * command can be run against the same emulator straight afterwards and its
 * printed report read by eye:
 *
 *   cd mytribe/functions
 *   npx firebase emulators:exec --only firestore --project dedupe-832-test \
 *     "npx vitest run ../scripts/test/reportDuplicateNotifications.emulator.test.ts && \
 *      npm run report:duplicate-notifications -- --project dedupe-832-test"
 *
 * Refuses to run without an emulator, like its sibling emulator tests.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const EMULATOR_TIMEOUT_MS = 30_000;
const T = Date.UTC(2026, 7, 1, 12, 0, 0);
const MIN = 60_000;

async function allDocs(db: Firestore): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['clients', 'notifications', 'scheduledNotifications']) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  }
  return out.sort();
}

describe.runIf(EMULATOR)('the #832 duplicate report reads real stored notifications', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: 'dedupe-832-test' });
    db = getFirestore();
    const at = (ms: number) => Timestamp.fromMillis(ms);

    await db.collection('clients').doc('client_1').set({ email: 'household@example.com' });
    await db.collection('clients').doc('client_2').set({ email: 'second@example.com' });
    // No clients/staff_1: that is what makes the staff copy below a staff copy.

    const n = db.collection('notifications');
    // 1. A household sent invoice.updated twice, 40s apart: a duplicate.
    await n.doc('dup_a').set({ key: 'invoice.updated', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv1', data: { invoiceId: 'inv1' }, createdAt: at(T) });
    await n.doc('dup_b').set({ key: 'invoice.updated', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv1', data: { invoiceId: 'inv1' }, createdAt: at(T + 40_000) });
    // 2. The same key and invoice an hour later: a legitimate second edit.
    await n.doc('later').set({ key: 'invoice.updated', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv2', data: { invoiceId: 'inv2' }, createdAt: at(T) });
    await n.doc('later_b').set({ key: 'invoice.updated', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv2', data: { invoiceId: 'inv2' }, createdAt: at(T + 60 * MIN) });
    // 3. Two DIFFERENT messages to the office from one household, 10s apart: not a duplicate.
    await n.doc('msg_1').set({ key: 'message.received', recipientUid: 'staff_1', targetType: 'kinfolk', targetId: 'fam1', data: { kinfolkId: 'fam1', messageId: 'm1' }, createdAt: at(T) });
    await n.doc('msg_2').set({ key: 'message.received', recipientUid: 'staff_1', targetType: 'kinfolk', targetId: 'fam1', data: { kinfolkId: 'fam1', messageId: 'm2' }, createdAt: at(T + 10_000) });
    // 4. A staff copy duplicated, pre-target document (target derived from data).
    await n.doc('staff_a').set({ key: 'invoice.payment.applied', recipientUid: 'staff_1', data: { invoiceId: 'inv3' }, createdAt: at(T) });
    await n.doc('staff_b').set({ key: 'invoice.payment.applied', recipientUid: 'staff_1', data: { invoiceId: 'inv3' }, createdAt: at(T + 5_000) });

    // #866 5. One card payment, two confirmations to a household: the webhook's
    // (stripeEventId) and the invoice trigger's (no per-event id), 30s apart.
    // Different identities, so the #832 pass cannot pair them.
    await n.doc('pay_hook').set({ key: 'invoice.payment.applied', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv5', data: { kinfolkId: 'fam1', invoiceId: 'inv5', stripeEventId: 'evt_5' }, createdAt: at(T) });
    await n.doc('pay_trig').set({ key: 'invoice.payment.applied', recipientUid: 'client_1', targetType: 'invoice', targetId: 'inv5', data: { kinfolkId: 'fam1', invoiceId: 'inv5', amountDue: 0 }, createdAt: at(T + 30_000) });
    // #866 6. An admin payment confirmed, and a card payment on the same invoice
    // 20 minutes later: two real payments, outside the 10-minute window.
    await n.doc('pay_admin').set({ key: 'invoice.payment.applied', recipientUid: 'client_2', targetType: 'invoice', targetId: 'inv6', data: { kinfolkId: 'fam2', invoiceId: 'inv6', paymentId: 'p6' }, createdAt: at(T) });
    await n.doc('pay_card').set({ key: 'invoice.payment.applied', recipientUid: 'client_2', targetType: 'invoice', targetId: 'inv6', data: { kinfolkId: 'fam2', invoiceId: 'inv6', stripeEventId: 'evt_6' }, createdAt: at(T + 20 * MIN) });

    const s = db.collection('scheduledNotifications');
    // 7. Two reminders about one invoice to a household, 6 hours apart: a duplicate.
    await s.doc('rem_a').set({ key: 'invoice.reminder', recipientUid: 'client_1', data: { kinfolkId: 'fam1', invoiceId: 'inv4' }, fireAtMs: T, createdAt: at(T) });
    await s.doc('rem_b').set({ key: 'invoice.reminder', recipientUid: 'client_1', data: { kinfolkId: 'fam1', invoiceId: 'inv4' }, fireAtMs: T + 6 * 60 * MIN, createdAt: at(T + 6 * 60 * MIN) });
  }, EMULATOR_TIMEOUT_MS);

  it('finds exactly the seeded duplicates, splits households from staff, and writes nothing', async () => {
    const before = await allDocs(db);
    const report = await buildReport(db, null);
    const after = await allDocs(db);

    expect(after).toEqual(before);
    expect(report.scanned).toEqual({ notifications: 12, scheduledNotifications: 2 });

    const found = report.groups.map((g) => `${g.household ? 'H' : 'S'} ${g.key} ${g.rows.map((r) => r.path.split('/')[1]).join(',')}`).sort();
    expect(found).toEqual([
      'H invoice.reminder rem_a,rem_b',
      'H invoice.updated dup_a,dup_b',
      'S invoice.payment.applied staff_a,staff_b',
    ]);
    expect(report.householdsAffected).toBe(1);
    expect(report.householdGroups).toBe(2);
    expect(report.staffGroups).toBe(1);
  }, EMULATOR_TIMEOUT_MS);

  it('#866: finds the household confirmed twice for one invoice by two senders, and nothing else', async () => {
    const report = await buildReport(db, null);
    const found = report.paymentApplied.groups
      .map((g) => `${g.household ? 'H' : 'S'} ${g.invoiceId} ${g.rows.map((r) => r.path.split('/')[1]).join(',')}`)
      .sort();
    expect(found).toEqual(['H inv5 pay_hook,pay_trig', 'S inv3 staff_a,staff_b']);
    expect(report.paymentApplied.householdsAffected).toBe(1);
    expect(report.paymentApplied.householdInvoices).toBe(1);
    expect(report.paymentApplied.extraHouseholdCopies).toBe(1);
    expect(report.paymentApplied.staffGroups).toBe(1);
    // The #832 pass alone would have missed it.
    expect(report.groups.some((g) => g.identity.startsWith('invoice:inv5'))).toBe(false);
  }, EMULATOR_TIMEOUT_MS);
});
