import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { buildPlan, buildFamiliesPlan, applyPlan } from '../backfillKinfolkEmergencyContacts';

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

    const written = await applyPlan(db, await buildPlan(db), await buildFamiliesPlan(db));
    expect(written).toEqual({ migrated: 1, familiesCleaned: 0 });

    const kf = (await db.collection('kinfolk').doc('kf_ec').get()).data() ?? {};
    const [c] = kf['emergencyContacts'] as Array<Record<string, any>>;
    expect(c).toMatchObject({ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' });
    expect(c!['recordedAt'].toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(kf['updatedAt']).toBe('2026-03-02T10:00:00.000Z');
    expect(kf['emergencyContactName']).toBe('Rae Mercer');

    const done = (await db.collection('kinfolk').doc('kf_done').get()).data() ?? {};
    expect((done['emergencyContacts'] as unknown[])).toHaveLength(1);
    expect((done['emergencyContacts'] as Array<Record<string, unknown>>)[0]!['name']).toBe('Lee Park');

    expect(await applyPlan(db, await buildPlan(db), await buildFamiliesPlan(db))).toEqual({ migrated: 0, familiesCleaned: 0 });
  });

  it('moves a portal copy from families customFields, keeps its original date, and deletes the stale keys in every case', async () => {
    const familiesDate = Timestamp.fromDate(new Date('2026-02-10T09:30:00Z'));
    const ec = (name: string, phone: string) => [
      { key: 'emergencyContactName', label: 'Emergency Contact', value: name },
      { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: phone },
    ];
    const vet = { key: 'vetClinicId', label: 'Vet Clinic', value: 'clinic-1' };

    // Kinfolk with none: the families copy moves, dated by the families doc.
    await db.collection('kinfolk').doc('kf_fam_move').set({ firstName: 'Ana' });
    await db.collection('families').doc('kf_fam_move').set({ displayName: 'Ana', updatedAt: familiesDate, customFields: [vet, ...ec('Sam Ortiz', '(805) 555-0111')] });
    // Kinfolk with none and a families doc with no date: moved as date unknown.
    await db.collection('kinfolk').doc('kf_fam_nodate').set({ firstName: 'Bo' });
    await db.collection('families').doc('kf_fam_nodate').set({ customFields: ec('Kim Lee', '8055550122') });
    // Kinfolk already holds a contact: the office copy wins, the families keys go.
    await db.collection('kinfolk').doc('kf_fam_strip').set({
      emergencyContacts: [{ name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null }],
    });
    await db.collection('families').doc('kf_fam_strip').set({ customFields: [vet, ...ec('Stale Name', '8055550133')] });

    const families = await buildFamiliesPlan(db);
    expect(families.map((r) => [r.kinfolkId, r.plan.action]).sort()).toEqual([
      ['kf_fam_move', 'move'],
      ['kf_fam_nodate', 'move'],
      ['kf_fam_strip', 'strip'],
    ]);

    expect(await applyPlan(db, await buildPlan(db), families)).toEqual({ migrated: 2, familiesCleaned: 3 });

    const moved = (await db.collection('kinfolk').doc('kf_fam_move').get()).data() ?? {};
    const [m] = moved['emergencyContacts'] as Array<Record<string, any>>;
    expect(m).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111', relationship: null });
    expect(m!['recordedAt'].toDate().toISOString()).toBe('2026-02-10T09:30:00.000Z');
    const movedFam = (await db.collection('families').doc('kf_fam_move').get()).data() ?? {};
    expect(movedFam['customFields']).toEqual([vet]);
    expect((movedFam['updatedAt'] as Timestamp).isEqual(familiesDate)).toBe(true);

    const nodate = (await db.collection('kinfolk').doc('kf_fam_nodate').get()).data() ?? {};
    expect((nodate['emergencyContacts'] as Array<Record<string, unknown>>)[0]!['recordedAt']).toBeNull();
    expect((await db.collection('families').doc('kf_fam_nodate').get()).data()?.['customFields']).toEqual([]);

    const strip = (await db.collection('kinfolk').doc('kf_fam_strip').get()).data() ?? {};
    expect((strip['emergencyContacts'] as Array<Record<string, unknown>>)[0]!['name']).toBe('Lee Park');
    expect((await db.collection('families').doc('kf_fam_strip').get()).data()?.['customFields']).toEqual([vet]);

    expect(await buildFamiliesPlan(db)).toEqual([]);
    expect(await applyPlan(db, await buildPlan(db), await buildFamiliesPlan(db))).toEqual({ migrated: 0, familiesCleaned: 0 });
  });
});
