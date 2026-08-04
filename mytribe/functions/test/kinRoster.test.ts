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

  it('honors an explicit subset exactly, because narrowing is a deliberate act', async () => {
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
