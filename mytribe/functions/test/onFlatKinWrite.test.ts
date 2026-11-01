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

import { mirrorFlatKinToFamily, onFlatKinWrite } from '../src/triggers/onFlatKinWrite';
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

describe('onFlatKinWrite: exports', () => {
  it('exports the trigger', () => {
    expect(onFlatKinWrite).toBeDefined();
  });
});

describe('mirrorFlatKinToFamily: REVERSE mirror of staff-editable fields', () => {
  it('mirrors changed staff fields into the family doc, stamps flat origin, excludes parent fields', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { familyKinPath: FAMILY_PATH, weight: 'old', vetInfo: 'Dr A' };
    const after = {
      familyKinPath: FAMILY_PATH,
      legacyKinId: 'flat1',
      weight: '52 lbs',
      vetInfo: 'Dr A',
      // parent-owned fields present on the flat doc must NOT be mirrored back:
      name: 'StaleStaffName',
      photoUrl: 'https://staff/clobber.jpg',
    };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('mirrored');

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH);
    expect(fam).toBeTruthy();
    expect(fam!.merge).toBe(true);
    expect(fam!.data.weight).toBe('52 lbs');
    expect(fam!.data.vetInfo).toBe('Dr A');
    expect(fam!.data._mirrorOrigin).toBe(MIRROR_ORIGIN_FLAT);
    // Parent-owned fields are excluded; never clobber what the parent typed.
    expect(fam!.data).not.toHaveProperty('name');
    expect(fam!.data).not.toHaveProperty('photoUrl');
  });

  it('SKIPS when the write originated from the family -> flat mirror (echo guard 1)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { familyKinPath: FAMILY_PATH, weight: 'old' };
    const after = {
      familyKinPath: FAMILY_PATH,
      weight: 'changed-by-family-mirror',
      _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
    };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('family-origin');
    expect(ctx.writes.filter((w) => w.path === FAMILY_PATH)).toHaveLength(0);
  });

  it('SKIPS when no staff-editable field changed (echo guard 2, our own write bouncing back)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    // Our reverse write flips _mirrorOrigin to flat but leaves staff fields equal.
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

  it('SKIPS when the flat doc has no familyKinPath link (AuntieOS-only pet)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(
      { weight: 'old' } as any,
      { weight: 'new', name: 'OnlyInAuntie' } as any,
    );
    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('no-link');
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * P0-9. This merge write CREATES the family kin doc when staff linked a flat pet
 * to a family path the portal has not written yet. It used to create it with no
 * `status`, and a statusless doc fell out of the portal's Kin list entirely.
 */
describe('mirrorFlatKinToFamily: status seed', () => {
  it('seeds status active when the family doc does not exist yet', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, weight: 'old' } as any,
      { familyKinPath: FAMILY_PATH, weight: 'new' } as any,
    );
    expect(res.action).toBe('mirrored');

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH);
    expect(fam!.data.status).toBe('active');
    expect(fam!.merge).toBe(true);
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

describe('kinMirror field-ownership contract', () => {
  it('declares status parent-owned, so no reverse mirror can ever carry it', () => {
    expect(PARENT_OWNED_FIELDS).toContain('status');
    expect(STAFF_EDITABLE_FIELDS).not.toContain('status');
  });

  it('household-shared fields travel both ways and are owned by neither side exclusively (#1310)', () => {
    for (const f of HOUSEHOLD_SHARED_FIELDS) {
      expect(STAFF_EDITABLE_FIELDS).toContain(f);
      expect(FLAT_MIRROR_FIELDS).toContain(f);
      expect(PARENT_OWNED_FIELDS).not.toContain(f);
    }
    expect([...HOUSEHOLD_SHARED_FIELDS].sort()).toEqual(['colorMarkings', 'sex', 'spayedNeutered', 'vetInfo', 'weight']);
  });
  it('keeps the two ownership lists disjoint', () => {
    const overlap = PARENT_OWNED_FIELDS.filter((f) => STAFF_EDITABLE_FIELDS.includes(f));
    expect(overlap).toEqual([]);
  });

  it('drops every parent-owned key from a payload that somehow contains one', () => {
    const stripped = omitKeys(
      { weight: 'new', status: 'active', name: 'STAFF_VALUE' },
      PARENT_OWNED_FIELDS,
    );
    expect(stripped).toEqual({ weight: 'new' });
  });

  it('writes no parent-owned field into the family doc, whatever the flat doc carries', async () => {
    const ctx = buildDbMock({ docs: { [FAMILY_PATH]: { status: 'noLongerWithUs' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    // A flat doc carrying every parent-owned field plus one real staff change.
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
 * never writes one there.
 */
describe('mirrorFlatKinToFamily: staff-only fields never reach the family doc (#1335)', () => {
  const STAFF_VALUES: Record<string, unknown> = {
    officeNotes: 'bit the last sitter, muzzle on walks',
    reactive: true,
    routine: 'morning walk',
    trainingCommands: 'sit, stay',
    feedingBrand: 'Orijen',
    vaccinations: 'Rabies 2027',
    medicationHealthNotes: 'thyroid pill at 7am',
    tags: ['Reactive', 'VIP'],
  };
  it('names exactly the staff-only fields, and none of them is mirrored', () => {
    expect([...STAFF_ONLY_KIN_FIELDS].sort()).toEqual(
      [
        'feedingBrand',
        'medicationHealthNotes',
        'officeNotes',
        'reactive',
        'routine',
        'tags',
        'trainingCommands',
        'vaccinations',
      ],
    );
    expect(STAFF_ONLY_KIN_FIELDS.filter((f) => STAFF_EDITABLE_FIELDS.includes(f))).toEqual([]);
    expect([...STAFF_EDITABLE_FIELDS].sort()).toEqual(
      ['colorMarkings', 'sex', 'spayedNeutered', 'vetInfo', 'weight'],
    );
    // Flat -> family carries exactly the household-shared facts (#1310), and no
    // staff-only field travels family -> flat either.
    expect([...STAFF_EDITABLE_FIELDS].sort()).toEqual([...HOUSEHOLD_SHARED_FIELDS].sort());
    expect(STAFF_ONLY_KIN_FIELDS.filter((f) => FLAT_MIRROR_FIELDS.includes(f))).toEqual([]);
    expect(STAFF_ONLY_KIN_FIELDS.filter((f) => PARENT_OWNED_FIELDS.includes(f))).toEqual([]);
  });
  it('a staff-only edit on the flat doc writes nothing to the family doc', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const before = { familyKinPath: FAMILY_PATH, officeNotes: 'old note', routine: 'old' };
    const after = { familyKinPath: FAMILY_PATH, ...STAFF_VALUES };
    const res = await mirrorFlatKinToFamily(before as any, after as any);
    expect(res).toEqual({ action: 'skipped', reason: 'no-change' });
    expect(ctx.writes.filter((w) => w.path === FAMILY_PATH)).toEqual([]);
  });
  it('a shared-field edit carries that field and none of the staff-only values beside it', async () => {
    const ctx = buildDbMock({ docs: {} });
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

