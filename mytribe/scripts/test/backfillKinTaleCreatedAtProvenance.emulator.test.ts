import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly: the script
// builds its writes from lib/firebaseAdmin's copy, so the client must come from
// the same one (#870).
import { getApps, initializeApp, deleteApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import {
  buildPlan,
  applyPlan,
  REPORTS_COLLECTION,
} from '../backfillKinTaleCreatedAtProvenance';

/**
 * THE WRITE, PROVEN RATHER THAN REASONED ABOUT.
 *
 * `planProvenance` is pinned against fixtures next door. What a fixture cannot
 * establish is that the batch actually lands the way the plan describes: that
 * the merge does not flatten the rest of the document, that a row this system
 * really created is left byte-identical, that a row with nothing recoverable is
 * MARKED rather than quietly left looking like a real date, and that a second
 * run over the migration's own output is a genuine no-op.
 *
 * So this seeds real documents carrying the production shapes, runs the real
 * migration against a real Firestore, and reads them back.
 *
 * Runs only with FIRESTORE_EMULATOR_HOST set (`npm run test:scripts:emulator`
 * starts one), and refuses otherwise rather than risk touching anything real.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

const INGEST = '2026-05-16T20:36:39Z';

/**
 * Copied field for field from production row `legacy_57`, in the state the May
 * 2026 migration left it: `createdAt` is still the raw free text.
 */
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
  _legacySubmittedAt: '2025-09-03T14:02:00Z',
  _migratedFrom: 'visit_logs/57',
  _migratedAt: INGEST,
  // Pipeline state no model here declares. If the write were a set() rather
  // than a merge, this would vanish and the KinTale would leave the nightly
  // reconcile pass permanently, with nothing reporting a failure.
  reconcileStatus: 'pending',
};

/**
 * The same shape as the DELETED F7 redate would have left it: createdAt already
 * overwritten with the ingest stamp. Production may be in this state; nothing in
 * the repository says whether that write was ever run.
 */
const REDATED = {
  ...LEGACY,
  createdAt: '2026-05-16T20:36:39.000Z',
  // A DIFFERENT submit stamp from legacy_57's, deliberately: the ordering
  // assertion at the bottom must read a real chronological sequence rather than
  // a tie broken by document id.
  visitDate: 'October 12, 2025 9:15am',
  sentAt: 'October 12, 2025 9:15am',
  _legacySubmittedAt: '2025-10-12T09:15:00Z',
  _migratedFrom: 'visit_logs/58',
  bodyCopy: 'Walked the dog twice.',
};

/** Copied from production row `demo-family-001-report-1`. Never imported. */
const MODERN = {
  createdAt: '2025-12-02T19:00:00.000Z',
  visitDate: '2025-12-02',
  sentAt: '2025-12-02T20:00:00.000Z',
  arrivedAt: '2025-12-02T19:00:00.000Z',
  departedAt: '2025-12-02T20:00:00.000Z',
  sentVia: 'demo_seed',
};

/**
 * Imported, but `visit_logs.submitted` was blank, so the migration fell back to
 * the bare arrival clock time and no field on the document carries a date. This
 * is the genuinely unrecoverable row.
 */
const UNRECOVERABLE = {
  createdAt: '2026-05-16T20:36:39.000Z',
  visitDate: '8:37pm',
  sentAt: '8:37pm',
  arrivedAt: '8:37pm',
  _legacySubmittedAt: '',
  _migratedFrom: 'visit_logs/91',
  _migratedAt: INGEST,
  sentVia: 'legacy_visit_logs',
};

/**
 * Imported, free text the grammar does not cover, AND the ingest stamp is gone.
 * Not hypothetical: `KinCareRepository.updateKinCareReport` documents that a
 * bare set() on this collection deletes exactly `_migratedFrom`/`_migratedAt`,
 * which is why it now writes with merge().
 */
const NO_INSTANT = {
  createdAt: 'sometime last Tuesday',
  visitDate: '',
  sentAt: '',
  sentVia: 'legacy_visit_logs',
};

