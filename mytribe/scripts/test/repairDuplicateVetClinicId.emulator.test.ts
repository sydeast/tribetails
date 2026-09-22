import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, Timestamp, type Firestore } from '../lib/firebaseAdmin';
import { applyPlan, buildPlan, resolveTarget } from '../repairDuplicateVetClinicId';

/**
 * The #901 duplicate-`vetClinicId` repair against a real Firestore (the
 * emulator), seeded with each shape it must and must not touch.
 *
 * To read the script's own output by hand, seed with the DRY RUN test only: the
 * apply test below folds the duplicates, so running the whole file first leaves
 * the script nothing to report.
 *
 *   cd mytribe/functions
 *   npx firebase emulators:exec --only firestore --project dupvet-901-test \
 *     "npx vitest run --config vitest.scripts-emulator.config.ts ../scripts/test/repairDuplicateVetClinicId.emulator.test.ts --testNamePattern 'dry run' && \
 *      npm run repair:duplicate-vet-clinic-id -- --project dupvet-901-test"
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const EMULATOR_TIMEOUT_MS = 30_000;

const row = (key: string, value: string, label = key) => ({ key, label, value });
/** A time the repair must not move. Before the repo even existed, so today can never equal it. */
const STAMPED = Timestamp.fromDate(new Date('2024-03-11T08:15:00.000Z'));

describe.runIf(EMULATOR)('the #901 repair folds real stored duplicate vetClinicId rows', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: 'dupvet-901-test' });
    db = getFirestore();

    // 1. Three copies, and the household changed clinic along the way: the newest wins.
    await db.doc('families/fam_changed').set({
      displayName: 'Changed Clinic',
      updatedAt: STAMPED,
      createdAt: STAMPED,
      customFields: [
        row('gateNote', 'Side gate sticks', 'Set by Auntie'),
        row('vetClinicId', 'clinic-old', 'Vet Clinic'),
        row('allergy', 'Chicken', 'Allergies'),
        row('vetClinicId', 'clinic-newer', 'Vet Clinic'),
        row('vetClinicId', 'clinic-current', 'Vet Clinic'),
      ],
    });
    // 2. Two identical copies: the ordinary case, from pressing Save twice.
    await db.doc('families/fam_same').set({
      displayName: 'Same Clinic',
      updatedAt: STAMPED,
      customFields: [row('vetClinicId', 'clinic-1', 'Vet Clinic'), row('vetClinicId', 'clinic-1', 'Vet Clinic')],
    });
    // 3. One copy: untouched.
    await db.doc('families/fam_single').set({
      displayName: 'One Copy',
      updatedAt: STAMPED,
      customFields: [row('vetClinicId', 'clinic-2', 'Vet Clinic'), row('allergy', 'Beef', 'Allergies')],
    });
    // 4. No vet row at all, and a row this script cannot read: untouched, carried through.
    await db.doc('families/fam_none').set({
      displayName: 'No Vet',
      updatedAt: STAMPED,
      customFields: [row('allergy', 'Wheat', 'Allergies'), { notARow: true }],
    });
    // 5. No customFields field at all: untouched.
    await db.doc('families/fam_bare').set({ displayName: 'Bare', updatedAt: STAMPED });
  }, EMULATOR_TIMEOUT_MS);

  it('refuses --allow-prod while FIRESTORE_EMULATOR_HOST is set', () => {
    expect(() => resolveTarget({ projectId: 'dupvet-901-test', allowProd: true, apply: true, samples: 50 }, process.env)).toThrow(
      /--allow-prod refused/,
    );
  });

  it(
    'the dry run finds the duplicates and writes NOTHING',
    async () => {
      const before = await db.doc('families/fam_changed').get();
      const { report, writes } = await buildPlan(db);
      expect(report.scanned).toBe(5);
      expect(report.findings.map((f) => f.kinfolkId).sort()).toEqual(['fam_changed', 'fam_same']);
      expect(report.findings.find((f) => f.kinfolkId === 'fam_changed')).toMatchObject({
        copies: 3,
        kept: 'clinic-current',
        dropped: ['clinic-old', 'clinic-newer'],
        rowsBefore: 5,
        rowsAfter: 3,
      });
      expect(writes).toHaveLength(2);
      // buildPlan only reads.
      const after = await db.doc('families/fam_changed').get();
      expect(after.data()).toEqual(before.data());
    },
    EMULATOR_TIMEOUT_MS,
  );

  it(
    'the apply keeps the newest copy in the oldest position, keeps every other row, and does not move updatedAt',
    async () => {
      const { writes } = await buildPlan(db);
      expect(await applyPlan(db, writes)).toBe(2);

      const changed = (await db.doc('families/fam_changed').get()).data()!;
      expect(changed['customFields']).toEqual([
        row('gateNote', 'Side gate sticks', 'Set by Auntie'),
        row('vetClinicId', 'clinic-current', 'Vet Clinic'),
        row('allergy', 'Chicken', 'Allergies'),
      ]);
      // ORIGINAL timestamps, not today's.
      expect((changed['updatedAt'] as Timestamp).toMillis()).toBe(STAMPED.toMillis());
      expect((changed['createdAt'] as Timestamp).toMillis()).toBe(STAMPED.toMillis());
      expect(changed['displayName']).toBe('Changed Clinic');

      const same = (await db.doc('families/fam_same').get()).data()!;
      expect(same['customFields']).toEqual([row('vetClinicId', 'clinic-1', 'Vet Clinic')]);
      expect((same['updatedAt'] as Timestamp).toMillis()).toBe(STAMPED.toMillis());
    },
    EMULATOR_TIMEOUT_MS,
  );

  it(
    'leaves every household it did not plan for exactly as it was',
    async () => {
      const single = (await db.doc('families/fam_single').get()).data()!;
      expect(single['customFields']).toEqual([row('vetClinicId', 'clinic-2', 'Vet Clinic'), row('allergy', 'Beef', 'Allergies')]);
      const none = (await db.doc('families/fam_none').get()).data()!;
      expect(none['customFields']).toEqual([row('allergy', 'Wheat', 'Allergies'), { notARow: true }]);
      const bare = (await db.doc('families/fam_bare').get()).data()!;
      expect(bare['customFields']).toBeUndefined();
    },
    EMULATOR_TIMEOUT_MS,
  );

  it(
    'a second run plans nothing: the repair is idempotent',
    async () => {
      const { report, writes } = await buildPlan(db);
      expect(report.findings).toEqual([]);
      expect(writes).toEqual([]);
    },
    EMULATOR_TIMEOUT_MS,
  );
});
