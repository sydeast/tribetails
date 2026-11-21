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
    // Each under its admin record's id, the one every admin screen looks a
    // visit's Kin up by, with the household's own card id beside it.
    expect(await readHouseholdKinRoster('3')).toEqual([
      { id: 'flat-a', householdId: 'fam-a', name: 'Biscuit', active: true },
      { id: 'both-b', householdId: 'both-b', name: 'Gravy', active: true },
      { id: 'flat-e', householdId: 'fam-e', name: 'Pepper', active: true },
      { id: 'flat-f', householdId: null, name: 'Office Cat', active: true },
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

  it('lists a Kin under its household card id while it has no admin record yet', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          'families/7/kin': [
            { id: 'new-1', data: { name: 'Just Added' } },
            // Stamped with a record that is not this household's, or is gone.
            { id: 'new-2', data: { name: 'Dangling', legacyKinId: 'not-here' } },
          ],
        },
      }).db,
    );
    const { readHouseholdKinRoster } = await import('../src/lib/kinRoster');

    expect((await readHouseholdKinRoster('7')).map((k) => k.id)).toEqual(['new-1', 'new-2']);
  });

  it('never gives two Kin one id when both claim the same admin record', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          'families/7/kin': [
            { id: 'first', data: { name: 'Rex', legacyKinId: 'flat-1' } },
            { id: 'second', data: { name: 'Rex Two', legacyKinId: 'flat-1' } },
          ],
          kin: [{ id: 'flat-1', data: { name: 'Rex', kinfolkId: '7' } }],
        },
      }).db,
    );
    const { readHouseholdKinRoster } = await import('../src/lib/kinRoster');

    expect((await readHouseholdKinRoster('7')).map((k) => k.id)).toEqual(['flat-1', 'second']);
  });

  it('gives a household whose only Kin the office typed in a roster (#1822)', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ queryDocs: { kin: [{ id: 'flat-1', data: { name: 'Solo', kinfolkId: '7' } }] } }).db,
    );
    const { materializeKinRoster } = await import('../src/lib/kinRoster');
    expect(await materializeKinRoster('7', [])).toEqual({ kinIds: ['flat-1'], kinNames: ['Solo'] });
  });
});

// An existing booking keeps the ids it was stored with. Older writers stored
// whichever of a Kin's two ids their caller held, and the approval named only
// the ones that were household copies: three names for six Kin (#1862).
describe('materializeKinRoster, naming the Kin an existing booking stores', () => {
  function home() {
    return {
      queryDocs: {
        'families/3/kin': [
          { id: 'fam-a', data: { name: 'Biscuit', legacyKinId: 'flat-a' } },
          { id: 'fam-b', data: { name: 'Gravy', legacyKinId: 'flat-b' } },
          { id: 'fam-c', data: { name: 'Old Boy', status: 'noLongerWithUs', legacyKinId: 'flat-c' } },
        ],
        kin: [
          { id: 'flat-a', data: { name: 'Biscuit', kinfolkId: '3' } },
          { id: 'flat-b', data: { name: 'Gravy', kinfolkId: '3' } },
          { id: 'flat-c', data: { name: 'Old Boy', kinfolkId: '3' } },
          { id: 'flat-f', data: { name: 'Office Cat', kinfolkId: '3' } },
        ],
      },
      docs: { 'families/3/kin/stray': { name: 'Left Behind' } },
    };
  }

  it('names a Kin stored under its admin record id', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', ['flat-a', 'flat-b', 'flat-f'])).toEqual({
      kinIds: ['flat-a', 'flat-b', 'flat-f'],
      kinNames: ['Biscuit', 'Gravy', 'Office Cat'],
    });
  });

  // #2350: approving a request made before #2347 kept its household card ids,
  // so the booked visit's Kin were missing from every admin screen.
  it('names a Kin stored under its household card id, and stores the admin record id the admin screens read', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', ['fam-b', 'flat-a'])).toEqual({
      kinIds: ['flat-b', 'flat-a'],
      kinNames: ['Gravy', 'Biscuit'],
    });
  });

  it('#2350: a Kin named under both of its ids is stored once', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', ['fam-a', 'flat-a', 'fam-b'])).toEqual({
      kinIds: ['flat-a', 'flat-b'],
      kinNames: ['Biscuit', 'Gravy'],
    });
  });

  it('#2350: a Kin who has since passed is stored under its admin record id too', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', ['fam-c'])).toEqual({ kinIds: ['flat-c'], kinNames: ['Old Boy'] });
  });

  it('still names a Kin the booking was made for who has since passed', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect((await materializeKinRoster('3', ['flat-c'])).kinNames).toEqual(['Old Boy']);
  });

  it('keeps an id no Kin answers to, with no name, rather than failing the approval', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', ['flat-a', 'gone'])).toEqual({
      kinIds: ['flat-a', 'gone'],
      kinNames: ['Biscuit'],
    });
  });

  it('with no Kin stored, covers every Kin in care under the ids the admin screens read', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(home()).db);
    const { materializeKinRoster } = await import('../src/lib/kinRoster');

    expect(await materializeKinRoster('3', [])).toEqual({
      kinIds: ['flat-a', 'flat-b', 'flat-f'],
      kinNames: ['Biscuit', 'Gravy', 'Office Cat'],
    });
  });
});

