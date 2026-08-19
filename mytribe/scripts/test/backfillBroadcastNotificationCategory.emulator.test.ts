import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  buildPlan,
  applyPlan,
  BROADCAST_KEY,
  CATALOG_CATEGORY,
  DEAD_CATEGORY,
  NOTIFICATIONS_COLLECTION,
} from '../backfillBroadcastNotificationCategory';

/**
 * The two things a fixture cannot establish about the #443 backfill, both of
 * them server behaviours rather than properties of a plan object:
 *
 *  1. `update({ category })` really moves ONE field and leaves the operator's
 *     own broadcast copy — subject, body, recipient, read state, the
 *     `broadcast: true` marker — exactly where it was. A `set()` here would
 *     erase the message itself.
 *  2. The scan reaches every document and the run is idempotent: a second dry
 *     run over the backfilled collection plans nothing.
 *
 * Runs only with an emulator (the harness sets FIRESTORE_EMULATOR_HOST):
 *
 *   npx firebase emulators:exec --only firestore --project broadcast-443-test \
 *     "npx vitest run ../scripts/test/backfillBroadcastNotificationCategory.emulator.test.ts"
 *
 * It refuses to run without one rather than risk touching anything real, the
 * same gate its sibling emulator tests in this directory use.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
/**
 * The default 10s in `vitest.config.ts` is a unit-test budget these cannot
 * meet: the first Firestore call in a fresh process pays for the admin SDK's
 * gRPC channel coming up against a just-started emulator. Same reason
 * `vitest.rules.config.ts` sets 30s for the rules suite.
 */
const EMULATOR_TIMEOUT_MS = 30_000;

describe.runIf(EMULATOR)('the #443 backfill moves one field and keeps the message', () => {
  let db: Firestore;

  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'broadcast-443-test' });
    db = getFirestore();
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('joins the legacy broadcasts to the catalog and leaves everything else alone', async () => {
    await db.collection(NOTIFICATIONS_COLLECTION).doc('b_legacy').set({
      key: BROADCAST_KEY,
      category: DEAD_CATEGORY,
      recipientUid: 'client_1',
      title: 'Closed Monday for the storm',
      description: 'We are closed Monday. Visits resume Tuesday.',
      body: 'We are closed Monday. Visits resume Tuesday.',
      broadcast: true,
      targetType: 'kinfolk',
      targetId: 'kf_1',
      readAt: null,
    });
    await db.collection(NOTIFICATIONS_COLLECTION).doc('b_nocategory').set({
      key: BROADCAST_KEY,
      recipientUid: 'client_2',
      body: 'Holiday hours',
      broadcast: true,
    });
    await db.collection(NOTIFICATIONS_COLLECTION).doc('b_current').set({
      key: BROADCAST_KEY,
      category: CATALOG_CATEGORY,
      recipientUid: 'client_3',
      body: 'Written after #424',
    });
    await db.collection(NOTIFICATIONS_COLLECTION).doc('b_chosen').set({
      key: BROADCAST_KEY,
      category: 'marketing',
      recipientUid: 'client_4',
      body: 'Somebody filed this one deliberately',
    });
    await db.collection(NOTIFICATIONS_COLLECTION).doc('n_other').set({
      key: 'kincare.changed',
      category: 'visit',
      recipientUid: 'client_1',
    });

    const plan = await buildPlan(db, 5);
    expect(plan.summary).toMatchObject({
      scanned: 5,
      broadcasts: 4,
      dead: 1,
      missing: 1,
      catalog: 1,
      foreign: 1,
      toUpdate: 2,
    });
    expect(await applyPlan(db, plan.writes)).toEqual({ updated: 2, vanished: 0 });

    // The message itself is untouched; only its filing changed.
    const legacy = (await db.collection(NOTIFICATIONS_COLLECTION).doc('b_legacy').get()).data() ?? {};
    expect(legacy).toEqual({
      key: BROADCAST_KEY,
      category: CATALOG_CATEGORY,
      recipientUid: 'client_1',
      title: 'Closed Monday for the storm',
      description: 'We are closed Monday. Visits resume Tuesday.',
      body: 'We are closed Monday. Visits resume Tuesday.',
      broadcast: true,
      targetType: 'kinfolk',
      targetId: 'kf_1',
      readAt: null,
    });

    const backfilled = (await db.collection(NOTIFICATIONS_COLLECTION).doc('b_nocategory').get()).data() ?? {};
    expect(backfilled['category']).toBe(CATALOG_CATEGORY);
    expect(backfilled['body']).toBe('Holiday hours');

    // A value somebody chose, and a document that is not a broadcast: both as
    // they were.
    const chosen = (await db.collection(NOTIFICATIONS_COLLECTION).doc('b_chosen').get()).data() ?? {};
    expect(chosen['category']).toBe('marketing');
    const other = (await db.collection(NOTIFICATIONS_COLLECTION).doc('n_other').get()).data() ?? {};
    expect(other['category']).toBe('visit');
  }, EMULATOR_TIMEOUT_MS);

  it('plans nothing on a second run, which is the operator’s done check', async () => {
    const plan = await buildPlan(db, 5);
    expect(plan.summary.toUpdate).toBe(0);
    expect(plan.writes).toEqual([]);
  }, EMULATOR_TIMEOUT_MS);

  it('reports a document that vanished between the plan and the write', async () => {
    const result = await applyPlan(db, [{ path: `${NOTIFICATIONS_COLLECTION}/b_gone`, from: DEAD_CATEGORY }]);
    expect(result).toEqual({ updated: 0, vanished: 1 });
    expect((await db.collection(NOTIFICATIONS_COLLECTION).doc('b_gone').get()).exists).toBe(false);
  }, EMULATOR_TIMEOUT_MS);
});
