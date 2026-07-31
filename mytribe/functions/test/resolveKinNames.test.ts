import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('resolveKinNames', () => {
  it('resolves names from families/{kinfolkId}/kin/{kinId}, the same doc getMyKin reads', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/kin/k1': { name: 'Fido', species: 'dog' },
        'families/3/kin/k2': { name: 'Whiskers', species: 'cat' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinNames } = await import('../src/lib/resolveKinNames');

    const names = await resolveKinNames('3', ['k1', 'k2']);

    expect(names).toEqual(['Fido', 'Whiskers']);
  });

  it('tolerates a missing kin doc by leaving that id out, not failing', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/kin/k1': { name: 'Fido' },
        // k2 does not exist: deleted kin, or a bad id.
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinNames } = await import('../src/lib/resolveKinNames');

    const names = await resolveKinNames('3', ['k1', 'k2']);

    expect(names).toEqual(['Fido']);
  });

  it('skips a kin doc with a blank or missing name rather than inserting an empty string', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/kin/k1': { name: 'Fido' },
        'families/3/kin/k2': { name: '' },
        'families/3/kin/k3': { species: 'dog' }, // no `name` field at all
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinNames } = await import('../src/lib/resolveKinNames');

    const names = await resolveKinNames('3', ['k1', 'k2', 'k3']);

    expect(names).toEqual(['Fido']);
  });

  it('returns [] without touching the db when kinIds is empty', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinNames } = await import('../src/lib/resolveKinNames');

    const names = await resolveKinNames('3', []);

    expect(names).toEqual([]);
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('batches the reads with getAll rather than one .get() per kin', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/kin/k1': { name: 'Fido' },
        'families/3/kin/k2': { name: 'Whiskers' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinNames } = await import('../src/lib/resolveKinNames');

    await resolveKinNames('3', ['k1', 'k2']);

    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates repeated kinIds', async () => {
    const ctx = buildDbMock({ docs: { 'families/3/kin/k1': { name: 'Fido' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinNames } = await import('../src/lib/resolveKinNames');

    const names = await resolveKinNames('3', ['k1', 'k1']);

    expect(names).toEqual(['Fido']);
  });
});
