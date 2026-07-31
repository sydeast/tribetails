import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getFeatureFlags, setFeatureFlags } from './featureFlags';
import { DEFAULTS, KEY_COMMUNICATE_BROADCAST, KEY_COMMUNICATE_COMMS_RECAP } from '../lib/featureFlagsCatalog';

beforeEach(() => call.mockReset());

describe('featureFlags api', () => {
  it('getFeatureFlags merges the { flags } envelope onto the catalog defaults', async () => {
    call.mockResolvedValue({ flags: { [KEY_COMMUNICATE_COMMS_RECAP]: true } });
    const flags = await getFeatureFlags();
    expect(call).toHaveBeenCalledWith('getFeatureFlags', {});
    expect(flags).toEqual({ ...DEFAULTS, [KEY_COMMUNICATE_COMMS_RECAP]: true });
  });

  it('getFeatureFlags returns the catalog defaults when the callable returns no flags', async () => {
    call.mockResolvedValue({});
    expect(await getFeatureFlags()).toEqual(DEFAULTS);
  });

  // The 2026-06-08 prod regression the Kotlin registries carry a fix for: a
  // stale remote `false` on an ALWAYS_ON flag must never win. Proven here at
  // the api-layer wiring, not just inside fromOverrides itself, since this is
  // what a real getFeatureFlags() caller actually observes.
  it('getFeatureFlags keeps an ALWAYS_ON flag on even when the server sends a stale false', async () => {
    call.mockResolvedValue({ flags: { [KEY_COMMUNICATE_BROADCAST]: false } });
    const flags = await getFeatureFlags();
    expect(flags[KEY_COMMUNICATE_BROADCAST]).toBe(true);
  });

  it('setFeatureFlags sends { flags } and returns the written map', async () => {
    call.mockResolvedValue({ ok: true, flags: { 'auntieos.communicate.commsRecap': false } });
    const res = await setFeatureFlags({ 'auntieos.communicate.commsRecap': false });
    expect(call).toHaveBeenCalledWith('setFeatureFlags', {
      flags: { 'auntieos.communicate.commsRecap': false },
    });
    expect(res).toEqual({ 'auntieos.communicate.commsRecap': false });
  });

});
