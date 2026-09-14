import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly: the script's
// FieldValue.delete() comes from lib/firebaseAdmin's copy, and a client from any
// other copy refuses to serialize it (#870).
import { getApps, initializeApp, deleteApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { buildPlan, applyPlan, RETIRED_KINFOLK_VET_FIELDS } from '../backfillKinfolkVetToHousehold';
/**
 * TRAP 1, PROVEN RATHER THAN REASONED ABOUT.
 *
 * Android's `updateKinfolk` writes with `SetOptions.merge()`, so a field the
 * Kotlin model no longer declares is never written AND the stored value
 * survives. Removing the eight vet fields from the model therefore closes the
 * write path but leaves a fully populated second copy on every existing
 * document, which still looks authoritative to the next reader.
 *
 * The fix is `FieldValue.delete()`, and merge semantics are exactly the kind of
 * thing a fixture cannot establish. So this seeds a REAL document carrying the
 * old fields, runs the migration against the emulator, reads the document back,
 * and asserts the fields are actually gone and the new ids actually landed.
 *
 * Runs only against the emulator (`npm run test:scripts:emulator` starts one). It
 * refuses to run without FIRESTORE_EMULATOR_HOST rather than risk touching
 * anything real.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
describe.runIf(EMULATOR)('the migration really deletes the retired kinfolk fields', () => {
  let db: Firestore;
  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'a2-migration-test' });
    db = getFirestore();
  });
  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });
  it('carries the clinic link across and CLEARS the old copy', async () => {
    // A household written before the ruling: catalog-linked on the kinfolk doc,
    // with the denormalized strings beside it, and a household_data record that
    // knows nothing about a vet.
    await db.collection('kinfolk').doc('kf_link').set({
      firstName: 'Loretta',
      vetClinicId: 'clinic_riverside',
      vetClinicName: 'Riverside Animal Hospital',
      vetClinicPhone: '(512) 555 0100',
      vetClinicAddress: '418 Mill St',
      emergencyVetClinicId: 'clinic_er',
      emergencyVetClinicName: 'Austin Pet ER',
      emergencyVetClinicPhone: '(512) 555 0300',
      emergencyVetClinicAddress: '4 Night Ln',
    });
    await db.collection('household_data').doc('hd_link').set({
      kinfolkId: 'kf_link',
      foodLocation: 'Pantry',
    });
    const { writes } = await buildPlan(db);
    await applyPlan(db, writes);
    // The link landed on household_data.
    const hh = (await db.collection('household_data').doc('hd_link').get()).data() ?? {};
    expect(hh['primaryVetClinicId']).toBe('clinic_riverside');
    expect(hh['emergencyVetClinicId']).toBe('clinic_er');
    // Untouched fields survive: this is a merge, not a replace.
    expect(hh['foodLocation']).toBe('Pantry');
    // THE ASSERTION THIS FILE EXISTS FOR: the old copy is GONE from the
    // document, not merely absent from the model.
    const kf = (await db.collection('kinfolk').doc('kf_link').get()).data() ?? {};
    for (const field of RETIRED_KINFOLK_VET_FIELDS) {
      expect(kf, `${field} still on the kinfolk doc`).not.toHaveProperty(field);
    }
    // And the rest of the document is intact.
    expect(kf['firstName']).toBe('Loretta');
  });
  it('carries an UNLINKED household s free text across, then clears it', async () => {
    await db.collection('kinfolk').doc('kf_legacy').set({
      firstName: 'Sam',
      vetClinicId: '',
      vetClinicName: 'Barton Creek Animal Hospital',
      vetClinicPhone: '(512) 555 0134',
    });
    await db.collection('household_data').doc('hd_legacy').set({ kinfolkId: 'kf_legacy' });
    const { writes } = await buildPlan(db);
    await applyPlan(db, writes);
    const hh = (await db.collection('household_data').doc('hd_legacy').get()).data() ?? {};
    expect(hh['primaryVetName']).toBe('Barton Creek Animal Hospital');
    expect(hh['primaryVetPhone']).toBe('(512) 555 0134');
    // No id was invented from the name.
    expect(hh['primaryVetClinicId']).toBeUndefined();
    const kf = (await db.collection('kinfolk').doc('kf_legacy').get()).data() ?? {};
    for (const field of RETIRED_KINFOLK_VET_FIELDS) {
      expect(kf).not.toHaveProperty(field);
    }
  });
  it('is idempotent: a second run plans and changes nothing', async () => {
    const before = (await db.collection('household_data').doc('hd_link').get()).data();
    const { writes } = await buildPlan(db);
    expect(writes).toEqual([]);
    await applyPlan(db, writes);
    const after = (await db.collection('household_data').doc('hd_link').get()).data();
    expect(after).toEqual(before);
  });
});
