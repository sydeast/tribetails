import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

import { resolveActor } from '../src/lib/resolveActor';

beforeEach(() => mocks.dbFn.mockReset());

describe('resolveActor (AO-28)', () => {
  it('returns nulls for a null/blank uid without touching the db', async () => {
    const r = await resolveActor(null);
    expect(r).toEqual({ actorName: null, actorPhotoUrl: null });
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('resolves a staff actor by displayName + photoUrl', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { 'staff/u1': { displayName: 'Nora', photoUrl: 'https://x/a.jpg' } } }).db,
    );
    expect(await resolveActor('u1')).toEqual({ actorName: 'Nora', actorPhotoUrl: 'https://x/a.jpg' });
  });

  it('falls back to kinfolk (first+last, profilePictureUrl) when not staff', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'kinfolk/k1': { firstName: 'Dana', lastName: 'Brooks', profilePictureUrl: 'https://x/k.jpg' } },
      }).db,
    );
    expect(await resolveActor('k1')).toEqual({ actorName: 'Dana Brooks', actorPhotoUrl: 'https://x/k.jpg' });
  });

  it('returns nulls (never throws) for an actor found in neither collection', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    expect(await resolveActor('ghost')).toEqual({ actorName: null, actorPhotoUrl: null });
  });
});
