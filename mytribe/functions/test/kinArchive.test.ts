import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

// #1492: the admin's Kin Archive / Restore writes BOTH copies of the Kin, the
// flat `kin/{id}` doc every admin screen reads and the household's
// `families/{kinfolkId}/kin/{kinId}` copy the portal roster reads, in one
// transaction. Before, it was a client write of the flat status only, which
// never reached the household (status does not travel flat to family).

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveUid.mockReset().mockResolvedValue('household-uid');
});

const FAMILY_PATH = 'families/3/kin/k1';
const FAMILY_KIN = { name: 'Buddy', status: 'active', legacyKinId: 'flat1', familyKinPath: FAMILY_PATH };
const FLAT_KIN = { name: 'Buddy', kinfolkId: '3', familyKinPath: FAMILY_PATH, legacyKinId: 'flat1', status: 'active' };

function office(docs: Record<string, Record<string, unknown> | null> = {}) {
  return buildDbMock({
    writeThrough: true,
    docs: { [FAMILY_PATH]: FAMILY_KIN, 'kin/flat1': FLAT_KIN, ...docs },
  });
}

function call(data: Record<string, unknown>, uid = 'owner') {
  return { data, auth: { uid } } as any;
}

const familyWrite = (ctx: ReturnType<typeof office>) => ctx.writes.find((w) => w.path === FAMILY_PATH)?.data;
/** Writes to either copy of a Kin (the gate's own denial audit entry is not one). */
const kinWrites = (ctx: ReturnType<typeof office>) => ctx.writes.filter((w) => w.path === FAMILY_PATH || w.path.startsWith('kin/'));
const flatWrite = (ctx: ReturnType<typeof office>) => ctx.writes.find((w) => w.path === 'kin/flat1')?.data;

