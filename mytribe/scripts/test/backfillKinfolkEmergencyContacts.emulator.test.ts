import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { buildPlan, applyPlan } from '../backfillKinfolkEmergencyContacts';

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

describe.runIf(EMULATOR)('the Emergency Contact migration against a real document', () => {
  let db: Firestore;
  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'ec-migration-test' });
    db = getFirestore();
  });
  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('writes the array, keeps the flat fields and updatedAt, and is idempotent', async () => {
    await db.collection('kinfolk').doc('kf_ec').set({
      firstName: 'Dana',
      updatedAt: '2026-03-02T10:00:00.000Z',
      emergencyContactName: 'Rae Mercer',
      emergencyContactPhone: '805-555-0199',
      emergencyContactRelation: 'Sister',
    });
    await db.collection('kinfolk').doc('kf_done').set({
      emergencyContactName: 'Old',
      emergencyContactPhone: '8055550100',
      emergencyContacts: [{ name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null }],
    });

    const written = await applyPlan(db, await buildPlan(db));
    expect(written).toBe(1);

    const kf = (await db.collection('kinfolk').doc('kf_ec').get()).data() ?? {};
    const [c] = kf['emergencyContacts'] as Array<Record<string, any>>;
    expect(c).toMatchObject({ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' });
    expect(c['recordedAt'].toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(kf['updatedAt']).toBe('2026-03-02T10:00:00.000Z');
    expect(kf['emergencyContactName']).toBe('Rae Mercer');

    const done = (await db.collection('kinfolk').doc('kf_done').get()).data() ?? {};
    expect((done['emergencyContacts'] as unknown[])).toHaveLength(1);
    expect((done['emergencyContacts'] as Array<Record<string, unknown>>)[0]['name']).toBe('Lee Park');

    expect(await applyPlan(db, await buildPlan(db))).toBe(0);
  });
});
