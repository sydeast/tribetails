import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeBreedBanks, getBreeds, resetBreedCache } from './breeds';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: (name: string, payload: unknown) => mocks.call(name, payload) }));

beforeEach(() => {
  mocks.call.mockReset();
  resetBreedCache();
});

describe('decodeBreedBanks', () => {
  it('decodes the callable body', () => {
    expect(decodeBreedBanks({ dogBreeds: ['Boxer'], catBreeds: ['Bengal'] })).toEqual({
      dogBreeds: ['Boxer'],
      catBreeds: ['Bengal'],
    });
  });

  it('fabricates nothing from a malformed or partial body', () => {
    expect(decodeBreedBanks(undefined)).toEqual({ dogBreeds: [], catBreeds: [] });
    expect(decodeBreedBanks({})).toEqual({ dogBreeds: [], catBreeds: [] });
    expect(decodeBreedBanks({ dogBreeds: 'Boxer' })).toEqual({ dogBreeds: [], catBreeds: [] });
    expect(decodeBreedBanks({ dogBreeds: ['Boxer', 7, null, '  '] })).toEqual({
      dogBreeds: ['Boxer'],
      catBreeds: [],
    });
  });
});

describe('getBreeds', () => {
  it('calls getBreeds with an empty payload', async () => {
    mocks.call.mockResolvedValue({ dogBreeds: ['Boxer'], catBreeds: [] });
    await getBreeds();
    expect(mocks.call).toHaveBeenCalledWith('getBreeds', {});
  });

  it('memoizes a resolved bank so a second form does not pay a second round trip', async () => {
    mocks.call.mockResolvedValue({ dogBreeds: ['Boxer'], catBreeds: ['Bengal'] });
    const first = await getBreeds();
    const second = await getBreeds();
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    mocks.call.mockResolvedValue({ dogBreeds: ['Boxer'], catBreeds: [] });
    await Promise.all([getBreeds(), getBreeds(), getBreeds()]);
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure, so a cold start does not degrade the field all session', async () => {
    mocks.call.mockRejectedValueOnce(new Error('deadline-exceeded'));
    await expect(getBreeds()).rejects.toThrow('deadline-exceeded');

    mocks.call.mockResolvedValue({ dogBreeds: ['Boxer'], catBreeds: [] });
    await expect(getBreeds()).resolves.toEqual({ dogBreeds: ['Boxer'], catBreeds: [] });
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });
});
