import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => mocks.dbFn.mockReset());

import { adoptFlatKin, mirrorFlatKinToFamily, onFlatKinWrite } from '../src/triggers/onFlatKinWrite';
import {
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  PARENT_OWNED_FIELDS,
  STAFF_EDITABLE_FIELDS,
  HOUSEHOLD_SHARED_FIELDS,
  FLAT_MIRROR_FIELDS,
  STAFF_ONLY_KIN_FIELDS,
  omitKeys,
} from '../src/triggers/kinMirror';

const FAMILY_PATH = 'families/kf1/kin/pet1';
/** A household copy that exists, so the reverse mirror merges into it. */
const EXISTING = { [FAMILY_PATH]: { name: 'Rex', status: 'active' } };

describe('onFlatKinWrite: exports', () => {
  it('exports the trigger', () => {
    expect(onFlatKinWrite).toBeDefined();
  });
});

describe('mirrorFlatKinToFamily: REVERSE mirror of staff-editable fields', () => {
  it('mirrors the changed shared field into the family doc, stamps flat origin, excludes parent fields', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { familyKinPath: FAMILY_PATH, weight: 'old', vetInfo: 'Dr A' };
    const after = {
      familyKinPath: FAMILY_PATH,
      legacyKinId: 'flat1',
      weight: '52 lbs',
      vetInfo: 'Dr A',
      // household-owned fields present on the flat doc must NOT be mirrored back:
      name: 'StaleStaffName',
      photoUrl: 'https://staff/clobber.jpg',
    };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('mirrored');

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH);
    expect(fam).toBeTruthy();
    expect(fam!.merge).toBe(true);
    expect(fam!.data.weight).toBe('52 lbs');
    // Only what changed travels: vetInfo was the same before and after.
    expect(fam!.data).not.toHaveProperty('vetInfo');
    expect(fam!.data._mirrorOrigin).toBe(MIRROR_ORIGIN_FLAT);
    expect(typeof fam!.data._mirrorWriteId).toBe('string');
    expect(fam!.data).not.toHaveProperty('name');
    expect(fam!.data).not.toHaveProperty('photoUrl');
  });

  it('SKIPS the forward mirror own write: a family origin with a write id new on this write', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { familyKinPath: FAMILY_PATH, weight: 'old', _mirrorOrigin: MIRROR_ORIGIN_FAMILY, _mirrorWriteId: 'w1' };
    const after = {
      familyKinPath: FAMILY_PATH,
      weight: 'changed-by-family-mirror',
      _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
      _mirrorWriteId: 'w2',
    };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('family-origin');
    expect(ctx.writes.filter((w) => w.path === FAMILY_PATH)).toHaveLength(0);
  });

  it('MIRRORS an admin edit made after a forward mirror write: the left-over origin flag is not an echo (#1907)', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);

    // The admin edit leaves the flag and the write id exactly as the forward
    // mirror left them. This used to be skipped as `family-origin`.
    const before = { familyKinPath: FAMILY_PATH, weight: '40 lbs', _mirrorOrigin: MIRROR_ORIGIN_FAMILY, _mirrorWriteId: 'w1' };
    const after = { familyKinPath: FAMILY_PATH, weight: '45 lbs', _mirrorOrigin: MIRROR_ORIGIN_FAMILY, _mirrorWriteId: 'w1' };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('mirrored');
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data.weight).toBe('45 lbs');
  });

  it('SKIPS when no staff-editable field changed (our own write bouncing back)', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { familyKinPath: FAMILY_PATH, weight: 'same', vetInfo: 'Dr A' };
    const after = {
      familyKinPath: FAMILY_PATH,
      weight: 'same',
      vetInfo: 'Dr A',
      _mirrorOrigin: MIRROR_ORIGIN_FLAT,
      updatedAt: '__SERVER_TS__',
    };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('no-change');
    expect(ctx.writes.filter((w) => w.path === FAMILY_PATH)).toHaveLength(0);
  });

  it('SKIPS a flat doc with no link when the trigger cannot name it (no doc id)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily({ weight: 'old' } as any, { weight: 'new', name: 'OnlyInAuntie' } as any);
    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('no-link');
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * #1907, #1908: the admin's medication notes and age reach the household under
 * the household's own keys.
 */
describe('mirrorFlatKinToFamily: translated fields (#1907, #1908 kin-meds)', () => {
  it('carries Medication / health notes to the household Medications', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, medicationHealthNotes: '' } as any,
      { familyKinPath: FAMILY_PATH, medicationHealthNotes: 'Thyroid tablet' } as any,
    );
    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    expect(fam.data.medications).toBe('Thyroid tablet');
    expect(fam.data).not.toHaveProperty('medicationHealthNotes');
  });

  it('carries an age typed in the admin as a number of years', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, age: '' } as any,
      { familyKinPath: FAMILY_PATH, age: '4.5' } as any,
    );
    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    expect(fam.data.ageYears).toBe(4.5);
    expect(fam.data).not.toHaveProperty('age');
  });

  it('a cleared admin age clears the household age; text with no number changes nothing', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await mirrorFlatKinToFamily({ familyKinPath: FAMILY_PATH, age: '3' } as any, { familyKinPath: FAMILY_PATH, age: '' } as any);
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data.ageYears).toBeNull();

    const ctx2 = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx2.db);
    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, age: '3' } as any,
      { familyKinPath: FAMILY_PATH, age: 'senior' } as any,
    );
    expect(res).toMatchObject({ action: 'skipped', reason: 'no-change' });
    expect(ctx2.writes).toHaveLength(0);
  });
});

