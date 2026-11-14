import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { ...actual.FieldValue, serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

import { pickHouseholdVetClinicId, withCanonicalVetRow } from '../src/lib/vetClinicCatalog';

const CLINIC = { name: 'Cedar Animal Care', phone: '555 0142', address: '1 Main St' };

/**
 * #1908 kin-vet, #1917. One store for the household's vet, shared by both apps:
 * `household_data.primaryVetClinicId`. The portal kept its own copy as the
 * `vetClinicId` profile row, and the two never met.
 */
describe('pickHouseholdVetClinicId', () => {
  it('household_data wins whenever it carries the field, even blank (the office cleared it)', () => {
    const legacy = [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'old' }];
    expect(pickHouseholdVetClinicId({ primaryVetClinicId: 'new' }, legacy)).toBe('new');
    expect(pickHouseholdVetClinicId({ primaryVetClinicId: '' }, legacy)).toBe('');
  });
  it('falls back to the legacy row only when household_data has no such field', () => {
    const legacy = [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'old' }];
    expect(pickHouseholdVetClinicId({}, legacy)).toBe('old');
    expect(pickHouseholdVetClinicId(null, legacy)).toBe('old');
    expect(pickHouseholdVetClinicId(null, undefined)).toBe('');
  });
});

describe('withCanonicalVetRow', () => {
  it('serves the legacy row saying what the store says, so an old client echoes the real vet', () => {
    const rows = [
      { key: 'k1', label: 'Anniversary', value: 'Oct 14' },
      { key: 'vetClinicId', label: 'Vet Clinic', value: 'stale' },
    ];
    expect(withCanonicalVetRow(rows, 'fresh')).toEqual([
      { key: 'k1', label: 'Anniversary', value: 'Oct 14' },
      { key: 'vetClinicId', label: 'Vet Clinic', value: 'fresh' },
    ]);
    expect(withCanonicalVetRow(rows, '')).toEqual([{ key: 'k1', label: 'Anniversary', value: 'Oct 14' }]);
  });
});

