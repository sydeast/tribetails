import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly: the script's
// FieldValue.delete() comes from lib/firebaseAdmin's copy, and a client from any
// other copy refuses to serialize it (#870).
import { getApps, initializeApp, deleteApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import {
  buildPlan,
  applyPlan,
  INBOX_COLLECTION,
  QUEUE_COLLECTION,
} from '../sweepKinfolkNotificationStaffNotes';

/**
 * The three things a fixture cannot establish about the #442 sweep, all of them
 * server behaviours rather than properties of a plan object:
 *
 *  1. `update({ 'detail.notes': FieldValue.delete() })` really reaches INSIDE
 *     the map and takes one field, rather than replacing the map or the
 *     document. If that were wrong, the sweep would erase the card content
 *     (`kinfolkName`, `bookingDate`) that operator ruling R5 exists to put
 *     there, and every read/target field with it.
 *  2. The kinfolk test is a real `clients/{uid}` read, so an office copy of the
 *     same key keeps its notes.
 *  3. The sweep is idempotent against the state it leaves behind: a second
 *     dry run over a swept collection plans nothing.
 *
 * Runs only with an emulator (the harness sets FIRESTORE_EMULATOR_HOST):
 *
 *   npm run test:scripts:emulator
 *
 * It refuses to run without one rather than risk touching anything real, the
 * same gate its sibling emulator tests in this directory use.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
/**
 * The default 10s in `vitest.config.ts` is a unit-test budget and it is not one
 * these tests can meet: the first Firestore call in a fresh process pays for
 * the admin SDK's gRPC channel coming up against a just-started emulator. Same
 * reason `vitest.rules.config.ts` sets 30s for the rules suite.
 */
const EMULATOR_TIMEOUT_MS = 30_000;

describe.runIf(EMULATOR)('the #442 sweep removes one field and nothing else', () => {
  let db: Firestore;

  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'sweep-442-test' });
    db = getFirestore();
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('strips household copies in both collections and leaves the office copy alone', async () => {
    await db.collection('clients').doc('client_1').set({ email: 'jane@example.com' });
    // No `clients/staff_1`: that is exactly what makes the copy below staff-side.

    await db.collection(INBOX_COLLECTION).doc('n_household').set({
      key: 'kincare.changed',
      recipientUid: 'client_1',
      title: 'Your KinCare visit was updated',
      description: 'Fri, Aug 8',
      readAt: null,
      targetType: 'booking',
      targetId: 'batch_1',
      detail: {
        kinfolkName: 'The Halbrooks',
        kinName: 'Bandit',
        serviceType: 'Dog Walk',
        notes: 'client disputes last invoice, do not discuss pricing',
      },
    });
    await db.collection(INBOX_COLLECTION).doc('n_office').set({
      key: 'kincare.changed',
      recipientUid: 'staff_1',
      title: 'KinCare updated',
      detail: { kinfolkName: 'The Halbrooks', notes: 'client disputes last invoice' },
    });
    await db.collection(INBOX_COLLECTION).doc('n_clean').set({
      key: 'invoice.new',
      recipientUid: 'client_1',
      detail: { invoiceNumber: 'INV-4' },
    });
    // A queued reminder whose only detail field is the staff note.
    await db.collection(QUEUE_COLLECTION).doc('q_reminder').set({
      key: 'kincare.upcoming.reminder',
      recipientUid: 'client_1',
      status: 'pending',
      mode: 'scheduled',
      fireAtMs: 1_800_000_000_000,
      detail: { notes: 'side gate sticks, do not tell them we lost the key' },
    });

    // Queue first, then inbox: the order the script itself applies them in,
    // because promoteQueued copies `detail` verbatim onto a new inbox document.
    const queuePlan = await buildPlan(db, QUEUE_COLLECTION, 5);
    expect(queuePlan.summary).toMatchObject({ scanned: 1, carrying: 1, strip: 1, detailEmptied: 1 });
    expect(await applyPlan(db, queuePlan.writes)).toEqual({ updated: 1, vanished: 0 });

    const inboxPlan = await buildPlan(db, INBOX_COLLECTION, 5);
    expect(inboxPlan.summary).toMatchObject({ scanned: 3, carrying: 2, strip: 1, leftStaff: 1 });
    expect(await applyPlan(db, inboxPlan.writes)).toEqual({ updated: 1, vanished: 0 });

    // The household copy lost the note and kept everything else it renders.
    const household = (await db.collection(INBOX_COLLECTION).doc('n_household').get()).data() ?? {};
    expect(household['detail']).toEqual({
      kinfolkName: 'The Halbrooks',
      kinName: 'Bandit',
      serviceType: 'Dog Walk',
    });
    expect(household).toMatchObject({
      title: 'Your KinCare visit was updated',
      description: 'Fri, Aug 8',
      readAt: null,
      targetType: 'booking',
      targetId: 'batch_1',
      recipientUid: 'client_1',
    });

    // The office copy is untouched: ruling R5 gives staff this field.
    const office = (await db.collection(INBOX_COLLECTION).doc('n_office').get()).data() ?? {};
    expect(office['detail']).toEqual({
      kinfolkName: 'The Halbrooks',
      notes: 'client disputes last invoice',
    });

    // The queued row still exists — a field was removed, not a document — and
    // its now-empty detail map went with the field, so a promotion cannot carry
    // an empty `detail` onto a fresh inbox document.
    const queued = await db.collection(QUEUE_COLLECTION).doc('q_reminder').get();
    expect(queued.exists).toBe(true);
    const queuedData = queued.data() ?? {};
    expect(queuedData['detail']).toBeUndefined();
    expect(queuedData).toMatchObject({
      key: 'kincare.upcoming.reminder',
      status: 'pending',
      mode: 'scheduled',
      fireAtMs: 1_800_000_000_000,
    });
  }, EMULATOR_TIMEOUT_MS);

  it('plans nothing on a second run, which is the operator’s done check', async () => {
    for (const collection of [QUEUE_COLLECTION, INBOX_COLLECTION]) {
      const plan = await buildPlan(db, collection, 5);
      expect(plan.summary.strip).toBe(0);
      expect(plan.writes).toEqual([]);
    }
  }, EMULATOR_TIMEOUT_MS);

  it('reports a row that vanished mid-run instead of failing the sweep', async () => {
    // The scheduled cron drains this queue every 5 minutes and deletes a row on
    // promotion, so an update aimed at one can land on a document that is gone.
    // It is counted and skipped — never re-created, because a merge-set would
    // resurrect a queue row holding nothing but a detail map.
    const result = await applyPlan(db, [
      { path: `${QUEUE_COLLECTION}/q_already_promoted`, key: 'kincare.upcoming.reminder', removeDetail: false },
    ]);
    expect(result).toEqual({ updated: 0, vanished: 1 });
    expect((await db.collection(QUEUE_COLLECTION).doc('q_already_promoted').get()).exists).toBe(false);
  }, EMULATOR_TIMEOUT_MS);
});
