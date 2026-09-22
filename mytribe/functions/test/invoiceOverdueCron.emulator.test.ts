import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * #871: THE OVERDUE CRON AGAINST A REAL FIRESTORE (the emulator), with the real
 * dispatcher and its dedupe ledger. Only the household lookup, the logger and
 * Sentry are stubbed.
 *
 * What it proves that the mocks cannot:
 *   - the scan reads the top-level `invoices` collection with a real
 *     documentId-ordered pagination, and a doc under the retired
 *     `families/{id}/invoices` path is never chased;
 *   - only a live bill gets a notice: cancelled, quote, draft, credit, paid,
 *     zero and archived do not. #902 added the migrated total-only shape to the
 *     bills that DO: it owes its total, so it is chased like any other;
 *   - the business day comes from the stored settings zone;
 *   - a rerun sends nothing, and a rerun after a lost stamp meets the ledger.
 *
 *   cd mytribe/functions && npm run test:scripts:emulator
 */
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-871') }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const NOW = Date.UTC(2026, 8, 14, 14, 30, 0); // 09:30 in Chicago on 2026-09-14
const PAST = '2026-09-01';
const OPEN = { kinfolkId: 'fam871', status: 'open', amountDue: 40, total: 40, dueDate: PAST };

describe.runIf(EMULATOR)('#871 invoiceOverdueCron over the Firestore emulator', () => {
  // Imported lazily so the default (no emulator) run never initialises admin.
  let db: typeof import('../src/lib/firestoreAdmin').db;
  let runInvoiceOverdueScan: typeof import('../src/scheduled/invoiceRemindersCron').runInvoiceOverdueScan;

  async function overdueNotices(): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const c of ['scheduledNotifications', 'notifications']) {
      const snap = await db().collection(c).where('key', '==', 'invoice.overdue').get();
      for (const d of snap.docs) out.push(d.data());
    }
    return out;
  }

  beforeAll(async () => {
    ({ db } = await import('../src/lib/firestoreAdmin'));
    ({ runInvoiceOverdueScan } = await import('../src/scheduled/invoiceRemindersCron'));
    const inv = db().collection('invoices');
    await db().doc('business_settings/business_settings').set({ timeZone: 'America/Chicago' });
    await inv.doc('e871_open').set(OPEN);
    await inv.doc('e871_due_today').set({ ...OPEN, dueDate: '2026-09-14' });
    await inv.doc('e871_cancelled').set({ ...OPEN, status: 'cancelled' });
    await inv.doc('e871_quote').set({ ...OPEN, status: 'quote', invoiceStatus: 'quote' });
    await inv.doc('e871_draft').set({ ...OPEN, status: 'draft' });
    await inv.doc('e871_credit').set({ ...OPEN, status: 'credit' });
    await inv.doc('e871_paid').set({ ...OPEN, status: 'paid', amountDue: 0 });
    await inv.doc('e871_zero').set({ ...OPEN, amountDue: 0, total: 0 });
    await inv.doc('e871_archived').set({ ...OPEN, archivedAt: NOW - 1000 });
    await inv.doc('e871_legacy').set({ kinfolkId: 'fam871', status: 'sent', total: 40, dueDate: PAST });
    // The retired nested path: a collectionGroup scan would have found this one.
    await db().doc('families/fam871/invoices/e871_nested').set(OPEN);
  }, 30_000);

  it('sends one notice per live bill, and never for the nested copy', async () => {
    // TWO since #902: `e871_legacy` is a migrated bill with a `total` and no
    // `amountDue`, which the classifier used to read as paid. It owes its total
    // and is overdue, so the office chases it — the behaviour change #902 makes
    // on purpose, and the reason #871's `legacy_balance_unproven` is retired.
    expect(await runInvoiceOverdueScan(NOW)).toBe(2);

    const notices = await overdueNotices();
    expect(notices.map((n) => n['targetId']).sort()).toEqual(['e871_legacy', 'e871_open']);
    const openNotice = notices.find((n) => n['targetId'] === 'e871_open')!;
    expect(openNotice).toMatchObject({ key: 'invoice.overdue', targetType: 'invoice' });
    expect((openNotice['data'] as Record<string, unknown>)['daysPastDue']).toBe(13);

    const stamped = (await db().collection('invoices').where('overdueNotifiedAtMs', '>', 0).get()).docs.map((d) => d.id);
    expect(stamped.sort()).toEqual(['e871_legacy', 'e871_open']);
    const nested = (await db().doc('families/fam871/invoices/e871_nested').get()).data() ?? {};
    expect(nested['overdueNotifiedAtMs']).toBeUndefined();
  });

  it('a rerun sends nothing, and a rerun after a lost stamp records the first send from the ledger', async () => {
    expect(await runInvoiceOverdueScan(NOW + 60_000)).toBe(0);
    expect(await overdueNotices()).toHaveLength(2);

    await db().collection('invoices').doc('e871_open').update({ overdueNotifiedAtMs: null });
    // The next day. The bill that was due on 2026-09-14 is now overdue and gets
    // its one notice; the open bill whose stamp was lost gets nothing more.
    expect(await runInvoiceOverdueScan(NOW + 24 * 60 * 60 * 1000)).toBe(1);
    const notices = await overdueNotices();
    expect(notices.map((n) => n['targetId']).sort()).toEqual(['e871_due_today', 'e871_legacy', 'e871_open']);
    // The restored stamp is the ledger's record of the FIRST delivery (the
    // dispatcher stamps its own wall clock), never this rerun's time.
    const ledger = await db()
      .collection('notificationDedupe')
      .where('identity', '==', 'key:invoice:e871_open:overdue')
      .get();
    expect(ledger.size).toBe(1);
    const firstSentAt = ledger.docs[0]!.data()['lastAtMs'];
    const restored = (await db().collection('invoices').doc('e871_open').get()).data()?.['overdueNotifiedAtMs'];
    expect(typeof firstSentAt).toBe('number');
    expect(restored).toBe(firstSentAt);
    expect(restored).not.toBe(NOW + 24 * 60 * 60 * 1000);

    // And a third day: still one each.
    expect(await runInvoiceOverdueScan(NOW + 2 * 24 * 60 * 60 * 1000)).toBe(0);
    expect(await overdueNotices()).toHaveLength(3);
  });
});