/**
 * #1908 (owner ruling 2026-11-11): the care facts the admin always kept are
 * the household's to fill too, and the household's care block is the admin's.
 */
describe('mirrorFlatKinToFamily: #1908 shared care fields', () => {
  for (const [field, value] of [
    ['staysAs', 'Crate at night'],
    ['routine', 'Walk at 7'],
    ['trainingCommands', 'Sit, stay'],
    ['feedingBrand', 'Acme kibble'],
    ['vaccinations', 'Rabies 2027'],
    ['feedingInstructions', '1 cup AM'],
    ['walkingInstructions', 'Short loop'],
    ['allergies', 'Chicken'],
    ['emergencyNotes', 'Call the vet first'],
    ['sitterNotes', 'Leash by the door'],
    ['ownVetClinicId', 'clinic-2'],
  ] as const) {
    it(`an admin edit of ${field} reaches the household`, async () => {
      const ctx = buildDbMock({ docs: { ...EXISTING } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const res = await mirrorFlatKinToFamily(
        { familyKinPath: FAMILY_PATH, [field]: '' } as any,
        { familyKinPath: FAMILY_PATH, [field]: value } as any,
      );
      expect(res.action).toBe('mirrored');
      expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data[field]).toBe(value);
    });
  }
});

/**
 * P0-9 and #1847: a link to a household copy that does not exist yet makes the
 * whole copy, never a nameless shell of the changed fields.
 */
describe('mirrorFlatKinToFamily: a household copy that does not exist yet', () => {
  it('makes the whole copy, status active and tied to this record', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old' } as any,
      { familyKinPath: FAMILY_PATH, kinfolkId: 'kf1', name: 'Rex', species: 'Dog', age: '4', weight: 'new' } as any,
      'flat1',
    );
    expect(res.action).toBe('adopted');

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    expect(fam.merge).toBe(false);
    expect(fam.data).toMatchObject({ name: 'Rex', species: 'Dog', ageYears: 4, weight: 'new', status: 'active', legacyKinId: 'flat1' });
  });

  it('admin Android stamping the link after its add makes the copy, even with no shared field changed', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await mirrorFlatKinToFamily(
      { kinfolkId: 'kf1', name: 'Rex' } as any,
      { kinfolkId: 'kf1', name: 'Rex', familyKinPath: FAMILY_PATH } as any,
      'pet1',
    );
    expect(res.action).toBe('adopted');
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data.name).toBe('Rex');
  });

  it('an archived record makes no copy', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old', status: 'archived' } as any,
      { familyKinPath: FAMILY_PATH, weight: 'new', status: 'archived' } as any,
      'flat1',
    );
    expect(res.action).toBe('skipped');
    expect(ctx.writes).toHaveLength(0);
  });

  it('seeds status active when the family doc exists but carries no status', async () => {
    const ctx = buildDbMock({ docs: { [FAMILY_PATH]: { name: 'Rex' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old' } as any,
      { familyKinPath: FAMILY_PATH, weight: 'new' } as any,
    );
    expect(res.action).toBe('mirrored');
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data.status).toBe('active');
  });

  it('NEVER overwrites a memorial status the parent already set', async () => {
    const ctx = buildDbMock({
      docs: { [FAMILY_PATH]: { name: 'Rex', status: 'noLongerWithUs' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old' } as any,
      { familyKinPath: FAMILY_PATH, weight: 'new', status: 'active' } as any,
    );
    expect(res.action).toBe('mirrored');

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH);
    expect(fam!.data).not.toHaveProperty('status');
    expect(fam!.data.weight).toBe('new');
  });

  it('leaves an existing active status alone rather than rewriting it', async () => {
    const ctx = buildDbMock({ docs: { [FAMILY_PATH]: { name: 'Rex', status: 'active' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old' } as any,
      { familyKinPath: FAMILY_PATH, weight: 'new' } as any,
    );
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data).not.toHaveProperty('status');
  });
});

/**
 * #1847: the portal Tribe page said "No Kin yet" for a household whose admin
 * Directory card listed a Kin. Admin web made the Kin with no link at all, so
 * this trigger skipped it as `no-link` and the household never got a copy.
 */
describe('adoptFlatKin (#1847)', () => {
  const FLAT = { kinfolkId: 'kf1', name: 'Biscuit', species: 'Dog', breed: 'Lab', age: '4 years', sex: 'Male', status: 'active' };

  it('a Kin the office made with no link gets its household copy, and the record is tied to it', async () => {
    const ctx = buildDbMock({ docs: { 'kin/flat1': { ...FLAT } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(undefined, { ...FLAT } as any, 'flat1');
    expect(res).toEqual({ action: 'adopted', familyKinPath: 'families/kf1/kin/flat1' });

    const fam = ctx.writes.find((w) => w.path === 'families/kf1/kin/flat1')!;
    expect(fam.data).toMatchObject({
      name: 'Biscuit',
      species: 'Dog',
      breed: 'Lab',
      ageYears: 4,
      sex: 'Male',
      status: 'active',
      legacyKinId: 'flat1',
      _mirrorOrigin: MIRROR_ORIGIN_FLAT,
    });
    const flat = ctx.writes.find((w) => w.path === 'kin/flat1')!;
    expect(flat.data).toMatchObject({ familyKinPath: 'families/kf1/kin/flat1', legacyKinId: 'flat1', _mirrorOrigin: MIRROR_ORIGIN_FAMILY });
    // Staff-only values never travel with the copy.
    for (const f of STAFF_ONLY_KIN_FIELDS) expect(fam.data).not.toHaveProperty(f);
  });

  it('a household copy already stamped with the record keeps it: the pointer is repaired, nothing new is made', async () => {
    const ctx = buildDbMock({
      docs: { 'kin/flat1': { ...FLAT }, 'families/kf1/kin/k9': { name: 'Biscuit', legacyKinId: 'flat1' } },
      queryDocs: { 'families/kf1/kin': [{ id: 'k9', data: { name: 'Biscuit', legacyKinId: 'flat1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await adoptFlatKin('flat1', { ...FLAT } as any);
    expect(res).toEqual({ action: 'linked', familyKinPath: 'families/kf1/kin/k9' });
    expect(ctx.writes.find((w) => w.path === 'families/kf1/kin/flat1')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')!.data.familyKinPath).toBe('families/kf1/kin/k9');
  });

  it('an unstamped live household Kin of the same name is the same animal and is tied, not duplicated', async () => {
    const ctx = buildDbMock({
      docs: { 'kin/flat1': { ...FLAT }, 'families/kf1/kin/k2': { name: 'Biscuit', status: 'active' } },
      queryDocs: { 'families/kf1/kin': [{ id: 'k2', data: { name: 'Biscuit', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await adoptFlatKin('flat1', { ...FLAT } as any);
    expect(res.action).toBe('linked');
    expect(ctx.writes.find((w) => w.path === 'families/kf1/kin/k2')!.data.legacyKinId).toBe('flat1');
  });

  it('an archived record, a record with no household, and a record linked meanwhile get nothing', async () => {
    const ctx = buildDbMock({ docs: { 'kin/flat1': { ...FLAT, status: 'archived' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await adoptFlatKin('flat1', { ...FLAT, status: 'archived' } as any)).toEqual({ action: 'skipped', reason: 'inactive' });
    expect(await adoptFlatKin('flat1', { ...FLAT, kinfolkId: '' } as any)).toEqual({ action: 'skipped', reason: 'no-household' });

    const ctx2 = buildDbMock({ docs: { 'kin/flat1': { ...FLAT, familyKinPath: 'families/kf1/kin/k7' } } });
    mocks.dbFn.mockReturnValue(ctx2.db);
    expect(await adoptFlatKin('flat1', { ...FLAT } as any)).toEqual({ action: 'skipped', reason: 'linked-elsewhere' });
    expect(ctx.writes).toHaveLength(0);
    expect(ctx2.writes).toHaveLength(0);
  });
});

describe('kinMirror field-ownership contract', () => {
  it('declares status parent-owned, so no reverse mirror can ever carry it', () => {
    expect(PARENT_OWNED_FIELDS).toContain('status');
    expect(STAFF_EDITABLE_FIELDS).not.toContain('status');
  });

  it('household-shared fields travel both ways and are owned by neither side exclusively (#1310, #1908)', () => {
    for (const f of HOUSEHOLD_SHARED_FIELDS) {
      expect(STAFF_EDITABLE_FIELDS).toContain(f);
      expect(FLAT_MIRROR_FIELDS).toContain(f);
      expect(PARENT_OWNED_FIELDS).not.toContain(f);
    }
    expect([...HOUSEHOLD_SHARED_FIELDS].sort()).toEqual([
      'allergies',
      'colorMarkings',
      'emergencyNotes',
      'feedingBrand',
      'feedingInstructions',
      'ownVetClinicId',
      'routine',
      'sex',
      'sitterNotes',
      'spayedNeutered',
      'staysAs',
      'trainingCommands',
      'vaccinations',
      'vetInfo',
      'walkingInstructions',
      'weight',
    ]);
    // Medications and age travel too, each under its own key on each copy.
    expect(FLAT_MIRROR_FIELDS).toEqual(expect.arrayContaining(['medications', 'ageYears']));
    expect(STAFF_EDITABLE_FIELDS).toEqual(expect.arrayContaining(['medicationHealthNotes', 'age']));
  });
  it('keeps the two ownership lists disjoint', () => {
    const overlap = PARENT_OWNED_FIELDS.filter((f) => STAFF_EDITABLE_FIELDS.includes(f));
    expect(overlap).toEqual([]);
  });

  it('drops every parent-owned key from a payload that somehow contains one', () => {
    const stripped = omitKeys({ weight: 'new', status: 'active', name: 'STAFF_VALUE' }, PARENT_OWNED_FIELDS);
    expect(stripped).toEqual({ weight: 'new' });
  });

  it('writes no parent-owned field into the family doc, whatever the flat doc carries', async () => {
    const ctx = buildDbMock({ docs: { [FAMILY_PATH]: { status: 'noLongerWithUs' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const after: Record<string, unknown> = { familyKinPath: FAMILY_PATH, weight: 'new' };
    for (const f of PARENT_OWNED_FIELDS) after[f] = 'STAFF_VALUE';

    await mirrorFlatKinToFamily({ familyKinPath: FAMILY_PATH, weight: 'old' } as any, after as any);

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    for (const f of PARENT_OWNED_FIELDS) expect(fam.data).not.toHaveProperty(f);
  });
});
/**
 * #1335: every active household member can read `families/{fid}/kin/{kinId}`
 * with the client SDK, and a rule cannot hide one field. So the guarantee that
 * a household never sees a staff note about its pet is that the reverse mirror
 * never writes one there. #1908 moved the care facts the owner ruled the
 * household's to fill out of this list; what stays is the office's own.
 */
describe('mirrorFlatKinToFamily: staff-only fields never reach the family doc (#1335)', () => {
  const STAFF_VALUES: Record<string, unknown> = {
    officeNotes: 'bit the last Auntie, muzzle on walks',
    reactive: true,
    tags: ['Reactive', 'VIP'],
  };
  it('names exactly the staff-only fields, and none of them is mirrored', () => {
    expect([...STAFF_ONLY_KIN_FIELDS].sort()).toEqual(['medicationHealthNotes', 'officeNotes', 'reactive', 'tags']);
    // medicationHealthNotes is read by the reverse mirror, but lands on the
    // family doc only as `medications`, never under its own name.
    expect(STAFF_ONLY_KIN_FIELDS.filter((f) => STAFF_EDITABLE_FIELDS.includes(f))).toEqual(['medicationHealthNotes']);
    expect(STAFF_ONLY_KIN_FIELDS.filter((f) => FLAT_MIRROR_FIELDS.includes(f))).toEqual([]);
    expect(STAFF_ONLY_KIN_FIELDS.filter((f) => PARENT_OWNED_FIELDS.includes(f))).toEqual([]);
  });
  it('a staff-only edit on the flat doc writes nothing to the family doc', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const before = { familyKinPath: FAMILY_PATH, officeNotes: 'old note', reactive: false };
    const after = { familyKinPath: FAMILY_PATH, ...STAFF_VALUES };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res).toEqual({ action: 'skipped', reason: 'no-change' });
    expect(ctx.writes.filter((w) => w.path === FAMILY_PATH)).toEqual([]);
  });
  it('a shared-field edit carries that field and none of the staff-only values beside it', async () => {
    const ctx = buildDbMock({ docs: { ...EXISTING } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const before = { familyKinPath: FAMILY_PATH, ...STAFF_VALUES, sex: 'Female' };
    const after = { familyKinPath: FAMILY_PATH, ...STAFF_VALUES, sex: 'Male', officeNotes: 'new note' };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('mirrored');
    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    expect(fam.data.sex).toBe('Male');
    for (const f of STAFF_ONLY_KIN_FIELDS) expect(fam.data).not.toHaveProperty(f);
  });
});
