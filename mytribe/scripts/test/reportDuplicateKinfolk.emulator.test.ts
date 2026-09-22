import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly: the client and
// the seeded Timestamps must come from the same copy the script reads with, and
// emulatorTestImports.test.ts fails on a direct import (#870).
import { getApps, initializeApp, getFirestore, Timestamp, type Firestore } from '../lib/firebaseAdmin';
import { buildReport } from '../reportDuplicateKinfolk';

/**
 * The #890 duplicate household report against a real Firestore (the emulator),
 * seeded with each shape the report must and must not find.
 *
 * The seeded data is LEFT IN PLACE after the run, so the npm command can be run
 * against the same emulator straight afterwards and its printed report read:
 *
 *   cd mytribe/functions
 *   npx firebase emulators:exec --only firestore --project dup-kinfolk-890-test \
 *     "npx vitest run --config vitest.scripts-emulator.config.ts ../scripts/test/reportDuplicateKinfolk.emulator.test.ts && \
 *      npm run report:duplicate-kinfolk -- --project dup-kinfolk-890-test"
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const EMULATOR_TIMEOUT_MS = 30_000;
const PROJECT = 'dup-kinfolk-890-test';
const T = Date.UTC(2026, 8, 1, 12, 0, 0);
const MIN = 60_000;

async function allDocs(db: Firestore): Promise<string[]> {
  const snap = await db.collection('kinfolk').get();
  return snap.docs.map((d) => `${d.ref.path}:${JSON.stringify(d.data())}`).sort();
}

describe.runIf(EMULATOR)('the #890 duplicate household report reads real stored households', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: PROJECT });
    db = getFirestore();
    const at = (ms: number) => Timestamp.fromMillis(ms);
    const k = db.collection('kinfolk');
    // 1. Same phone, typed two ways, 4 minutes apart: a duplicate.
    await k.doc('phone_a').set({ firstName: 'Jamie', phoneNumber: '(805) 555-0134', email: '', createdAt: at(T), createdByUid: 'op-1' });
    await k.doc('phone_b').set({ firstName: 'Jamie', phoneNumber: '805-555-0134', email: '', createdAt: at(T + 4 * MIN), createdByUid: 'op-1' });
    // 2. Same email, 30 seconds apart: a duplicate.
    await k.doc('email_a').set({ firstName: 'Pat', phoneNumber: '', email: 'Pat@example.com', createdAt: at(T), createdByUid: 'op-2' });
    await k.doc('email_b').set({ firstName: 'Pat', phoneNumber: '', email: 'pat@example.com', createdAt: at(T + 30_000), createdByUid: 'op-2' });
    // 3. Same phone a day apart: a household that came back, not a duplicate.
    await k.doc('later_a').set({ firstName: 'Lee', phoneNumber: '805-555-0177', email: '', createdAt: at(T) });
    await k.doc('later_b').set({ firstName: 'Lee', phoneNumber: '805-555-0177', email: '', createdAt: at(T + 24 * 60 * MIN) });
    // 4. Two households with no phone and no email, a minute apart: never a match.
    await k.doc('blank_a').set({ firstName: 'Sam', phoneNumber: '', email: '', createdAt: at(T) });
    await k.doc('blank_b').set({ firstName: 'Sam', phoneNumber: '', email: '', createdAt: at(T + MIN) });
    // 5. Two households written before the callable, with no createdAt: timed by
    //    their document create time, which is seconds apart here.
    await k.doc('legacy_a').set({ firstName: 'Rae', phoneNumber: '805-555-0188', email: '' });
    await k.doc('legacy_b').set({ firstName: 'Rae', phoneNumber: '(805) 555-0188', email: '' });
  }, EMULATOR_TIMEOUT_MS);

  it('finds exactly the seeded duplicates, times old households by create time, and writes nothing', async () => {
    const before = await allDocs(db);
    const report = await buildReport(db, 10 * MIN);

    expect(report.scanned).toBe(10);
    expect(report.withoutCreatedAt).toBe(2);
    const found = report.clusters.map((c) => ({ match: c.match, ids: c.households.map((h) => h.id).sort() }));
    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining([
        { match: 'phone', ids: ['phone_a', 'phone_b'] },
        { match: 'email', ids: ['email_a', 'email_b'] },
        { match: 'phone', ids: ['legacy_a', 'legacy_b'] },
      ]),
    );
    const legacy = report.clusters.find((c) => c.households.some((h) => h.id === 'legacy_a'));
    expect(legacy?.households.every((h) => h.atSource === 'createTime')).toBe(true);
    const phone = report.clusters.find((c) => c.households.some((h) => h.id === 'phone_a'));
    expect(phone?.closestGapMs).toBe(4 * MIN);
    expect(phone?.households.map((h) => h.createdByUid)).toEqual(['op-1', 'op-1']);

    expect(await allDocs(db)).toEqual(before);
  });
});
