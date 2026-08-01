import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invalidateSharedLoad, sharedLoad } from './useSharedOneShot';

/**
 * The sharing contract, tested without React because the point of it is the
 * request count and not the render. The hook is exercised in
 * `screens/widgets/WeatherWidgets.test.tsx`, where both weather cards are
 * mounted together and the callable is asserted to have run once.
 */

beforeEach(() => {
  invalidateSharedLoad();
});

describe('sharedLoad', () => {
  it('runs the loader ONCE for several callers of the same key', async () => {
    const loader = vi.fn().mockResolvedValue('reading');

    const [a, b, c] = await Promise.all([
      sharedLoad('weather', loader),
      sharedLoad('weather', loader),
      sharedLoad('weather', loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(['reading', 'reading', 'reading']);
  });

  it('keeps different keys apart', async () => {
    const weather = vi.fn().mockResolvedValue('w');
    const route = vi.fn().mockResolvedValue('r');
    await Promise.all([sharedLoad('weather', weather), sharedLoad('route', route)]);
    expect(weather).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('serves a later caller from the cache while the entry is fresh', async () => {
    const loader = vi.fn().mockResolvedValue('reading');
    await sharedLoad('weather', loader);
    await sharedLoad('weather', loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches a rejection, so Retry genuinely retries', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('nws_503'))
      .mockResolvedValue('reading');

    await expect(sharedLoad('weather', loader)).rejects.toThrow('nws_503');
    await expect(sharedLoad('weather', loader)).resolves.toBe('reading');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('re-loads once the entry has gone stale, so a card left open is not frozen', async () => {
    const loader = vi.fn().mockResolvedValue('reading');
    await sharedLoad('weather', loader, 0);
    await sharedLoad('weather', loader, 0);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('drops one key on demand without clearing the rest', async () => {
    const weather = vi.fn().mockResolvedValue('w');
    const route = vi.fn().mockResolvedValue('r');
    await sharedLoad('weather', weather);
    await sharedLoad('route', route);

    invalidateSharedLoad('weather');
    await sharedLoad('weather', weather);
    await sharedLoad('route', route);

    expect(weather).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledTimes(1);
  });
});
