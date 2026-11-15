import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
beforeEach(() => mocks.dbFn.mockReset());

const FLAG = 'auntieos.visits.chooseKin';

/**
 * A household with two Kin in care, a memorial Kin, an archived Kin and a Kin
 * the office made that has no household copy. Household 4 is somebody else.
 */
function seed(docs: Record<string, Record<string, unknown>> = {}) {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'kinfolk/3': { firstName: 'Jamie', lastName: 'Halbrook' },
      'kinfolk/4': { firstName: 'Next', lastName: 'Door' },
      ...docs,
    },
    queryDocs: {
      'families/3/kin': [
        { id: 'k1', data: { name: 'Fido', status: 'active', legacyKinId: 'flat1', medications: 'private' } },
        { id: 'k2', data: { name: 'Whiskers' } },
        { id: 'k3', data: { name: 'Old Boy', status: 'noLongerWithUs' } },
        { id: 'k4', data: { name: 'Ghost', status: 'archived' } },
      ],
      'families/4/kin': [{ id: 'z1', data: { name: 'Next Door Dog' } }],
      kin: [
        { id: 'flat1', data: { name: 'Fido', kinfolkId: '3', officeNotes: 'bites' } },
        { id: 'flat9', data: { name: 'Office Cat', kinfolkId: '3' } },
        { id: 'flatz', data: { name: 'Next Door Dog', kinfolkId: '4' } },
      ],
    },
  });
}

async function call(data: unknown, auth: unknown) {
  const { getHouseholdKinRosterHandler } = await import('../src/portal/getHouseholdKinRoster');
  return getHouseholdKinRosterHandler({ data, auth } as never);
}

const OWNER = { uid: 'admin1', token: { admin: true } };
const AUNTIE = { uid: 'auntie1', token: { staffRole: 'auntie' } };

describe('getHouseholdKinRoster', () => {
  it('refuses a caller who is not signed in', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(call({}, undefined)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it("gives a household its own active Kin, the ones a new visit covers", async () => {
    mocks.dbFn.mockReturnValue(seed().db);

    const res = await call({ kinfolkId: '3' }, { uid: 'u1' });

    expect(res.kin).toEqual([
      { id: 'k1', name: 'Fido' },
      { id: 'k2', name: 'Whiskers' },
      { id: 'flat9', name: 'Office Cat' },
    ]);
  });

  it('gives the office the same Kin, under the same ids, for the household it names (#1862)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);

    const asHousehold = await call({ kinfolkId: '3' }, { uid: 'u1' });
    const asOffice = await call({ kinfolkId: '3' }, OWNER);

    expect(asOffice.kin.map((k) => ({ id: k.id, name: k.name }))).toEqual(asHousehold.kin);
  });

  it('carries names and ids only: no care notes, no office notes', async () => {
    mocks.dbFn.mockReturnValue(seed().db);

    const res = await call({ kinfolkId: '3' }, OWNER);

    for (const k of res.kin) {
      expect(Object.keys(k).filter((key) => key !== 'adminId').sort()).toEqual(['id', 'name']);
    }
  });

  it('tells staff the admin record a Kin is also known by, and never tells the household', async () => {
    mocks.dbFn.mockReturnValue(seed().db);

    const asOffice = await call({ kinfolkId: '3' }, OWNER);
    const asHousehold = await call({ kinfolkId: '3' }, { uid: 'u1' });

    expect(asOffice.kin.find((k) => k.id === 'k1')).toEqual({ id: 'k1', name: 'Fido', adminId: 'flat1' });
    // The office made this Kin: one id, so nothing more to say.
    expect(asOffice.kin.find((k) => k.id === 'flat9')).toEqual({ id: 'flat9', name: 'Office Cat' });
    for (const k of asHousehold.kin) expect(k).not.toHaveProperty('adminId');
  });

  it('says choosing Kin is off until the flag is switched on', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    expect((await call({ kinfolkId: '3' }, { uid: 'u1' })).chooseKin).toBe(false);

    mocks.dbFn.mockReturnValue(seed({ 'business_settings/feature_flags': { flags: { [FLAG]: false } } }).db);
    expect((await call({ kinfolkId: '3' }, OWNER)).chooseKin).toBe(false);
  });

  it('says choosing Kin is on for the household and for the office once the flag is on', async () => {
    mocks.dbFn.mockReturnValue(seed({ 'business_settings/feature_flags': { flags: { [FLAG]: true } } }).db);

    expect((await call({ kinfolkId: '3' }, { uid: 'u1' })).chooseKin).toBe(true);
    expect((await call({ kinfolkId: '3' }, OWNER)).chooseKin).toBe(true);
  });

  it('reads the flat flag doc shape the same way getFeatureFlags does', async () => {
    mocks.dbFn.mockReturnValue(seed({ 'business_settings/feature_flags': { [FLAG]: true } }).db);
    expect((await call({ kinfolkId: '3' }, OWNER)).chooseKin).toBe(true);
  });

  it("refuses a household that asks for another household's Kin", async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(call({ kinfolkId: '4' }, { uid: 'u1' })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a signed-in stranger with no household', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(call({ kinfolkId: '3' }, { uid: 'stranger' })).rejects.toBeTruthy();
  });

  it('admits an Auntie, who corrects the Kin of a visit on site', async () => {
    mocks.dbFn.mockReturnValue(seed().db);

    const res = await call({ kinfolkId: '3' }, AUNTIE);

    expect(res.kin.map((k) => k.id)).toEqual(['k1', 'k2', 'flat9']);
  });

  it('answers not-found for a household that does not exist', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(call({ kinfolkId: 'nope' }, OWNER)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('still answers, with choosing off, when the flag cannot be read', async () => {
    const ctx = seed();
    const realCollection = ctx.db.collection.bind(ctx.db);
    ctx.db.collection = ((name: string) => {
      if (name === 'business_settings') throw new Error('flags unavailable');
      return realCollection(name);
    }) as typeof ctx.db.collection;
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await call({ kinfolkId: '3' }, OWNER);

    expect(res.chooseKin).toBe(false);
    expect(res.kin).toHaveLength(3);
  });
});
