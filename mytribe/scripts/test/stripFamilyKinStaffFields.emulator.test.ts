import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, deleteApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { buildPlan, applyPlan } from '../stripFamilyKinStaffFields';
/**
 * What a fixture cannot establish about the #1335 strip:
 *
 *  1. `collectionGroup('kin')` really does match the flat `kin/{docId}`
 *     collection too, and the plan leaves it alone: the flat doc is the
 *     canonical, staff-only home of these fields and must be byte-identical
 *     after the apply.
 *  2. The per-key `FieldValue.delete()` update removes exactly the staff-only
 *     keys and keeps every portal field, link and status on the family doc.
 *  3. A second run over the stripped data plans nothing.
 *
 * Runs only with an emulator: `npm run test:scripts:emulator`.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
describe.runIf(EMULATOR)('the #1335 strip removes staff-only kin fields from family docs only', () => {
  let db: Firestore;
  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'strip-1335-test' });
    db = getFirestore();
  });
  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });
  it('strips the family copies, leaves the flat doc untouched, and is idempotent', async () => {
    const FLAT = {
      kinfolkId: 'f1',
      familyKinPath: 'families/f1/kin/k1',
      name: 'Kai',
      sex: 'Male',
      officeNotes: 'bit the last sitter',
      reactive: true,
      routine: 'morning walk',
      trainingCommands: 'sit',
      feedingBrand: 'Orijen',
      vaccinations: 'Rabies 2027',
      medicationHealthNotes: 'thyroid pill',
      tags: ['Reactive'],
    };
    await db.doc('kin/flat1').set(FLAT);
    await db.doc('families/f1/kin/k1').set({
      name: 'Kai',
      species: 'Dog',
      status: 'active',
      legacyKinId: 'flat1',
      familyKinPath: 'families/f1/kin/k1',
      feedingInstructions: 'twice daily',
      sex: 'Male',
      vetInfo: 'Riverside',
      _mirrorOrigin: 'flat',
      officeNotes: 'bit the last sitter',
      reactive: true,
      routine: 'morning walk',
      vaccinations: 'Rabies 2027',
      tags: ['Reactive'],
    });
    // A family copy the flat doc does not hold: reported, still stripped.
    await db.doc('families/f2/kin/k2').set({ name: 'Bo', officeNotes: 'orphan note' });
    await db.doc('families/f3/kin/k3').set({ name: 'Clean', sex: 'Female' });
    const first = await buildPlan(db);
    expect(first.summary).toMatchObject({ scanned: 4, flatSkipped: 1, alreadyClean: 1, toStrip: 2, keysToDelete: 6 });
    expect(first.writes.map((w) => w.path).sort()).toEqual(['families/f1/kin/k1', 'families/f2/kin/k2']);
    expect(first.divergences).toEqual([
      { path: 'families/f2/kin/k2', key: 'officeNotes', comparison: 'no-flat-doc', familyValue: 'orphan note' },
    ]);
    await applyPlan(db, first.writes);
    expect((await db.doc('families/f1/kin/k1').get()).data()).toEqual({
      name: 'Kai',
      species: 'Dog',
      status: 'active',
      legacyKinId: 'flat1',
      familyKinPath: 'families/f1/kin/k1',
      feedingInstructions: 'twice daily',
      sex: 'Male',
      vetInfo: 'Riverside',
      _mirrorOrigin: 'flat',
    });
    expect((await db.doc('families/f2/kin/k2').get()).data()).toEqual({ name: 'Bo' });
    expect((await db.doc('families/f3/kin/k3').get()).data()).toEqual({ name: 'Clean', sex: 'Female' });
    expect((await db.doc('kin/flat1').get()).data()).toEqual(FLAT);
    const second = await buildPlan(db);
    expect(second.writes).toEqual([]);
    expect(second.summary).toMatchObject({ scanned: 4, flatSkipped: 1, alreadyClean: 3, toStrip: 0 });
  });
});