describe('kinRosterForNewVisit, operator ruling 2026-11-12: every visit covers every Kin', () => {
  it('with choosing Kin on, reads either of a Kin\'s two ids as that Kin and stores the admin one', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          'families/3/kin': [
            { id: 'fam-a', data: { name: 'Biscuit', legacyKinId: 'flat-a' } },
            { id: 'fam-b', data: { name: 'Gravy', legacyKinId: 'flat-b' } },
          ],
          kin: [
            { id: 'flat-a', data: { name: 'Biscuit', kinfolkId: '3' } },
            { id: 'flat-b', data: { name: 'Gravy', kinfolkId: '3' } },
          ],
        },
      }).db,
    );
    const { kinRosterForNewVisit } = await import('../src/lib/kinRoster');

    // The portal names the household's card, the office names its record.
    expect(await kinRosterForNewVisit('3', ['fam-b'], { chooseKin: true })).toEqual({
      kinIds: ['flat-b'],
      kinNames: ['Gravy'],
    });
    expect(await kinRosterForNewVisit('3', ['flat-a'], { chooseKin: true })).toEqual({
      kinIds: ['flat-a'],
      kinNames: ['Biscuit'],
    });
  });


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
describe('ruling 2026-11-20 (#1822): a newly adopted Kin joins visits booked from then on', () => {
  it('a visit booked after the adoption names the new Kin, whichever side added it, while the earlier visit keeps its Kin', async () => {
    const before = {
      queryDocs: {
        'families/3/kin': [{ id: 'fam-a', data: { name: 'Biscuit', legacyKinId: 'flat-a' } }],
        kin: [{ id: 'flat-a', data: { name: 'Biscuit', kinfolkId: '3' } }],
      },
    };
    mocks.dbFn.mockReturnValue(buildDbMock(before).db);
    const { kinRosterForNewVisit, materializeKinRoster } = await import('../src/lib/kinRoster');
    const earlier = await kinRosterForNewVisit('3', undefined, { chooseKin: false });
    expect(earlier).toEqual({ kinIds: ['flat-a'], kinNames: ['Biscuit'] });
    // The household adds Gravy in MyTribe, and the office adds Pepper itself.
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          'families/3/kin': [
            ...before.queryDocs['families/3/kin'],
            { id: 'fam-g', data: { name: 'Gravy', legacyKinId: 'flat-g' } },
          ],
          kin: [
            ...before.queryDocs.kin,
            { id: 'flat-g', data: { name: 'Gravy', kinfolkId: '3' } },
            { id: 'flat-p', data: { name: 'Pepper', kinfolkId: '3' } },
          ],
        },
      }).db,
    );
    expect(await kinRosterForNewVisit('3', undefined, { chooseKin: false })).toEqual({
      kinIds: ['flat-a', 'flat-g', 'flat-p'],
      kinNames: ['Biscuit', 'Gravy', 'Pepper'],
    });
    // The visit already booked is not rewritten by reading it again.
    expect(await materializeKinRoster('3', earlier.kinIds)).toEqual({ kinIds: ['flat-a'], kinNames: ['Biscuit'] });
  });
});