describe.runIf(EMULATOR)('the createdAt provenance backfill really lands on a real Firestore', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: 'createdat-provenance-test' });
    db = getFirestore();
    const c = db.collection(REPORTS_COLLECTION);
    await Promise.all([
      c.doc('legacy_57').set(LEGACY),
      c.doc('legacy_58').set(REDATED),
      c.doc('demo-report-1').set(MODERN),
      c.doc('legacy_91').set(UNRECOVERABLE),
      c.doc('legacy_noinstant').set(NO_INSTANT),
    ]);
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('gives the imported row back its ORIGINAL creation instant, and leaves the rest alone', async () => {
    const { summary, writes } = await buildPlan(db);
    expect(summary.scanned).toBe(5);
    expect(summary.notMigrated).toBe(1);
    expect(summary.recovered).toBe(2);
    expect(summary.markedImport).toBe(1);
    expect(summary.refusals).toHaveLength(1);
    await applyPlan(db, writes);

    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_57').get()).data() ?? {};

    // THE ASSERTION THIS FILE EXISTS FOR. The tale was written in September
    // 2025, and the record now says so.
    expect(doc['createdAt']).toBe('2025-09-03T14:02:00.000Z');
    expect(doc['createdAtSource']).toBe('original');

    // The operator's symptom, closed: last year's tale now sorts BELOW a
    // December row instead of above it.
    expect(String(doc['createdAt']) < MODERN.createdAt).toBe(true);
    expect(LEGACY.createdAt > MODERN.createdAt).toBe(true); // what it used to do

    // The visit fields are untouched. They are free text that is honestly free
    // text, and 18 of the 83 live rows prove the submit stamp is not the visit
    // date.
    expect(doc['visitDate']).toBe('September 3, 2025 2:02pm');
    expect(doc['sentAt']).toBe('September 3, 2025 2:02pm');
    expect(doc['arrivedAt']).toBe('12:03pm');
    expect(doc['departedAt']).toBe('2:11pm');

    // Merge, not replace: everything else survives, including the pipeline
    // state no model here declares, and the ingest instant keeps its own field.
    expect(doc['bodyCopy']).toBe(LEGACY.bodyCopy);
    expect(doc['reconcileStatus']).toBe('pending');
    expect(doc['_migratedAt']).toBe(INGEST);
    expect(doc['_migratedFrom']).toBe('visit_logs/57');
    expect(doc['sessionId']).toBe('j1');
  });

  it('repairs a row the DELETED F7 redate had already overwritten', async () => {
    // Whether production ran that write is not knowable from this repository,
    // so both states have to converge here, on a real Firestore, not only in a
    // fixture.
    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_58').get()).data() ?? {};
    expect(doc['createdAt']).toBe('2025-10-12T09:15:00.000Z');
    expect(doc['createdAtSource']).toBe('original');
  });

  it('MARKS the unrecoverable row instead of letting an import date pass as a creation date', async () => {
    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_91').get()).data() ?? {};
    // It keeps a date that is TRUE, the day it was imported...
    expect(doc['createdAt']).toBe('2026-05-16T20:36:39.000Z');
    // ...and it says that is what the date is. Without this field it would be
    // byte-identical to a tale genuinely written that day.
    expect(doc['createdAtSource']).toBe('import');
    // And no submit stamp was invented for it.
    expect(doc['_legacySubmittedAt']).toBe('');
  });

  it('leaves a row this system really created byte-identical', async () => {
    const doc = (await db.collection(REPORTS_COLLECTION).doc('demo-report-1').get()).data();
    expect(doc).toEqual(MODERN);
    expect(doc).not.toHaveProperty('createdAtSource');
  });

  it('REFUSES the row with no usable instant at all, and reports it by id', async () => {
    const doc = (await db.collection(REPORTS_COLLECTION).doc('legacy_noinstant').get()).data() ?? {};
    // Untouched. Still wrong, and still visibly wrong, which is the point: a
    // marked guess would be worse than an unmarked gap.
    expect(doc['createdAt']).toBe('sometime last Tuesday');
    expect(doc).not.toHaveProperty('createdAtSource');

    const { summary } = await buildPlan(db);
    expect(summary.refusals).toContainEqual({
      reportId: 'legacy_noinstant',
      reason: 'no-usable-instant',
      createdAt: 'sometime last Tuesday',
    });
  });

  it('is idempotent: a second run plans nothing and changes nothing', async () => {
    const before = await db.collection(REPORTS_COLLECTION).get();
    const snapshot = before.docs.map((d) => [d.id, d.data()] as const);

    const { summary, writes } = await buildPlan(db);
    expect(writes).toEqual([]);
    expect(summary.recovered).toBe(0);
    expect(summary.markedImport).toBe(0);
    expect(summary.alreadyStamped).toBe(3);
    await applyPlan(db, writes);

    const after = await db.collection(REPORTS_COLLECTION).get();
    expect(after.docs.map((d) => [d.id, d.data()] as const)).toEqual(snapshot);
  });

  it('the whole collection now orders by createdAt chronologically', async () => {
    const snap = await db.collection(REPORTS_COLLECTION).orderBy('createdAt', 'desc').get();
    const ordered = snap.docs.map((d) => d.id);

    // The refused row is the only one still sorting by nothing, and it is named
    // in the report so a person can see exactly that.
    expect(ordered[0]).toBe('legacy_noinstant');
    // Everything the migration touched is now in real chronological order:
    // the May 2026 import date, then December 2025, October 2025, September 2025.
    expect(ordered.slice(1)).toEqual(['legacy_91', 'demo-report-1', 'legacy_58', 'legacy_57']);
  });
});
