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
import { MIRROR_ORIGIN_FAMILY, MIRROR_ORIGIN_FLAT } from '../src/triggers/kinMirror';

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
