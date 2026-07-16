import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

// WARNING-27: `onFamilyKinWrite` used to fire `pets.updated` to the kinfolk on
// EVERY write — including the echo of a STAFF edit on the flat doc (officeNotes
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
  const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
  return ctx;
}

describe('WARNING-27: onFamilyKinWrite pets.updated suppression', () => {
  it('does NOT dispatch pets.updated for a flat-origin echo (staff officeNotes edit)', async () => {
    const ctx = dbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');

    const before = {
      name: 'Rex',
      legacyKinId: 'flat1',
      familyKinPath: `families/${KINFOLK}/kin/${KIN_ID}`,
      status: 'active',
    };
    // Staff edited officeNotes on the flat doc; the echo carries _mirrorOrigin=flat
    // and changes no parent-owned field.
    const after = {
      ...before,
      officeNotes: 'gate code 1234',
      _mirrorOrigin: MIRROR_ORIGIN_FLAT,
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
    // A non-parent-owned field changed (no _mirrorOrigin), parent sees nothing new.
    const after = { ...before, weight: '20kg' };
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
