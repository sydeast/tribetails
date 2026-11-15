import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
});

/** The household roster fixture: a dog, a cat, a memorial pet and a legacy archived row. */
function household() {
  return {
    queryDocs: {
      'families/3/kin': [
        { id: 'k1', data: { name: 'Fido', status: 'active' } },
        { id: 'k2', data: { name: 'Whiskers' } }, // no status at all
        { id: 'k3', data: { name: 'Old Boy', status: 'noLongerWithUs' } },
        { id: 'k4', data: { name: 'Ghost', status: 'archived' } },
      ],
    },
    docs: {
      'families/3/kin/k1': { name: 'Fido', status: 'active' },
      'families/3/kin/k2': { name: 'Whiskers' },
    },
  };
}

describe('materializeKinRoster, R1: a booking covers every Kin in the home', () => {
  it('materializes the whole active roster when the caller named no Kin', async () => {
    const ctx = buildDbMock(household());
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    const out = await materializeKinRoster('3', []);

    expect(out.kinIds).toEqual(['k1', 'k2']);
    expect(out.kinNames).toEqual(['Fido', 'Whiskers']);
  });

  it('treats an omitted kinIds exactly as an empty one, since both mean the whole home', async () => {
    const ctx = buildDbMock(household());
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', undefined)).toEqual(
      await materializeKinRoster('3', null),
    );
  });

  it('keeps the Kin an existing booking already names, exactly as stored', async () => {
    const ctx = buildDbMock(household());
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    const out = await materializeKinRoster('3', ['k1']);

    expect(out.kinIds).toEqual(['k1']);
    expect(out.kinNames).toEqual(['Fido']);
  });

  it('leaves a memorial Kin off a new booking: nobody is walking them', async () => {
    const ctx = buildDbMock(household());
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    const out = await materializeKinRoster('3', []);

    expect(out.kinIds).not.toContain('k3');
    expect(out.kinNames).not.toContain('Old Boy');
  });

  it('leaves the legacy archived spelling off too', async () => {
    const ctx = buildDbMock(household());
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect((await materializeKinRoster('3', [])).kinIds).not.toContain('k4');
  });

  it('keeps a nameless Kin on kinIds but off kinNames, never as a blank chip', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        'families/3/kin': [
          { id: 'k1', data: { name: 'Fido' } },
          { id: 'k2', data: { species: 'cat' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    const out = await materializeKinRoster('3', []);

    expect(out.kinIds).toEqual(['k1', 'k2']);
    expect(out.kinNames).toEqual(['Fido']);
  });

  it('de-duplicates a stated list rather than writing the same Kin twice', async () => {
    const ctx = buildDbMock(household());
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect((await materializeKinRoster('3', ['k1', 'k1'])).kinIds).toEqual(['k1']);
  });

  it('returns empty for a household with no Kin on file, which is honest, not unknown', async () => {
    const ctx = buildDbMock({ queryDocs: { 'families/3/kin': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', [])).toEqual({ kinIds: [], kinNames: [] });
  });
});

// #1862: one booking read six Kin on the admin wizard, three on the request and
// four on the portal, because each screen and the server counted a different
// store. #1822: a household whose only Kin the office typed in had no roster.
describe('readHouseholdKinRoster, the one roster every screen and writer reads', () => {
  function twoStores() {
    return {
      queryDocs: {
        'families/3/kin': [
          // Made by the household; its admin record has a different id.
          { id: 'fam-a', data: { name: 'Biscuit', legacyKinId: 'flat-a' } },
          // Made by the office, so both copies share the id.
          { id: 'both-b', data: { name: 'Gravy', status: 'active' } },
          // The household's goodbye. Its admin record still reads active.
          { id: 'fam-c', data: { name: 'Old Boy', status: 'noLongerWithUs', legacyKinId: 'flat-c' } },
          // Archived by the office, which writes both copies.
          { id: 'fam-d', data: { name: 'Ghost', status: 'archived', legacyKinId: 'flat-d' } },
          // Tied to its admin record by the record's pointer alone.
          { id: 'fam-e', data: { name: 'Pepper' } },
        ],
        kin: [
          { id: 'flat-a', data: { name: 'Biscuit', kinfolkId: '3' } },
          { id: 'both-b', data: { name: 'Gravy', kinfolkId: '3' } },
          { id: 'flat-c', data: { name: 'Old Boy', kinfolkId: '3', status: 'active' } },
          { id: 'flat-d', data: { name: 'Ghost', kinfolkId: '3', status: 'archived' } },
          { id: 'flat-e', data: { name: 'Pepper', kinfolkId: '3', familyKinPath: 'families/3/kin/fam-e' } },
          // The office made this Kin and no household copy exists yet.
          { id: 'flat-f', data: { name: 'Office Cat', kinfolkId: '3' } },
          // The office made and archived this one.
          { id: 'flat-g', data: { name: 'Long Gone', kinfolkId: '3', status: 'archived' } },
          // Another household's Kin.
          { id: 'flat-z', data: { name: 'Next Door', kinfolkId: '4' } },
        ],
      },
    };
  }
  it('lists each active Kin once, whichever store it was made in', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(twoStores()).db);
    const { readHouseholdKinRoster } = await import('../src/lib/kinRoster');
    expect(await readHouseholdKinRoster('3')).toEqual([
      { id: 'fam-a', flatId: 'flat-a', name: 'Biscuit' },
      { id: 'both-b', flatId: 'both-b', name: 'Gravy' },
      { id: 'fam-e', flatId: 'flat-e', name: 'Pepper' },
      { id: 'flat-f', flatId: 'flat-f', name: 'Office Cat' },
    ]);
  });
  it('leaves a memorial Kin off even though its admin record still reads active', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(twoStores()).db);
    const { readHouseholdKinRoster } = await import('../src/lib/kinRoster');
    const ids = (await readHouseholdKinRoster('3')).map((k) => k.id);
    expect(ids).not.toContain('fam-c');
    expect(ids).not.toContain('flat-c');
  });
  it('leaves an archived Kin off, with or without a household copy', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(twoStores()).db);
    const { readHouseholdKinRoster } = await import('../src/lib/kinRoster');
    const ids = (await readHouseholdKinRoster('3')).map((k) => k.id);
    for (const gone of ['fam-d', 'flat-d', 'flat-g']) expect(ids).not.toContain(gone);
  });
  it('never lists another household\'s Kin', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(twoStores()).db);
    const { readHouseholdKinRoster } = await import('../src/lib/kinRoster');
    expect((await readHouseholdKinRoster('3')).map((k) => k.name)).not.toContain('Next Door');
  });
  it('gives a household whose only Kin the office typed in a roster (#1822)', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ queryDocs: { kin: [{ id: 'flat-1', data: { name: 'Solo', kinfolkId: '7' } }] } }).db,
    );
    const { materializeKinRoster } = await import('../src/lib/kinRoster');
    expect(await materializeKinRoster('7', [])).toEqual({ kinIds: ['flat-1'], kinNames: ['Solo'] });
  });
});
describe('kinRosterForNewVisit, operator ruling 2026-11-12: every visit covers every Kin', () => {
  it('with choosing Kin off, stores the whole roster whatever was named', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(household()).db);
    const { kinRosterForNewVisit } = await import('../src/lib/kinRoster');
    for (const named of [['k1'], ['k3'], ['nobody'], [], null, undefined]) {
      expect(await kinRosterForNewVisit('3', named, { chooseKin: false })).toEqual({
        kinIds: ['k1', 'k2'],
        kinNames: ['Fido', 'Whiskers'],
      });
    }
  });
  it('with choosing Kin on, stores the named Kin in roster order, once each', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(household()).db);
    const { kinRosterForNewVisit } = await import('../src/lib/kinRoster');
    expect(await kinRosterForNewVisit('3', ['k2', 'k1', 'k2'], { chooseKin: true })).toEqual({
      kinIds: ['k1', 'k2'],
      kinNames: ['Fido', 'Whiskers'],
    });
    expect(await kinRosterForNewVisit('3', ['k2'], { chooseKin: true })).toEqual({
      kinIds: ['k2'],
      kinNames: ['Whiskers'],
    });
  });
  it('with choosing Kin on, never stores a memorial, archived or unknown Kin', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(household()).db);
    const { kinRosterForNewVisit } = await import('../src/lib/kinRoster');
    expect(await kinRosterForNewVisit('3', ['k1', 'k3', 'k4', 'stale'], { chooseKin: true })).toEqual({
      kinIds: ['k1'],
      kinNames: ['Fido'],
    });
  });
  it('with choosing Kin on, naming none, or none in care, means the whole home', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(household()).db);
    const { kinRosterForNewVisit } = await import('../src/lib/kinRoster');
    for (const named of [[], undefined, ['k3'], ['stale']]) {
      expect((await kinRosterForNewVisit('3', named, { chooseKin: true })).kinIds).toEqual(['k1', 'k2']);
    }
  });
});
