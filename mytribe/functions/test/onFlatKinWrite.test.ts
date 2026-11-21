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
    const after = { familyKinPath: FAMILY_PATH, kinfolkId: 'kf1', name: 'Rex', species: 'Dog', age: '4', weight: 'new' };
    const ctx = buildDbMock({ docs: { 'kin/flat1': { ...after } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily({ familyKinPath: FAMILY_PATH, weight: 'old' } as any, after as any, 'flat1');
    expect(res).toEqual({ action: 'adopted', familyKinPath: FAMILY_PATH });

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    expect(fam.merge).toBe(false);
    expect(fam.data).toMatchObject({ name: 'Rex', species: 'Dog', ageYears: 4, weight: 'new', status: 'active', legacyKinId: 'flat1' });
  });

  it('admin Android stamping the link after its add makes the copy, even with no shared field changed', async () => {
    const after = { kinfolkId: 'kf1', name: 'Rex', familyKinPath: FAMILY_PATH };
    const ctx = buildDbMock({ docs: { 'kin/pet1': { ...after } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await mirrorFlatKinToFamily({ kinfolkId: 'kf1', name: 'Rex' } as any, after as any, 'pet1');
    expect(res.action).toBe('adopted');
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data.name).toBe('Rex');
    // The household has no Kin of that name, so exactly one copy is made.
    expect(ctx.writes.filter((w) => w.path.startsWith('families/kf1/kin/'))).toHaveLength(1);
  });

  it('a link with no record id to look with still makes the copy at the link', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old' } as any,
      { familyKinPath: FAMILY_PATH, kinfolkId: 'kf1', name: 'Rex', weight: 'new' } as any,
    );
    expect(res.action).toBe('adopted');
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data).toMatchObject({ name: 'Rex', weight: 'new', status: 'active' });
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

/**
 * #2290: an office-made Kin with the same name as a household Kin that has no
 * record yet made a second household copy on admin Android. That app added the
 * Kin and then wrote `families/{kinfolkId}/kin/{its own id}` onto it as the
 * link. The name match only ran for a Kin with no link, so a link to a copy
 * that was not there got a new copy at that path, beside the household's own.
 * A phone still running that build does the same two writes, so the server
 * has to answer them.
 */
describe('#2290: a link to a household copy that is not there finds the Kin the household already has', () => {
  const FLAT = { kinfolkId: 'kf1', name: 'Biscuit', species: 'Dog', status: 'active' };
  const OWN_PATH = 'families/kf1/kin/flat1';
  const TWIN_PATH = 'families/kf1/kin/k2';
  const copiesNamed = (docs: Record<string, Record<string, unknown> | null>, name: string) =>
    Object.keys(docs).filter((p) => p.startsWith('families/kf1/kin/') && docs[p]?.['name'] === name);

  it('the link was written before the name match ran: it ties to the household Kin, no second copy', async () => {
    const after = { ...FLAT, familyKinPath: OWN_PATH };
    const ctx = buildDbMock({
      docs: { 'kin/flat1': { ...after }, [TWIN_PATH]: { name: 'Biscuit', status: 'active' } },
      queryDocs: { 'families/kf1/kin': [{ id: 'k2', data: { name: 'Biscuit', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily({ ...FLAT, familyKinPath: '' } as any, after as any, 'flat1');
    expect(res).toEqual({ action: 'linked', familyKinPath: TWIN_PATH });
    expect(ctx.writes.find((w) => w.path === OWN_PATH)).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === TWIN_PATH)!.data).toMatchObject({ legacyKinId: 'flat1', familyKinPath: TWIN_PATH, _mirrorOrigin: MIRROR_ORIGIN_FLAT });
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')!.data).toMatchObject({ familyKinPath: TWIN_PATH, legacyKinId: 'flat1', _mirrorOrigin: MIRROR_ORIGIN_FAMILY });
  });

  it('the link was written after the name match tied the two: the link is put back, no second copy', async () => {
    const before = { ...FLAT, familyKinPath: TWIN_PATH, legacyKinId: 'flat1', _mirrorOrigin: MIRROR_ORIGIN_FAMILY, _mirrorWriteId: 'w1' };
    const after = { ...before, familyKinPath: OWN_PATH };
    const twin = { name: 'Biscuit', status: 'active', legacyKinId: 'flat1', familyKinPath: TWIN_PATH };
    const ctx = buildDbMock({
      docs: { 'kin/flat1': { ...after }, [TWIN_PATH]: twin },
      queryDocs: { 'families/kf1/kin': [{ id: 'k2', data: twin }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(before as any, after as any, 'flat1');
    expect(res).toEqual({ action: 'linked', familyKinPath: TWIN_PATH });
    expect(ctx.writes.find((w) => w.path === OWN_PATH)).toBeUndefined();
    // The household copy was already stamped: nothing to write on it.
    expect(ctx.writes.find((w) => w.path === TWIN_PATH)).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')!.data.familyKinPath).toBe(TWIN_PATH);
  });

  /**
   * The two writes of that build, and the trigger run each one fires, played
   * against a store that keeps what is written. Whichever write the server
   * sees first, the household ends with ONE Biscuit.
   */
  for (const order of ['add, name match, then the link', 'add, the link, then both trigger runs'] as const) {
    it(`both writes of the old Android add, in the order "${order}", leave the household one Biscuit`, async () => {
      const docs: Record<string, Record<string, unknown> | null> = {
        'kin/flat1': { ...FLAT, familyKinPath: '' },
        [TWIN_PATH]: { name: 'Biscuit', status: 'active', createdByUid: 'u1' },
      };
      const ctx = buildDbMock({ docs, writeThrough: true });
      mocks.dbFn.mockReturnValue(ctx.db);
      const added = { ...FLAT, familyKinPath: '' };
      const stampLink = () => {
        const beforeStamp = { ...docs['kin/flat1']! };
        docs['kin/flat1'] = { ...beforeStamp, kinfolkId: 'kf1', familyKinPath: OWN_PATH };
        return { beforeStamp, afterStamp: { ...docs['kin/flat1']! } };
      };

      if (order === 'add, name match, then the link') {
        await mirrorFlatKinToFamily(undefined, added as any, 'flat1');
        const { beforeStamp, afterStamp } = stampLink();
        await mirrorFlatKinToFamily(beforeStamp as any, afterStamp as any, 'flat1');
      } else {
        const { beforeStamp, afterStamp } = stampLink();
        await mirrorFlatKinToFamily(undefined, added as any, 'flat1');
        await mirrorFlatKinToFamily(beforeStamp as any, afterStamp as any, 'flat1');
      }

      expect(copiesNamed(docs, 'Biscuit')).toEqual([TWIN_PATH]);
      expect(docs[OWN_PATH] ?? null).toBeNull();
      expect(docs[TWIN_PATH]).toMatchObject({ legacyKinId: 'flat1', createdByUid: 'u1' });
      expect(docs['kin/flat1']).toMatchObject({ familyKinPath: TWIN_PATH, legacyKinId: 'flat1' });
    });
  }

  it('an edit on a record whose link went bad reaches the copy stamped with it (#2115 leftovers)', async () => {
    const before = { ...FLAT, familyKinPath: OWN_PATH, weight: '40 lbs' };
    const after = { ...before, weight: '45 lbs' };
    const stampedCopy = { name: 'Biscuit', status: 'active', legacyKinId: 'flat1', weight: '40 lbs' };
    const ctx = buildDbMock({
      docs: { 'kin/flat1': { ...after }, 'families/kf1/kin/portal7': stampedCopy },
      queryDocs: { 'families/kf1/kin': [{ id: 'portal7', data: stampedCopy }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(before as any, after as any, 'flat1');
    expect(res).toEqual({ action: 'linked', familyKinPath: 'families/kf1/kin/portal7' });
    expect(ctx.writes.find((w) => w.path === OWN_PATH)).toBeUndefined();
    const fam = ctx.writes.find((w) => w.path === 'families/kf1/kin/portal7')!;
    expect(fam.merge).toBe(true);
    expect(fam.data).toMatchObject({ weight: '45 lbs', _mirrorOrigin: MIRROR_ORIGIN_FLAT });
    expect(fam.data).not.toHaveProperty('name');
    expect(fam.data).not.toHaveProperty('status');
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')!.data.familyKinPath).toBe('families/kf1/kin/portal7');
  });

  it('a new record that arrives with the bad link does not write its first draft over the household Kin', async () => {
    const after = { ...FLAT, familyKinPath: OWN_PATH, weight: '', allergies: '' };
    const ctx = buildDbMock({
      docs: { 'kin/flat1': { ...after }, [TWIN_PATH]: { name: 'Biscuit', status: 'active', weight: '40 lbs', allergies: 'Chicken' } },
      queryDocs: { 'families/kf1/kin': [{ id: 'k2', data: { name: 'Biscuit', status: 'active', weight: '40 lbs', allergies: 'Chicken' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(undefined, after as any, 'flat1');
    expect(res.action).toBe('linked');
    const fam = ctx.writes.find((w) => w.path === TWIN_PATH)!;
    expect(fam.data).not.toHaveProperty('weight');
    expect(fam.data).not.toHaveProperty('allergies');
  });

  it('a household Kin of that name that is archived, or already another record\'s, is not taken: the copy is made', async () => {
    for (const twin of [
      { name: 'Biscuit', status: 'noLongerWithUs' },
      { name: 'Biscuit', status: 'active', legacyKinId: 'flat-other' },
    ]) {
      const after = { ...FLAT, familyKinPath: OWN_PATH };
      const ctx = buildDbMock({
        docs: { 'kin/flat1': { ...after }, [TWIN_PATH]: twin },
        queryDocs: { 'families/kf1/kin': [{ id: 'k2', data: twin }] },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const res = await mirrorFlatKinToFamily({ ...FLAT, familyKinPath: '' } as any, after as any, 'flat1');
      expect(res).toEqual({ action: 'adopted', familyKinPath: OWN_PATH });
      expect(ctx.writes.find((w) => w.path === TWIN_PATH)).toBeUndefined();
      expect(ctx.writes.find((w) => w.path === OWN_PATH)!.data).toMatchObject({ name: 'Biscuit', legacyKinId: 'flat1' });
    }
  });

  it('another record took the same-name Kin between the lookup and the claim: this one gets its own copy', async () => {
    const after = { ...FLAT, familyKinPath: '' };
    const docs: Record<string, Record<string, unknown> | null> = {
      'kin/flat1': { ...after },
      [TWIN_PATH]: { name: 'Biscuit', status: 'active' },
    };
    const ctx = buildDbMock({ docs, writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const real = ctx.db.runTransaction;
    ctx.db.runTransaction = vi.fn(async (fn: any) => {
      // A second office record of the same name claims the household Kin first.
      docs[TWIN_PATH] = { ...docs[TWIN_PATH]!, legacyKinId: 'flat-other' };
      return real(fn);
    });

    const res = await adoptFlatKin('flat1', after as any);
    expect(res).toEqual({ action: 'adopted', familyKinPath: OWN_PATH });
    expect(docs[TWIN_PATH]).toMatchObject({ legacyKinId: 'flat-other' });
    expect(docs[OWN_PATH]).toMatchObject({ name: 'Biscuit', legacyKinId: 'flat1' });
    expect(docs['kin/flat1']).toMatchObject({ familyKinPath: OWN_PATH });
  });

  it('a record archived, or removed, before the claim gets no copy', async () => {
    const after = { ...FLAT, familyKinPath: OWN_PATH };
    const ctx = buildDbMock({ docs: { 'kin/flat1': { ...after, status: 'archived' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await mirrorFlatKinToFamily({ ...FLAT, familyKinPath: '' } as any, after as any, 'flat1')).toEqual({ action: 'skipped', reason: 'inactive' });
    expect(ctx.writes).toHaveLength(0);

    const gone = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(gone.db);
    expect(await mirrorFlatKinToFamily({ ...FLAT, familyKinPath: '' } as any, after as any, 'flat1')).toEqual({ action: 'skipped', reason: 'gone' });
    expect(gone.writes).toHaveLength(0);
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
