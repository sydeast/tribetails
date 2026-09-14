import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly: the script
// builds its writes from lib/firebaseAdmin's copy, so the client must come from
// the same one (#870).
import { getApps, initializeApp, deleteApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { buildPlan, applyPlan, CREATED_BY_BACKFILL } from '../backfillTribalIntelTargetIds';

/**
 * The two things a fixture cannot establish about the #460 sweep:
 *
 *  1. `{ merge: true }` really does repoint the target WITHOUT touching the
 *     note's own text. A replace here would silently erase the intel the row
 *     exists to carry, and merge semantics are a server behavior, not a
 *     property of the plan object.
 *  2. The created kinfolk really exists by the time a training_documents row
 *     names it, so no reader can catch the collection mid-repair in the exact
 *     unresolvable state this script exists to end.
 *
 * Runs only against the emulator (`npm run test:scripts:emulator` starts one). It refuses
 * to run without FIRESTORE_EMULATOR_HOST rather than risk touching anything
 * real, the same gate its sibling emulator test uses.
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

describe.runIf(EMULATOR)('the Tribal Intel sweep really repoints rows without eating them', () => {
  let db: Firestore;

  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'tribal-intel-460-test' });
    db = getFirestore();
  });

  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('resolves a name, creates the missing one, and leaves the ambiguous row alone', async () => {
    await db.collection('kinfolk').doc('kf_jane').set({ firstName: 'Jane', lastName: 'Halbrook' });
    await db.collection('kinfolk').doc('kf_chris_a').set({ firstName: 'Chris', lastName: 'Doyle' });
    await db.collection('kinfolk').doc('kf_chris_b').set({ firstName: 'Chris', lastName: 'Doyle' });

    await db.collection('training_documents').doc('td_name').set({
      title: 'Gate code',
      content: 'Side gate code is 4321.',
      kinfolkRef: 'Jane Halbrook',
      reconcileStatus: 'skipped',
    });
    await db.collection('training_documents').doc('td_missing').set({
      content: 'Nora leaves the key under the mat.',
      kinfolkRef: 'Nora Bell',
    });
    await db.collection('training_documents').doc('td_ambiguous').set({
      content: 'Chris wants texts, not calls.',
      kinfolkRef: 'Chris Doyle',
    });

    const plan = await buildPlan(db);
    await applyPlan(db, plan);

    // The name resolved to the one household that answers to it, in BOTH
    // fields, and the note itself is untouched.
    const named = (await db.collection('training_documents').doc('td_name').get()).data() ?? {};
    expect(named['targetKinfolkId']).toBe('kf_jane');
    expect(named['kinfolkRef']).toBe('kf_jane');
    expect(named['content']).toBe('Side gate code is 4321.');
    expect(named['title']).toBe('Gate code');
    expect(named['reconcileStatus']).toBe('skipped');

    // The missing person got a real record, and the row points at it.
    const missing = (await db.collection('training_documents').doc('td_missing').get()).data() ?? {};
    const newId = String(missing['targetKinfolkId'] ?? '');
    expect(newId).not.toBe('');
    expect(missing['kinfolkRef']).toBe(newId);
    const created = (await db.collection('kinfolk').doc(newId).get()).data() ?? {};
    expect(created['displayName']).toBe('Nora Bell');
    expect(created['_createdBy']).toBe(CREATED_BY_BACKFILL);

    // The ambiguous row is EXACTLY as it was. Nothing guessed, nothing written.
    const ambiguous = (await db.collection('training_documents').doc('td_ambiguous').get()).data() ?? {};
    expect(ambiguous['kinfolkRef']).toBe('Chris Doyle');
    expect(ambiguous['targetKinfolkId']).toBeUndefined();
  });
});
