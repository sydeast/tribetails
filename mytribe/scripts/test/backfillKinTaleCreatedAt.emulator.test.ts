import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { buildPlan, applyPlan, REPORTS_COLLECTION } from '../backfillKinTaleCreatedAt';

/**
 * THE WRITE, PROVEN RATHER THAN REASONED ABOUT.
 *
 * `planRedate` is pinned against fixtures next door. What a fixture cannot
 * establish is that the batch actually lands the way the plan describes: that
 * the merge does not flatten the rest of the document, that an ISO row really
 * is left byte-identical, that a row with no `_migratedAt` really is passed
 * over instead of being redated to something plausible, and that a second run
 * over the migration's own output is a genuine no-op.
 *
 * So this seeds real documents carrying the production shapes, runs the real
 * migration against a real Firestore, and reads them back.
 *
 * Runs only with FIRESTORE_EMULATOR_HOST set, and refuses otherwise rather than
 * risk touching anything real.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

/** Copied field for field from production row `legacy_57`. */
const LEGACY = {
  sessionId: 'j1',
  kinfolkId: '',
  createdAt: 'September 3, 2025 2:02pm',
  visitDate: 'September 3, 2025 2:02pm',
  sentAt: 'September 3, 2025 2:02pm',
  arrivedAt: '12:03pm',
  departedAt: '2:11pm',
  bodyCopy: 'Fed the cats and topped up the water.',
  status: 'SENT',
  sentVia: 'legacy_visit_logs',
  updatedAt: '2026-05-17T00:49:26Z',
  _migratedFrom: 'visit_logs/57',
  _migratedAt: '2026-05-16T20:36:39Z',
  // Pipeline state no model here declares. If the write were a set() rather
  // than a merge, this would vanish and the KinTale would leave the nightly
  // reconcile pass permanently, with nothing reporting a failure.
  reconcileStatus: 'pending',
};

/** Copied from production row `demo-family-001-report-1`. */
const MODERN = {
  createdAt: '2025-12-02T19:00:00.000Z',
  visitDate: '2025-12-02',
  sentAt: '2025-12-02T20:00:00.000Z',
  arrivedAt: '2025-12-02T19:00:00.000Z',
  departedAt: '2025-12-02T20:00:00.000Z',
  sentVia: 'demo_seed',
};

describe.runIf(EMULATOR)('the F7 redate really lands on a real Firestore', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: 'f7-redate-test' });
    db = getFirestore();
    const c = db.collection(REPORTS_COLLECTION);
    await Promise.all([
      c.doc('legacy_57').set(LEGACY),
      c.doc('demo-report-1').set(MODERN),
      // Legacy text, but the ingest stamp is gone. Not hypothetical:
      // KinCareRepository.updateKinCareReport documents that a bare set() on
      // this collection deletes exactly _migratedFrom/_migratedAt, which is why
      // it now writes with merge().
      c.doc('legacy_noprov').set({
        createdAt: 'March 31, 2026 10:16am',
        visitDate: 'March 31, 2026 10:16am',
        sentVia: 'legacy_visit_logs',
      }),
      // Legacy text the grammar does not cover. Redatable (that only needs
      // _migratedAt), but no submit stamp can be derived from it.
      c.doc('legacy_odd').set({
        createdAt: 'sometime last Tuesday',
        _migratedAt: '2026-05-16T20:36:39Z',
        sentVia: 'legacy_visit_logs',
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('redates the legacy row to its ingest stamp and leaves the rest of it alone', async () => {
    const { summary, writes } = await buildPlan(db);
    expect(summary.scanned).toBe(4);
    expect(summary.legacy).toBe(3);
    expect(summary.alreadyIso).toBe(1);
    expect(summary.toRedate).toBe(2);
    await applyPlan(db, writes);

    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_57').get()).data() ?? {};

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(doc['createdAt']).toBe('2026-05-16T20:36:39.000Z');

    // And it now sorts BELOW a real ISO row instead of above it.
    expect(String(doc['createdAt']) > MODERN.createdAt).toBe(true);
    expect(LEGACY.createdAt > MODERN.createdAt).toBe(true); // what it used to do

    // The human original is still on the row, untouched, twice over.
    expect(doc['visitDate']).toBe('September 3, 2025 2:02pm');
    expect(doc['sentAt']).toBe('September 3, 2025 2:02pm');
    expect(doc['arrivedAt']).toBe('12:03pm');
    expect(doc['departedAt']).toBe('2:11pm');

    // And sortable, under a name that claims only what it can support.
    expect(doc['_legacySubmittedAt']).toBe('2025-09-03T14:02:00.000Z');

    // Merge, not replace: everything else survives, including the pipeline
    // state no model here declares.
    expect(doc['bodyCopy']).toBe(LEGACY.bodyCopy);
    expect(doc['reconcileStatus']).toBe('pending');
    expect(doc['_migratedAt']).toBe('2026-05-16T20:36:39Z');
    expect(doc['sessionId']).toBe('j1');
  });

  it('leaves an already-ISO row byte-identical', async () => {
    const doc = (await db.collection(REPORTS_COLLECTION).doc('demo-report-1').get()).data();
    expect(doc).toEqual(MODERN);
    expect(doc).not.toHaveProperty('_legacySubmittedAt');
  });

  it('SKIPS the row with no _migratedAt rather than guessing a date for it', async () => {
    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_noprov').get()).data() ?? {};
    // Untouched. Still wrong, and still visibly wrong, which is the point.
    expect(doc['createdAt']).toBe('March 31, 2026 10:16am');
    expect(doc).not.toHaveProperty('_legacySubmittedAt');
  });

  it('reports the skip by id instead of swallowing it', async () => {
    const { summary } = await buildPlan(db);
    expect(summary.refusals).toContainEqual({
      reportId: 'legacy_noprov',
      reason: 'no-ingest-stamp',
      createdAt: 'March 31, 2026 10:16am',
    });
  });

  it('redates an unparseable submit stamp but derives nothing from it', async () => {
    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_odd').get()).data() ?? {};
    expect(doc['createdAt']).toBe('2026-05-16T20:36:39.000Z');
    expect(doc).not.toHaveProperty('_legacySubmittedAt');
  });

  it('is idempotent: a second run plans nothing and changes nothing', async () => {
    const before = await db.collection(REPORTS_COLLECTION).get();
    const snapshot = before.docs.map((d) => [d.id, d.data()] as const);

    const { summary, writes } = await buildPlan(db);
    expect(writes).toEqual([]);
    expect(summary.toRedate).toBe(0);
    // The two redated rows now read as already-ISO, alongside the demo row.
    expect(summary.alreadyIso).toBe(3);
    await applyPlan(db, writes);

    const after = await db.collection(REPORTS_COLLECTION).get();
    expect(after.docs.map((d) => [d.id, d.data()] as const)).toEqual(snapshot);
  });

  it('the whole collection now orders by createdAt chronologically', async () => {
    const snap = await db
      .collection(REPORTS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .get();
    // legacy_noprov is absent from the ordered result set only if it lacked the
    // field; it has one, so all four come back, and the three real instants lead.
    const ordered = snap.docs.map((d) => d.id);
    expect(ordered.indexOf('legacy_57')).toBeLessThan(ordered.indexOf('demo-report-1'));
    // The refused row is the one that still sorts by nothing, and it is named
    // in the report so a person can see exactly that.
    expect(ordered[0]).toBe('legacy_noprov');
  });
});
