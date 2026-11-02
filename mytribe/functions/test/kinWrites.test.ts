import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

// CRITICAL-4 member-doc fixtures keyed at families/{kinfolkId}/members/{uid}.
const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
  },
};
const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };

describe('kinWrites CRITICAL-4 permission gate (kin_edit)', () => {
  for (const variant of [
    { name: 'addKinHandler', import: 'addKinHandler', data: { kinfolkId: '3', kin: { name: 'Buddy' } } },
    { name: 'updateKinHandler', import: 'updateKinHandler', data: { kinfolkId: '3', kinId: 'k1', kin: { medications: 'x' } } },
    { name: 'archiveKinHandler', import: 'archiveKinHandler', data: { kinfolkId: '3', kinId: 'k1', reason: 'noLongerWithUs' } },
  ]) {
    it(`${variant.name}: DENIES a kintales_only secondary and does not write`, async () => {
      const ctx = buildDbMock({
        docs: {
          'clients/u1': { kinfolkIds: ['3'] },
          'families/3/members/u1': KINTALES_ONLY_MEMBER,
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
        code: 'permission-denied',
      });
      // side effect did NOT run
      expect(ctx.adds.length).toBe(0);
      expect(ctx.writes.find((w) => w.path === 'families/3/kin/k1')).toBeUndefined();
    });

    it(`${variant.name}: ALLOWS a PRIMARY member`, async () => {
      const ctx = buildDbMock({
        docs: {
          'clients/u1': { kinfolkIds: ['3'] },
          'families/3/members/u1': PRIMARY_MEMBER,
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'u1' } } as any)).resolves.toBeTruthy();
    });

    it(`${variant.name}: ALLOWS legacy (no member doc)`, async () => {
      const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'u1' } } as any)).resolves.toBeTruthy();
    });

    it(`${variant.name}: ALLOWS an operator (bypass, no member doc)`, async () => {
      process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
      // The operator's OWN kinfolkIds must NOT include '3': otherwise the
      // outer clients/{uid}.kinfolkIds check passes because the caller
      // happens to be a member of that household, not because the operator
      // path works. That was this fixture's bug before the fix: kinfolkIds:
      // ['3'] made this pass for the wrong reason.
      const ctx = buildDbMock({
        docs: {
          'clients/op-uid': { kinfolkIds: [] },
          'kinfolk/3': { firstName: 'Doe' },
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(handler({ data: variant.data, auth: { uid: 'op-uid' } } as any)).resolves.toBeTruthy();
    });

    it(`${variant.name}: ALLOWS an operator with the admin claim on a household that is not their own`, async () => {
      const ctx = buildDbMock({
        docs: {
          'clients/op-uid': { kinfolkIds: [] },
          'kinfolk/3': { firstName: 'Doe' },
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(
        handler({ data: variant.data, auth: { uid: 'op-uid', token: { admin: true } } } as any),
      ).resolves.toBeTruthy();
    });

    it(`${variant.name}: DENIES a stranger (not staff, kinfolkIds does not include the target)`, async () => {
      const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const mod = await import('../src/portal/kinWrites');
      const handler = (mod as any)[variant.import];
      await expect(
        handler({ data: variant.data, auth: { uid: 'stranger' } } as any),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  }
});

describe('addKinHandler', () => {
  it('rejects unauth', async () => {
    const { addKinHandler } = await import('../src/portal/kinWrites');
    await expect(addKinHandler({ data: { kin: { name: 'X' } }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when name missing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addKinHandler } = await import('../src/portal/kinWrites');
    await expect(addKinHandler({ data: { kinfolkId: '3', kin: {} }, auth: { uid: 'u1' } } as any)).rejects.toThrow();
  });

  it('writes status=active and returns kinId', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { addKinHandler } = await import('../src/portal/kinWrites');
    const res = await addKinHandler({
      data: { kinfolkId: '3', kin: { name: 'Buddy', breed: 'Aussie', ageYears: 4 } },
      auth: { uid: 'u1' },
    } as any);
    expect(res.kinId).toBeTypeOf('string');
    const wrote = ctx.adds.find((a) => a.collection === 'families/3/kin');
    expect(wrote).toBeDefined();
    expect(wrote!.data.status).toBe('active');
    expect(wrote!.data.name).toBe('Buddy');
  });
});

describe('archiveKinHandler', () => {
  it('flips status to noLongerWithUs', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { archiveKinHandler } = await import('../src/portal/kinWrites');
    await archiveKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', reason: 'noLongerWithUs' },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data.status).toBe('noLongerWithUs');
    expect(w!.merge).toBe(true);
  });

  it('restores when reason=restore', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { archiveKinHandler } = await import('../src/portal/kinWrites');
    await archiveKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', reason: 'restore' },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data.status).toBe('active');
  });
});

describe('updateKinHandler', () => {
  it('merges partial fields', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { updateKinHandler } = await import('../src/portal/kinWrites');
    await updateKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', kin: { medications: 'twice daily' } },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data.medications).toBe('twice daily');
    expect(w!.data.updatedByUid).toBe('u1');
  });

  // #1310: the household edits the descriptive facts the admin also persists.
  it('writes sex, weight, markings, fixed flag and vet through to the family doc', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { updateKinHandler } = await import('../src/portal/kinWrites');
    await updateKinHandler({
      data: {
        kinfolkId: '3',
        kinId: 'k1',
        kin: { sex: 'Female', weight: '52 lbs', colorMarkings: 'Black', spayedNeutered: true, vetInfo: 'Riverside Animal Hospital' },
      },
      auth: { uid: 'u1' },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w!.data).toMatchObject({
      sex: 'Female',
      weight: '52 lbs',
      colorMarkings: 'Black',
      spayedNeutered: true,
      vetInfo: 'Riverside Animal Hospital',
    });
  });
  it('lets an empty string clear a shared field, and refuses null (the admin Android decode would crash on null)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { updateKinHandler } = await import('../src/portal/kinWrites');
    await updateKinHandler({ data: { kinfolkId: '3', kinId: 'k1', kin: { weight: '' } }, auth: { uid: 'u1' } } as any);
    expect(ctx.writes.find((w) => w.path === 'families/3/kin/k1')!.data.weight).toBe('');
    await expect(
      updateKinHandler({ data: { kinfolkId: '3', kinId: 'k1', kin: { weight: null } }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
  });
  it('enforces the length caps on the shared fields', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { updateKinHandler } = await import('../src/portal/kinWrites');
    for (const kin of [{ sex: 'x'.repeat(41) }, { weight: 'x'.repeat(41) }, { colorMarkings: 'x'.repeat(201) }, { vetInfo: 'x'.repeat(2001) }]) {
      await expect(updateKinHandler({ data: { kinfolkId: '3', kinId: 'k1', kin }, auth: { uid: 'u1' } } as any)).rejects.toThrow();
    }
    await expect(
      updateKinHandler({ data: { kinfolkId: '3', kinId: 'k1', kin: { spayedNeutered: 'yes' } }, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
  });
  it('silently drops staff-only keys a client sends (officeNotes, reactive, routine...): they never reach the doc', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { updateKinHandler } = await import('../src/portal/kinWrites');
    await updateKinHandler({
      data: {
        kinfolkId: '3',
        kinId: 'k1',
        kin: { sex: 'Male', officeNotes: 'x', reactive: true, routine: 'x', vaccinations: 'x', tags: ['Microchipped'] },
      },
      auth: { uid: 'u1' },
    } as any);
    const data = ctx.writes.find((w) => w.path === 'families/3/kin/k1')!.data;
    expect(data.sex).toBe('Male');
    for (const k of ['officeNotes', 'reactive', 'routine', 'vaccinations', 'tags']) expect(data).not.toHaveProperty(k);
  });
});

/**
 * #1314. A household deletes a Kin itself only when nothing references it.
 * `k1` is the family doc id, `flat1` its AuntieOS mirror id; admin-written rows
 * (sessions, KinTales, media tags, training documents, the_411) carry ONLY the
 * flat id, so every blocker is exercised through at least one of them.
 */
describe('deleteKinHandler (#1314)', () => {
  const FAMILY_KIN = { name: 'Buddy', status: 'active', legacyKinId: 'flat1', familyKinPath: 'families/3/kin/k1' };
  const FLAT_KIN = { name: 'Buddy', kinfolkId: '3', familyKinPath: 'families/3/kin/k1', legacyKinId: 'flat1' };

  function cleanHousehold(extra: Parameters<typeof buildDbMock>[0] = {}) {
    return buildDbMock({
      ...extra,
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': FAMILY_KIN,
        'kin/flat1': FLAT_KIN,
        ...(extra.docs ?? {}),
      },
    });
  }

  it('rejects unauth', async () => {
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(deleteKinHandler({ data: { kinId: 'k1' }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('DENIES a kintales_only secondary (kin_edit gate) and deletes nothing', async () => {
    const ctx = cleanHousehold({ docs: { 'families/3/members/u1': KINTALES_ONLY_MEMBER } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(
      deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.deletes).toEqual([]);
  });

  it('DENIES a stranger and deletes nothing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/stranger': { kinfolkIds: ['other-fam'] }, 'families/3/kin/k1': FAMILY_KIN } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(
      deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'stranger' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.deletes).toEqual([]);
  });

  it('not-found when the family doc is already gone', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(
      deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('without confirm it only reports: canDelete true, and nothing is written or deleted', async () => {
    const ctx = cleanHousehold();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any);
    expect(res).toEqual({ ok: true, deleted: false, canDelete: true, blockedBy: [] });
    expect(ctx.deletes).toEqual([]);
    expect(ctx.writes).toEqual([]);
  });

  it('without confirm, a Kin with a portal booking reports canDelete false and names visits', async () => {
    const ctx = cleanHousehold({
      queryDocs: { 'families/3/bookings': [{ id: 'b1', data: { familyId: '3', kinIds: ['k1'] } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any);
    expect(res).toEqual({ ok: true, deleted: false, canDelete: false, blockedBy: ['visits'] });
    expect(ctx.deletes).toEqual([]);
  });

  it('with confirm, a Kin with history is REFUSED with one plain sentence and nothing is deleted', async () => {
    const ctx = cleanHousehold({
      queryDocs: { kin_care_sessions: [{ id: 's1', data: { kinfolkId: '3', kinIds: ['flat1'] } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await expect(
      deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Buddy has visits on file, so this profile cannot be deleted from here.',
    });
    expect(ctx.deletes).toEqual([]);
    expect(ctx.writes).toEqual([]);
  });

  describe('every collection that stores a kin id blocks the delete', () => {
    const cases: Array<{ name: string; blocker: string; fixture: Parameters<typeof buildDbMock>[0] }> = [
      {
        name: 'a visit (kinCares collection group, in-memory kinIds match on the family id)',
        blocker: 'visits',
        fixture: {
          collectionGroupDocs: {
            kinCares: [{ id: 'v1', path: 'families/3/bookings/b1/kinCares/v1', data: { familyId: '3', kinIds: ['k1'] } }],
          },
        },
      },
      {
        name: 'an admin-created session that carries only the flat id',
        blocker: 'visits',
        fixture: { queryDocs: { kin_care_sessions: [{ id: 's1', data: { kinfolkId: '3', kinIds: ['flat1'] } }] } },
      },
      {
        name: 'a KinTale (kin_care_reports, flat id)',
        blocker: 'tales',
        fixture: { queryDocs: { kin_care_reports: [{ id: 'r1', data: { kinfolkId: '3', kinIds: ['flat1'] } }] } },
      },
      {
        name: 'a media file owned by the kin (admin gallery entityType KIN + entityId)',
        blocker: 'photos',
        fixture: { queryDocs: { media_files: [{ id: 'm0', data: { entityType: 'kin', entityId: 'flat1' } }] } },
      },
      {
        name: 'a legacy media file keyed by kinId',
        blocker: 'photos',
        fixture: { queryDocs: { media_files: [{ id: 'm1', data: { kinId: 'flat1' } }] } },
      },
      {
        name: 'a media file tagged with the kin (taggedKinIds)',
        blocker: 'photos',
        fixture: { queryDocs: { media_files: [{ id: 'm2', data: { taggedKinIds: ['flat1'] } }] } },
      },
      {
        name: 'a training document scoped to the kin',
        blocker: 'records',
        fixture: { queryDocs: { training_documents: [{ id: 't1', data: { targetType: 'KIN', targetKinId: 'flat1' } }] } },
      },
      {
        name: 'a the_411 record at the deterministic id 411_{flatId}',
        blocker: 'records',
        fixture: { docs: { 'the_411/411_flat1': { rawSummary: 'x' } } },
      },
      {
        name: 'a the_411 record under any id, found by its kinId field (admin Android read path)',
        blocker: 'records',
        fixture: { queryDocs: { the_411: [{ id: 'legacy-411', data: { kinId: 'flat1', rawSummary: 'x' } }] } },
      },
    ];
    for (const c of cases) {
      it(`${c.name} -> blockedBy ${c.blocker}`, async () => {
        const ctx = cleanHousehold(c.fixture);
        mocks.dbFn.mockReturnValue(ctx.db);
        const { deleteKinHandler } = await import('../src/portal/kinWrites');
        const res = await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any);
        expect(res.canDelete).toBe(false);
        expect(res.blockedBy).toEqual([c.blocker]);
      });
    }

    it('a visit for ANOTHER kin of the same household does not block', async () => {
      const ctx = cleanHousehold({
        collectionGroupDocs: {
          kinCares: [{ id: 'v1', path: 'families/3/bookings/b1/kinCares/v1', data: { familyId: '3', kinIds: ['k2'] } }],
        },
        queryDocs: { kin_care_reports: [{ id: 'r1', data: { kinfolkId: '3', kinIds: ['flat2'] } }] },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { deleteKinHandler } = await import('../src/portal/kinWrites');
      const res = await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any);
      expect(res.canDelete).toBe(true);
    });
  });

  it('with confirm and no history, deletes the family doc AND its flat mirror in one batch', async () => {
    const ctx = cleanHousehold();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'u1' } } as any);
    expect(res).toEqual({ ok: true, deleted: true, canDelete: true, blockedBy: [] });
    expect([...ctx.deletes].sort()).toEqual(['families/3/kin/k1', 'kin/flat1']);
    // A hard delete, never a status write.
    expect(ctx.writes).toEqual([]);
  });

  it('finds the flat mirror through its familyKinPath when the family doc carries no legacyKinId', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': { name: 'Buddy', status: 'active' },
        'kin/flatX': { name: 'Buddy', kinfolkId: '3', familyKinPath: 'families/3/kin/k1' },
      },
      queryDocs: { kin: [{ id: 'flatX', data: { name: 'Buddy', kinfolkId: '3', familyKinPath: 'families/3/kin/k1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'u1' } } as any);
    expect([...ctx.deletes].sort()).toEqual(['families/3/kin/k1', 'kin/flatX']);
  });

  it('leaves a flat doc alone when it does not link back to this family doc', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': { name: 'Buddy', status: 'active', legacyKinId: 'flat9' },
        'kin/flat9': { name: 'Buddy', kinfolkId: '7', familyKinPath: 'families/7/kin/other' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'u1' } } as any);
    expect(ctx.deletes).toEqual(['families/3/kin/k1']);
  });

  it('with no flat mirror at all, deletes just the family doc', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3/kin/k1': { name: 'Buddy', status: 'active' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    await deleteKinHandler({ data: { kinfolkId: '3', kinId: 'k1', confirm: true }, auth: { uid: 'u1' } } as any);
    expect(ctx.deletes).toEqual(['families/3/kin/k1']);
  });

  it('ALLOWS an operator with the admin claim on a household that is not their own', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: [] },
        'kinfolk/3': { firstName: 'Doe' },
        'families/3/kin/k1': FAMILY_KIN,
        'kin/flat1': FLAT_KIN,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { deleteKinHandler } = await import('../src/portal/kinWrites');
    const res = await deleteKinHandler({
      data: { kinfolkId: '3', kinId: 'k1', confirm: true },
      auth: { uid: 'op-uid', token: { admin: true } },
    } as any);
    expect(res.deleted).toBe(true);
    expect([...ctx.deletes].sort()).toEqual(['families/3/kin/k1', 'kin/flat1']);
  });
});

describe('deleteRefusalMessage (#1314)', () => {
  it('names the kin and lists every kind of history in one sentence', async () => {
    const { deleteRefusalMessage } = await import('../src/portal/kinWrites');
    expect(deleteRefusalMessage('Buddy', ['visits'])).toBe('Buddy has visits on file, so this profile cannot be deleted from here.');
    expect(deleteRefusalMessage('Buddy', ['visits', 'tales'])).toBe('Buddy has visits and KinTales on file, so this profile cannot be deleted from here.');
    expect(deleteRefusalMessage(null, ['visits', 'tales', 'photos', 'records'])).toBe(
      'This Kin has visits, KinTales, photos and records on file, so this profile cannot be deleted from here.',
    );
  });
});