describe('setHouseholdVetHandler (#1917: saved the moment it is picked)', () => {
  it('rejects a call with no sign-in', async () => {
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    await expect(setHouseholdVetHandler({ data: { clinicId: 'c1' }, auth: undefined } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('writes the pick to the shared store, keyed so a retry finds the same doc, and drops the legacy row', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'vet_clinics/c1': CLINIC,
        'families/3': { customFields: [{ key: 'k1', label: 'A', value: 'b' }, { key: 'vetClinicId', label: 'Vet Clinic', value: 'old' }] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    const res = await setHouseholdVetHandler({ data: { kinfolkId: '3', clinicId: 'c1' }, auth: { uid: 'u1' } } as any);

    expect(res).toEqual({ ok: true, vetClinic: { id: 'c1', name: 'Cedar Animal Care', phone: '555 0142', address: '1 Main St', isEmergency: false } });
    const hd = ctx.writes.find((w) => w.path === 'household_data/3')!;
    expect(hd.data).toMatchObject({ primaryVetClinicId: 'c1', kinfolkId: '3' });
    const fam = ctx.writes.find((w) => w.path === 'families/3')!;
    expect(fam.data.customFields).toEqual([{ key: 'k1', label: 'A', value: 'b' }]);
  });

  it('writes into the household_data doc the admin already keeps, found by its kinfolkId field', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'vet_clinics/c1': CLINIC, 'household_data/auto9': { kinfolkId: '3', primaryVetClinicId: 'c0' } },
      queryDocs: { household_data: [{ id: 'auto9', data: { kinfolkId: '3', primaryVetClinicId: 'c0' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    await setHouseholdVetHandler({ data: { kinfolkId: '3', clinicId: 'c1' }, auth: { uid: 'u1' } } as any);
    expect(ctx.writes.find((w) => w.path === 'household_data/auto9')!.data.primaryVetClinicId).toBe('c1');
    expect(ctx.writes.find((w) => w.path === 'household_data/3')).toBeUndefined();
  });

  it('"" removes the household vet at once', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'household_data/auto9': { kinfolkId: '3', primaryVetClinicId: 'c0' } },
      queryDocs: { household_data: [{ id: 'auto9', data: { kinfolkId: '3', primaryVetClinicId: 'c0' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    const res = await setHouseholdVetHandler({ data: { kinfolkId: '3', clinicId: '' }, auth: { uid: 'u1' } } as any);
    expect(res.vetClinic).toBeNull();
    expect(ctx.writes.find((w) => w.path === 'household_data/auto9')!.data.primaryVetClinicId).toBe('');
  });

  it('the same vet again writes nothing (a double tap is one save)', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'vet_clinics/c1': CLINIC },
      queryDocs: { household_data: [{ id: 'auto9', data: { kinfolkId: '3', primaryVetClinicId: 'c1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    await setHouseholdVetHandler({ data: { kinfolkId: '3', clinicId: 'c1' }, auth: { uid: 'u1' } } as any);
    expect(ctx.writes).toHaveLength(0);
  });

  for (const [label, docs] of [
    ['missing', {}],
    ['archived', { 'vet_clinics/c1': { ...CLINIC, archived: true } }],
  ] as const) {
    it(`refuses a clinic that is ${label}, and writes nothing`, async () => {
      const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] }, ...docs } });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
      await expect(
        setHouseholdVetHandler({ data: { kinfolkId: '3', clinicId: 'c1' }, auth: { uid: 'u1' } } as any),
      ).rejects.toMatchObject({ code: 'invalid-argument', message: 'That vet is not on the list.' });
      expect(ctx.writes).toHaveLength(0);
    });
  }

  it('takes a clinic the household submitted that is still waiting for the office', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'vet_clinics/c1': { ...CLINIC, verified: false } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    const res = await setHouseholdVetHandler({ data: { kinfolkId: '3', clinicId: 'c1' }, auth: { uid: 'u1' } } as any);
    expect(res.vetClinic?.id).toBe('c1');
  });

  it('refuses a household the caller does not belong to', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'vet_clinics/c1': CLINIC } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setHouseholdVetHandler } = await import('../src/portal/saveTribeProfile');
    await expect(
      setHouseholdVetHandler({ data: { kinfolkId: '9', clinicId: 'c1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('getMyTribeProfile reads the shared store (#1908 kin-vet)', () => {
  it('a vet the office set on household_data reaches the portal, over an older legacy row', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { displayName: 'X', customFields: [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'old' }] },
        'vet_clinics/c1': CLINIC,
      },
      queryDocs: { household_data: [{ id: 'auto9', data: { kinfolkId: '3', primaryVetClinicId: 'c1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyTribeProfileHandler } = await import('../src/portal/getMyTribeProfile');
    const res = await getMyTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.vetClinic?.id).toBe('c1');
    expect(res.profile.customFields.find((f) => f.key === 'vetClinicId')?.value).toBe('c1');
  });
});

describe('saveTribeProfile: an old client still sending the vet as a profile row', () => {
  it('a new vet in the row reaches the shared store, and the row is not stored', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3': { displayName: 'X', customFields: [] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({
      data: { kinfolkId: '3', customFields: [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'c1' }] },
      auth: { uid: 'u1' },
    } as any);
    expect(ctx.writes.find((w) => w.path === 'household_data/3')!.data.primaryVetClinicId).toBe('c1');
    const famWrites = ctx.writes.filter((w) => w.path === 'families/3');
    for (const w of famWrites) {
      expect((w.data.customFields as Array<{ key: string }> | undefined)?.some((r) => r.key === 'vetClinicId') ?? false).toBe(false);
    }
  });

  it('an echo of the vet already on file writes nothing to the store', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3': { displayName: 'X', customFields: [] } },
      queryDocs: { household_data: [{ id: 'auto9', data: { kinfolkId: '3', primaryVetClinicId: 'c1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({
      data: { kinfolkId: '3', customFields: [{ key: 'vetClinicId', label: 'Vet Clinic', value: 'c1' }] },
      auth: { uid: 'u1' },
    } as any);
    expect(ctx.writes.find((w) => w.path.startsWith('household_data/'))).toBeUndefined();
  });
});
