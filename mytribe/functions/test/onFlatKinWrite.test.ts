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

    const before = { familyKinPath: FAMILY_PATH, routine: 'old', vetInfo: 'Dr A' };
    const after = {
      familyKinPath: FAMILY_PATH,
      legacyKinId: 'flat1',
      routine: 'morning walk, evening play',
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
    expect(fam!.data.routine).toBe('morning walk, evening play');
    expect(fam!.data.vetInfo).toBe('Dr A');
    expect(fam!.data._mirrorOrigin).toBe(MIRROR_ORIGIN_FLAT);
    // Parent-owned fields are excluded; never clobber what the parent typed.
    expect(fam!.data).not.toHaveProperty('name');
    expect(fam!.data).not.toHaveProperty('photoUrl');
  });

  it('SKIPS when the write originated from the family -> flat mirror (echo guard 1)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { familyKinPath: FAMILY_PATH, routine: 'old' };
    const after = {
      familyKinPath: FAMILY_PATH,
      routine: 'changed-by-family-mirror',
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
    const before = { familyKinPath: FAMILY_PATH, routine: 'same', vetInfo: 'Dr A' };
    const after = {
      familyKinPath: FAMILY_PATH,
      routine: 'same',
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
      { routine: 'old' } as any,
      { routine: 'new', name: 'OnlyInAuntie' } as any,
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
      { familyKinPath: FAMILY_PATH, routine: 'old' } as any,
      { familyKinPath: FAMILY_PATH, routine: 'new' } as any,
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
      { familyKinPath: FAMILY_PATH, routine: 'old' } as any,
      { familyKinPath: FAMILY_PATH, routine: 'new' } as any,
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
      { familyKinPath: FAMILY_PATH, routine: 'old' } as any,
      { familyKinPath: FAMILY_PATH, routine: 'new', status: 'active' } as any,
    );
    expect(res.action).toBe('mirrored');

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH);
    expect(fam!.data).not.toHaveProperty('status');
    expect(fam!.data.routine).toBe('new');
  });

  it('leaves an existing active status alone rather than rewriting it', async () => {
    const ctx = buildDbMock({ docs: { [FAMILY_PATH]: { name: 'Rex', status: 'active' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await mirrorFlatKinToFamily(
      { familyKinPath: FAMILY_PATH, routine: 'old' } as any,
      { familyKinPath: FAMILY_PATH, routine: 'new' } as any,
    );
    expect(ctx.writes.find((w) => w.path === FAMILY_PATH)!.data).not.toHaveProperty('status');
  });
});

describe('kinMirror field-ownership contract', () => {
  it('declares status parent-owned, so no reverse mirror can ever carry it', () => {
    expect(PARENT_OWNED_FIELDS).toContain('status');
    expect(STAFF_EDITABLE_FIELDS).not.toContain('status');
  });

  it('keeps the two ownership lists disjoint', () => {
    const overlap = PARENT_OWNED_FIELDS.filter((f) => STAFF_EDITABLE_FIELDS.includes(f));
    expect(overlap).toEqual([]);
  });

  it('drops every parent-owned key from a payload that somehow contains one', () => {
    const stripped = omitKeys(
      { routine: 'new', status: 'active', name: 'STAFF_VALUE' },
      PARENT_OWNED_FIELDS,
    );
    expect(stripped).toEqual({ routine: 'new' });
  });

  it('writes no parent-owned field into the family doc, whatever the flat doc carries', async () => {
    const ctx = buildDbMock({ docs: { [FAMILY_PATH]: { status: 'noLongerWithUs' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    // A flat doc carrying every parent-owned field plus one real staff change.
    const after: Record<string, unknown> = { familyKinPath: FAMILY_PATH, routine: 'new' };
    for (const f of PARENT_OWNED_FIELDS) after[f] = 'STAFF_VALUE';

    await mirrorFlatKinToFamily({ familyKinPath: FAMILY_PATH, routine: 'old' } as any, after as any);

    const fam = ctx.writes.find((w) => w.path === FAMILY_PATH)!;
    for (const f of PARENT_OWNED_FIELDS) expect(fam.data).not.toHaveProperty(f);
  });
});