describe('setKinArchived (#1492)', () => {
  it('rejects unauth', async () => {
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await expect(setKinArchivedHandler({ data: { kinId: 'flat1', archived: true } } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('the gate refuses an Auntie: archiving is owner-only (auntie access rule 6)', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchived } = await import('../src/admin/kinArchive');
    await expect(
      (setKinArchived as any).run({ data: { kinId: 'flat1', archived: true }, auth: { uid: 'auntie1', token: { staffRole: 'auntie' } } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinWrites(ctx)).toEqual([]);
  });

  it('the gate refuses a household', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchived } = await import('../src/admin/kinArchive');
    await expect(
      (setKinArchived as any).run({ data: { kinId: 'flat1', archived: true }, auth: { uid: 'u1', token: { role: 'kinfolk' } } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(kinWrites(ctx)).toEqual([]);
  });

  it('refuses a missing Kin and writes nothing', async () => {
    const ctx = office({ 'kin/flat1': null });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await expect(setKinArchivedHandler(call({ kinId: 'flat1', archived: true }))).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.writes).toEqual([]);
  });

  it('archive writes archived on the flat doc AND the household copy, stamped as the office', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));

    expect(flatWrite(ctx)).toMatchObject({ status: 'archived', updatedAt: '__TS__' });
    const family = familyWrite(ctx);
    expect(family).toMatchObject({ status: 'archived', updatedByUid: 'owner' });
    expect(typeof family?.['officeStatusWriteId']).toBe('string');
    // An active Kin has nothing to remember.
    expect(family).not.toHaveProperty('statusBeforeArchive');
    expect(ctx.deletes).toEqual([]);
    expect(res).toEqual({ ok: true, archived: true, flatStatus: 'archived', familyStatus: 'archived', familyUpdated: true });
  });

  it('archiving a memorial Kin remembers the memorial', async () => {
    const ctx = office({ [FAMILY_PATH]: { ...FAMILY_KIN, status: 'noLongerWithUs' }, 'kin/flat1': { ...FLAT_KIN, status: 'inactive' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));
    expect(familyWrite(ctx)).toMatchObject({ status: 'archived', statusBeforeArchive: 'noLongerWithUs' });
  });

  it('restore of a Kin archived through a removal request brings the household copy back to active', async () => {
    const ctx = office({
      [FAMILY_PATH]: { ...FAMILY_KIN, status: 'archived', removalRequestId: '3_k1' },
      'kin/flat1': { ...FLAT_KIN, status: 'archived' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: false }));

    expect(flatWrite(ctx)).toMatchObject({ status: 'active' });
    const family = familyWrite(ctx);
    expect(family).toMatchObject({
      status: 'active',
      // Cleared: the request id is deterministic, so a stale stamp would make
      // a later removal-request archive of this Kin look like a household write.
      removalRequestId: '__DELETE__',
      statusBeforeArchive: '__DELETE__',
      updatedByUid: 'owner',
    });
    expect(typeof family?.['officeStatusWriteId']).toBe('string');
    expect(res).toEqual({ ok: true, archived: false, flatStatus: 'active', familyStatus: 'active', familyUpdated: true });
  });

  it('restore of a plain admin archive brings the household copy back to active', async () => {
    const ctx = office({
      [FAMILY_PATH]: { ...FAMILY_KIN, status: 'archived' },
      'kin/flat1': { ...FLAT_KIN, status: 'archived' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await setKinArchivedHandler(call({ kinId: 'flat1', archived: false }));
    expect(familyWrite(ctx)).toMatchObject({ status: 'active' });
    expect(flatWrite(ctx)).toMatchObject({ status: 'active' });
  });

  it('restore puts a remembered memorial back, never active over it', async () => {
    const ctx = office({
      [FAMILY_PATH]: { ...FAMILY_KIN, status: 'archived', statusBeforeArchive: 'noLongerWithUs' },
      'kin/flat1': { ...FLAT_KIN, status: 'archived' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: false }));
    expect(familyWrite(ctx)).toMatchObject({ status: 'noLongerWithUs' });
    // The flat spelling for a memorial, the one onFamilyKinWrite writes.
    expect(flatWrite(ctx)).toMatchObject({ status: 'inactive' });
    expect(res).toMatchObject({ familyStatus: 'noLongerWithUs', flatStatus: 'inactive' });
  });

  it('restore never overwrites a status the household set (legacy flat-only archive)', async () => {
    // Archived on the flat doc alone before #1492; the household marked the
    // Kin no longer with us since. The household copy is theirs.
    const ctx = office({
      [FAMILY_PATH]: { ...FAMILY_KIN, status: 'noLongerWithUs' },
      'kin/flat1': { ...FLAT_KIN, status: 'archived' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: false }));
    expect(familyWrite(ctx)).toBeUndefined();
    expect(flatWrite(ctx)).toMatchObject({ status: 'inactive' });
    expect(res).toMatchObject({ familyStatus: 'noLongerWithUs', familyUpdated: false });
  });

  it('restore of a legacy flat-only archive leaves an active household copy alone', async () => {
    const ctx = office({ 'kin/flat1': { ...FLAT_KIN, status: 'archived' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: false }));
    expect(familyWrite(ctx)).toBeUndefined();
    expect(flatWrite(ctx)).toMatchObject({ status: 'active' });
    expect(res).toMatchObject({ familyStatus: 'active', familyUpdated: false });
  });

  it('an admin-only Kin (no household copy) is archived on the flat doc alone', async () => {
    const { familyKinPath: _p, ...flatOnly } = FLAT_KIN;
    const ctx = office({ 'kin/flat1': flatOnly, [FAMILY_PATH]: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));
    expect(flatWrite(ctx)).toMatchObject({ status: 'archived' });
    expect(ctx.writes.map((w) => w.path)).toEqual(['kin/flat1']);
    expect(res).toEqual({ ok: true, archived: true, flatStatus: 'archived', familyStatus: null, familyUpdated: false });
  });

  it('a link to a household copy that does not exist is not created', async () => {
    const ctx = office({ [FAMILY_PATH]: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));
    expect(ctx.writes.map((w) => w.path)).toEqual(['kin/flat1']);
  });

  it('a household copy linked to a different flat doc is not this Kin and is left alone', async () => {
    const ctx = office({ [FAMILY_PATH]: { ...FAMILY_KIN, legacyKinId: 'someOtherFlat' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));
    expect(ctx.writes.map((w) => w.path)).toEqual(['kin/flat1']);
  });

  it('a link that is not a household Kin path is never written', async () => {
    const ctx = office({ 'kin/flat1': { ...FLAT_KIN, familyKinPath: 'business_settings/business_settings' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));
    expect(ctx.writes.map((w) => w.path)).toEqual(['kin/flat1']);
  });

  it('archiving an already archived household copy does not write it again', async () => {
    const ctx = office({ [FAMILY_PATH]: { ...FAMILY_KIN, status: 'archived' }, 'kin/flat1': { ...FLAT_KIN, status: 'archived' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    const res = await setKinArchivedHandler(call({ kinId: 'flat1', archived: true }));
    expect(familyWrite(ctx)).toBeUndefined();
    expect(res).toMatchObject({ familyStatus: 'archived', familyUpdated: false });
  });

  it('rejects a blank kin id', async () => {
    const { setKinArchivedHandler } = await import('../src/admin/kinArchive');
    await expect(setKinArchivedHandler(call({ kinId: '  ', archived: true }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('resolveKinRemovalRequest archive remembers a memorial too (#1492)', () => {
  it('stashes noLongerWithUs so the admin Restore can put it back', async () => {
    const ctx = office({
      [FAMILY_PATH]: { ...FAMILY_KIN, status: 'noLongerWithUs' },
      'kin_removal_requests/3_k1': { kinfolkId: '3', kinId: 'k1', flatKinId: 'flat1', kinName: 'Buddy', status: 'pending' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.doMock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
    const { resolveKinRemovalRequestHandler } = await import('../src/admin/kinRemovalRequests');
    await resolveKinRemovalRequestHandler(call({ requestId: '3_k1', decision: 'archive' }));
    expect(familyWrite(ctx)).toMatchObject({ status: 'archived', statusBeforeArchive: 'noLongerWithUs', removalRequestId: '3_k1' });
  });
});

describe('onFamilyKinWrite after an office archive or restore (#1492)', () => {
  function makeEvent(before: Record<string, unknown> | undefined, after: Record<string, unknown>) {
    return {
      id: 'evt1',
      params: { kinfolkId: '3', kinId: 'k1' },
      data: { before: { data: () => before }, after: { data: () => after } },
    };
  }

  it('an office archive keeps archived on the flat mirror (no downgrade to inactive) and sends no pet.marked.inactive', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    await (onFamilyKinWrite as any).run(
      makeEvent(FAMILY_KIN, { ...FAMILY_KIN, status: 'archived', officeStatusWriteId: 'w1' }),
    );
    expect(flatWrite(ctx)).toMatchObject({ status: 'archived' });
    expect(mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pet.marked.inactive')).toBe(false);
  });

  it('a household write that keeps an old office stamp still notifies', async () => {
    const ctx = office();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    await (onFamilyKinWrite as any).run(
      makeEvent(
        { ...FAMILY_KIN, officeStatusWriteId: 'w1' },
        { ...FAMILY_KIN, status: 'noLongerWithUs', officeStatusWriteId: 'w1' },
      ),
    );
    expect(mocks.enqueue.mock.calls.some((c) => c[0]?.key === 'pet.marked.inactive')).toBe(true);
  });

  it('an office restore sets the flat mirror active and sends the household no pets.updated', async () => {
    const ctx = office({ 'kin/flat1': { ...FLAT_KIN, status: 'archived' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { onFamilyKinWrite } = await import('../src/triggers/onFamilyKinWrite');
    await (onFamilyKinWrite as any).run(
      makeEvent(
        { ...FAMILY_KIN, status: 'archived', removalRequestId: '3_k1', officeStatusWriteId: 'w1' },
        { ...FAMILY_KIN, status: 'active', officeStatusWriteId: 'w2' },
      ),
    );
    expect(flatWrite(ctx)).toMatchObject({ status: 'active' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('isOfficeStatusWrite is true only when the stamp is new on this write', async () => {
    const { isOfficeStatusWrite } = await import('../src/triggers/onFamilyKinWrite');
    expect(isOfficeStatusWrite(undefined, { officeStatusWriteId: 'w1' })).toBe(true);
    expect(isOfficeStatusWrite({ officeStatusWriteId: 'w1' }, { officeStatusWriteId: 'w2' })).toBe(true);
    expect(isOfficeStatusWrite({ officeStatusWriteId: 'w1' }, { officeStatusWriteId: 'w1' })).toBe(false);
    expect(isOfficeStatusWrite({}, {})).toBe(false);
  });
});
