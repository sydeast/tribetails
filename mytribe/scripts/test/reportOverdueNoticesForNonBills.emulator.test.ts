import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, Timestamp, type Firestore } from '../lib/firebaseAdmin';
import { buildReport } from '../reportOverdueNoticesForNonBills';

/**
 * The #871 report against a real Firestore (the emulator), seeded with every
 * shape it must and must not flag. The seeded data is LEFT IN PLACE, so the npm
 * command can be run against the same emulator straight afterwards:
 *
 *   cd mytribe/functions
 *   npx firebase emulators:exec --only firestore --project overdue-871-report \
 *     "npx vitest run --config vitest.scripts-emulator.config.ts ../scripts/test/reportOverdueNoticesForNonBills.emulator.test.ts && \
 *      npm run report:overdue-notices-non-bills -- --project overdue-871-report"
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const PROJECT = 'overdue-871-report';
const T = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

async function allDocs(db: Firestore): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['invoices', 'notifications', 'scheduledNotifications']) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  }
  const rows = await db.collection('invoices').doc('inv_paid_rows').collection('payments').get();
  for (const d of rows.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  return out.sort();
}

describe.runIf(EMULATOR)('the #871 report reads real stored notices, invoices and payment rows', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: PROJECT });
    db = getFirestore();
    const at = (ms: number) => Timestamp.fromMillis(ms);
    const inv = db.collection('invoices');
    const n = db.collection('notifications');
    const notice = (key: string, invoiceId: string, ms: number) => ({
      key,
      recipientUid: 'client_1',
      targetType: 'invoice',
      targetId: invoiceId,
      data: { kinfolkId: 'fam1', invoiceId },
      createdAt: at(ms),
    });

    // 1. A cancelled invoice chased.
    await inv.doc('inv_cancelled').set({ kinfolkId: 'fam1', status: 'cancelled', amountDue: 40, total: 40, overdueNotifiedAtMs: T });
    await n.doc('n_cancelled').set(notice('invoice.overdue', 'inv_cancelled', T));
    // 2. An unanswered quote reminded, the reminder still queued.
    await inv.doc('inv_quote').set({ kinfolkId: 'fam1', status: 'quote', amountDue: 40, total: 40, reminderNotifiedAtMs: T });
    const { createdAt: _unused, ...queued } = notice('invoice.reminder', 'inv_quote', T);
    await db.collection('scheduledNotifications').doc('s_quote').set({ ...queued, fireAtMs: T });
    // 3. Paid an hour before the overdue notice, by payment rows.
    await inv.doc('inv_paid_rows').set({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40, overdueNotifiedAtMs: T });
    await inv.doc('inv_paid_rows').collection('payments').doc('p1').set({ amountCents: 4000, createdAt: at(T - HOUR) });
    await n.doc('n_paid_rows').set(notice('invoice.overdue', 'inv_paid_rows', T));
    // 4. A live bill, chased correctly, paid a day later. Not flagged.
    await inv.doc('inv_ok').set({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40, paidAt: at(T + 24 * HOUR), overdueNotifiedAtMs: T });
    await n.doc('n_ok').set(notice('invoice.overdue', 'inv_ok', T));
    // 5. A quote accepted after its reminder.
    await inv.doc('inv_late_accept').set({
      kinfolkId: 'fam1', status: 'open', invoiceStatus: 'open', quoteDecision: 'accepted', quoteDecidedAt: at(T + HOUR), amountDue: 40, total: 40,
    });
    await n.doc('n_late_accept').set(notice('invoice.reminder', 'inv_late_accept', T));
    // 6. Another key about the cancelled invoice. Not a chase, not counted.
    await n.doc('n_updated').set(notice('invoice.updated', 'inv_cancelled', T));
    // 7. A draft stamped by an old run with no surviving notice.
    await inv.doc('inv_draft_stamped').set({ kinfolkId: 'fam1', status: 'draft', amountDue: 40, total: 40, reminderNotifiedAtMs: T });
  }, 30_000);

  it('flags exactly the non-bills, counts the stamped non-open invoices, and writes nothing', async () => {
    const before = await allDocs(db);
    const r = await buildReport(db);
    const after = await allDocs(db);

    expect(r.scannedNotices).toBe(5);
    expect(r.invoicesChecked).toBe(5);
    expect(r.flagged.map((f) => [f.invoiceId, f.key, f.state, f.flags])).toEqual([
      ['inv_cancelled', 'invoice.overdue', 'cancelled', ['cancelled']],
      ['inv_late_accept', 'invoice.reminder', 'open', ['unaccepted_quote']],
      ['inv_paid_rows', 'invoice.overdue', 'paid', ['paid_at_send']],
      ['inv_quote', 'invoice.reminder', 'quote', ['unaccepted_quote']],
    ]);
    expect(r.counts).toEqual({
      'invoice.overdue cancelled': 1,
      'invoice.overdue paid_at_send': 1,
      'invoice.reminder unaccepted_quote': 2,
    });
    expect(r.stampedNotOpen.map((s) => [s.invoiceId, s.state, s.stamps])).toEqual([
      ['inv_cancelled', 'cancelled', ['overdueNotifiedAtMs']],
      ['inv_draft_stamped', 'draft', ['reminderNotifiedAtMs']],
      ['inv_ok', 'paid', ['overdueNotifiedAtMs']],
      ['inv_paid_rows', 'paid', ['overdueNotifiedAtMs']],
      ['inv_quote', 'quote', ['reminderNotifiedAtMs']],
    ]);
    expect(after).toEqual(before);
  });
});
