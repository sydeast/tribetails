import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeBreedBanks, getBreeds } from './breeds';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: (name: string, payload: unknown) => mocks.call(name, payload) }));

beforeEach(() => mocks.call.mockReset());

describe('decodeBreedBanks', () => {
  it('decodes the callable body', () => {
    expect(decodeBreedBanks({ dogBreeds: ['Boxer'], catBreeds: ['Bengal'] })).toEqual({
      dogBreeds: ['Boxer'],
      catBreeds: ['Bengal'],
    });
  });

  it('fabricates nothing from a malformed, partial, or dirty body', () => {
    expect(decodeBreedBanks(undefined)).toEqual({ dogBreeds: [], catBreeds: [] });
    expect(decodeBreedBanks({})).toEqual({ dogBreeds: [], catBreeds: [] });
    expect(decodeBreedBanks({ catBreeds: 'Bengal' })).toEqual({ dogBreeds: [], catBreeds: [] });
    expect(decodeBreedBanks({ catBreeds: ['Bengal', 3, null, '   '] })).toEqual({
      dogBreeds: [],
      catBreeds: ['Bengal'],
    });
  });
});

describe('getBreeds', () => {
  it('calls the getBreeds callable with an empty payload and decodes the result', async () => {
    mocks.call.mockResolvedValue({ dogBreeds: ['Boxer'], catBreeds: [] });
    await expect(getBreeds()).resolves.toEqual({ dogBreeds: ['Boxer'], catBreeds: [] });
    expect(mocks.call).toHaveBeenCalledWith('getBreeds', {});
  });

  it('propagates a callable failure rather than resolving an empty bank', async () => {
    // The caller decides how to degrade, and it discloses that it did. Swallowing
    // the error here would make an outage indistinguishable from an empty bank.
    mocks.call.mockRejectedValueOnce(new Error('deadline-exceeded'));
    await expect(getBreeds()).rejects.toThrow('deadline-exceeded');
  });
});
