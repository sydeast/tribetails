import { describe, it, expect, beforeAll } from 'vitest';
// Through the shared module, never 'firebase-admin/*' directly (#870).
import { getApps, initializeApp, getFirestore, type Firestore } from '../lib/firebaseAdmin';
import { buildReport } from '../reportTruncatedCustomFields';

/**
 * The #873 truncated customFields report against a real Firestore (the
 * emulator), seeded with each shape it must and must not flag.
 *
 * The seeded data is LEFT IN PLACE so the npm command can be run against the
 * same emulator straight afterwards and its output read by eye:
 *
 *   cd mytribe/functions
 *   npx firebase emulators:exec --only firestore --project truncated-873-test \
 *     "npx vitest run --config vitest.scripts-emulator.config.ts ../scripts/test/reportTruncatedCustomFields.emulator.test.ts && \
 *      npm run report:truncated-custom-fields -- --project truncated-873-test"
 */
const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];
const EMULATOR_TIMEOUT_MS = 30_000;

const rows = (...kv: Array<[string, string]>) => kv.map(([key, value]) => ({ key, label: key, value }));

async function allDocs(db: Firestore): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['formSchemas', 'families', 'activity_log']) {
    const snap = await db.collection(c).get();
    for (const d of snap.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  }
  const home = await db.collectionGroup('homeAccess').get();
  for (const d of home.docs) out.push(`${d.ref.path}:${JSON.stringify(d.data())}`);
  return out.sort();
}

describe.runIf(EMULATOR)('the #873 report reads real stored customFields', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (getApps().length === 0) initializeApp({ projectId: 'truncated-873-test' });
    db = getFirestore();
    const field = (key: string) => ({ key, label: key, type: 'text' });
    await db.doc('formSchemas/tribeProfile').set({ sections: [{ title: 'Family', fields: [field('displayName'), field('allergy'), field('color')] }] });
    await db.doc('formSchemas/homeAccess').set({ sections: [{ title: 'Home', fields: [field('gateCode'), field('alarm'), field('pool')] }] });

    // 1. Exactly the schema rebuild, and a portal save is on record: flagged, strong.
    await db.doc('families/fam_trunc').set({ displayName: 'A', customFields: rows(['allergy', ''], ['color', 'Blue'], ['vetClinicId', 'c1']) });
    await db.doc('activity_log/a1').set({
      actionType: 'PROFILE_UPDATED', targetId: 'fam_trunc', timestamp: '2026-09-01T10:00:00.000Z',
      payload: { kinfolkId: 'fam_trunc', fields: ['displayName', 'customFields'] },
    });
    await db.doc('families/fam_trunc/homeAccess/current').set({ updatedByUid: 'u1', customFields: rows(['alarm', ''], ['pool', ''], ['afterHoursVetPhone', '805']) });
    // 2. Has an office row outside the schema: not flagged on either surface.
    await db.doc('families/fam_ok').set({ displayName: 'B', customFields: rows(['gateNote', 'x'], ['allergy', 'a'], ['color', '']) });
    await db.doc('activity_log/a2').set({ actionType: 'PROFILE_UPDATED', targetId: 'fam_ok', timestamp: '2026-09-01T10:00:00.000Z', payload: { fields: ['customFields'] } });
    await db.doc('families/fam_ok/homeAccess/current').set({ updatedByUid: 'u2', customFields: rows(['shed', 'x'], ['alarm', '1'], ['pool', '2']) });
    // 3. Schema-only but no portal save on record: flagged, weak.
    await db.doc('families/fam_noaudit').set({ displayName: 'C', customFields: rows(['allergy', 'a'], ['color', 'b']) });
    // 4. Missing a schema key, so not the rebuild: not flagged.
    await db.doc('families/fam_partial').set({ displayName: 'D', customFields: rows(['allergy', 'a']) });
    // 5. A displayName-only audit entry is not a customFields save.
    await db.doc('families/fam_nameonly').set({ displayName: 'E', customFields: rows(['allergy', 'a'], ['color', 'b']) });
    await db.doc('activity_log/a3').set({ actionType: 'PROFILE_UPDATED', targetId: 'fam_nameonly', timestamp: '2026-09-01T10:00:00.000Z', payload: { fields: ['displayName'] } });
    // 6. #873 review lockout risks: 41 rows with one unlabeled and one long value on
    // families, 41 rows on homeAccess. Not truncated (keys outside the schema).
    const office = Array.from({ length: 39 }, (_, i) => ({ key: `office${i}`, label: `Office ${i}`, value: 'kept' }));
    await db.doc('families/fam_big').set({
      displayName: 'F',
      customFields: [...office, { key: 'noLabel', value: 'Secret A' }, { key: 'longOne', label: 'Long', value: 'Q'.repeat(1001) }],
    });
    await db.doc('families/fam_big/homeAccess/current').set({ customFields: [...office, { key: 'blank', label: '', value: 'Secret B' }, { key: 'pool', label: 'Pool', value: 'Heated' }] });
    // 7. #873 second review: 70 rows of 1000 characters (the longest value the
    // callables accept, so no long-value risk), about 72 KiB: over the 64 KiB
    // growth ceiling and past the old 40-row cap, with no label risk.
    await db.doc('families/fam_heavy').set({
      displayName: 'G',
      customFields: Array.from({ length: 70 }, (_, i) => ({ key: `note${i}`, label: `Note ${i}`, value: 'W'.repeat(1000) })),
    });
  }, EMULATOR_TIMEOUT_MS);

  it('flags exactly the seeded truncations, splits strong from weak evidence, and writes nothing', async () => {
    const before = await allDocs(db);
    const report = await buildReport(db);
    const after = await allDocs(db);

    expect(after).toEqual(before);
    expect(report.schemas).toEqual({ tribeProfile: ['displayName', 'allergy', 'color'], homeAccess: ['gateCode', 'alarm', 'pool'] });
    expect(report.scannedFamilies).toBe(7);
    expect(report.lockoutRisks).toEqual([
      expect.objectContaining({ surface: 'families', kinfolkId: 'fam_big', path: 'families/fam_big', rows: 41, blankLabelKeys: ['noLabel'], longValueKeys: ['longOne'] }),
      expect.objectContaining({ surface: 'families', kinfolkId: 'fam_heavy', path: 'families/fam_heavy', rows: 70, blankLabelKeys: [], longValueKeys: [] }),
      expect.objectContaining({ surface: 'homeAccess', kinfolkId: 'fam_big', path: 'families/fam_big/homeAccess/current', rows: 41, blankLabelKeys: ['blank'], longValueKeys: [] }),
    ]);
    const heavy = report.lockoutRisks.find((r) => r.kinfolkId === 'fam_heavy');
    expect(heavy?.bytes).toBeGreaterThan(64 * 1024);
    expect(heavy?.bytes).toBeLessThan(900 * 1024);
    expect(JSON.stringify(report)).not.toContain('Secret');
    expect(JSON.stringify(report)).not.toContain('QQQQ');
    expect(JSON.stringify(report)).not.toContain('WWWW');
    const found = report.findings.map((f) => `${f.surface} ${f.kinfolkId} ${f.portalSave ? 'strong' : 'weak'}`).sort();
    expect(found).toEqual([
      'families fam_nameonly weak',
      'families fam_noaudit weak',
      'families fam_trunc strong',
      'homeAccess fam_trunc strong',
    ]);
    // Keys only, never values: home access rows hold gate codes.
    expect(JSON.stringify(report)).not.toContain('805');
    expect(JSON.stringify(report)).not.toContain('Blue');
  }, EMULATOR_TIMEOUT_MS);
});
