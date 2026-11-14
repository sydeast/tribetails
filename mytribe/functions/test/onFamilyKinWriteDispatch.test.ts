import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

// WARNING-27: `onFamilyKinWrite` used to fire `pets.updated` to the kinfolk on
// EVERY write — including the echo of a STAFF edit on the flat doc (vetInfo
// etc. flow flat -> family carrying `_mirrorOrigin = flat`) and writes that
// changed nothing the parent can see. These tests prove the dispatch is now
// suppressed for (a) flat-origin echoes and (b) no-visible-change writes, while
// a real parent-visible change still notifies.

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue([]),
  resolveUid: vi.fn().mockResolvedValue('recipient-uid'),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { MIRROR_ORIGIN_FLAT } from '../src/triggers/kinMirror';

const KINFOLK = 'kf1';
const KIN_ID = 'pet1';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockClear();
  mocks.resolveUid.mockClear().mockResolvedValue('recipient-uid');
});

function makeEvent(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  return {
    params: { kinfolkId: KINFOLK, kinId: KIN_ID },
    data: { before: { data: () => before }, after: { data: () => after } },
  };
}

/** A flat doc already linked so the mirror step is a no-op update/skip. */
function dbMock() {
  const ctx = buildDbMock({ docs: { 'kin/flat1': { kinfolkId: KINFOLK } }, queryDocs: { kin: [] } });
  return ctx;
}

describe('WARNING-27: onFamilyKinWrite pets.updated suppression', () => {
  it('does NOT dispatch pets.updated for a flat-origin echo (staff vetInfo edit)', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');

    const before = {
      name: 'Rex',
      legacyKinId: 'flat1',
      familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
      status: 'active',
    };
    // Staff edited vetInfo on the flat doc; the echo carries _mirrorOrigin=flat
    // and changes no parent-owned field.
    const after = {
      ...before,
      vetInfo: 'Riverside Animal Hospital',
      _mirrorOrigin: MIRROR_ORIGIN_FLAT,
      _mirrorWriteId: 'w-new',
    };
    await (onFamilyKinWrite as any).run(makeEvent(before, after));

    expect(
      mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pets.updated'),
    ).toBe(false);
  });

  it('does NOT dispatch pets.updated when no parent-visible field changed', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');

    const before = {
      name: 'Rex',
      legacyKinId: 'flat1',
      familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
      status: 'active',
    };
    // A field the mirror does not carry changed (no _mirrorOrigin), the office sees nothing new.
    const after = { ...before, updatedByUid: 'u-other' };
    await (onFamilyKinWrite as any).run(makeEvent(before, after));

    expect(
      mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pets.updated'),
    ).toBe(false);
  });

  it('STILL dispatches pets.updated for a real parent-visible change', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');

    const before = {
      name: 'Rex',
      legacyKinId: 'flat1',
      familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
      status: 'active',
    };
    const after = { ...before, name: 'Rexy' }; // parent-owned field changed
    await (onFamilyKinWrite as any).run(makeEvent(before, after));

    expect(
      mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pets.updated'),
    ).toBe(true);
  });

  it('STILL dispatches pets.updated for a household edit on a doc a reverse mirror wrote earlier', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    // The flag and write id are left over from an earlier staff edit; this
    // write leaves them as they were, so it is the household's own change.
    const before = {
      name: 'Rex',
      legacyKinId: 'flat1',
      familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
      status: 'active',
      _mirrorOrigin: MIRROR_ORIGIN_FLAT,
      _mirrorWriteId: 'w-old',
    };
    const after = { ...before, allergies: 'Chicken' };
    await (onFamilyKinWrite as any).run(makeEvent(before, after));
    expect(mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pets.updated')).toBe(true);
  });
  it('still dispatches pet.marked.inactive on inactive transition (unaffected by the guard)', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');

    const before = {
      name: 'Rex',
      legacyKinId: 'flat1',
      familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
      status: 'active',
    };
    const after = { ...before, status: 'noLongerWithUs' };
    await (onFamilyKinWrite as any).run(makeEvent(before, after));

    expect(
      mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pet.marked.inactive'),
    ).toBe(true);
    expect(
      mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pets.updated'),
    ).toBe(false);
  });
});

describe('#1408: the office archiving a Kin at the household request', () => {
  const base = {
    name: 'Rex',
    legacyKinId: 'flat1',
    familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
    status: 'active',
  };

  it('keeps the admin spelling `archived` on the flat mirror instead of downgrading it to inactive', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    await (onFamilyKinWrite as any).run(makeEvent(base, { ...base, status: 'archived', removalRequestId: 'kf1_pet1' }));
    const flat = ctx.writes.find((w) => w.path === 'kin/flat1');
    expect(flat?.data).toMatchObject({ status: 'archived' });
  });

  it('sends the office no pet.marked.inactive about its own archive', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    await (onFamilyKinWrite as any).run(makeEvent(base, { ...base, status: 'archived', removalRequestId: 'kf1_pet1' }));
    expect(mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pet.marked.inactive')).toBe(false);
  });

  it('a memorial (no removal stamp) still writes inactive on the mirror and still notifies', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    await (onFamilyKinWrite as any).run(makeEvent(base, { ...base, status: 'noLongerWithUs' }));
    expect(ctx.writes.find((w) => w.path === 'kin/flat1')?.data).toMatchObject({ status: 'inactive' });
    expect(mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pet.marked.inactive')).toBe(true);
  });

  it('isRemovalArchiveWrite is true only on the write that adds the stamp', async () => {
    const { isRemovalArchiveWrite } = await import('../src/triggers/onFamilyKinWrite');
    expect(isRemovalArchiveWrite({ status: 'active' }, { status: 'archived', removalRequestId: 'r1' })).toBe(true);
    expect(isRemovalArchiveWrite({ removalRequestId: 'r1' }, { removalRequestId: 'r1' })).toBe(false);
    expect(isRemovalArchiveWrite(undefined, { status: 'archived' })).toBe(false);
  });
});
