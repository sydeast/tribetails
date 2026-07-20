import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getFeatureFlags, setFeatureFlags } from './featureFlags';

beforeEach(() => call.mockReset());

describe('featureFlags api', () => {
  it('getFeatureFlags unwraps the { flags } envelope', async () => {
    call.mockResolvedValue({ flags: { 'auntieos.settings.integrationManage': true } });
    const flags = await getFeatureFlags();
    expect(call).toHaveBeenCalledWith('getFeatureFlags', {});
    expect(flags).toEqual({ 'auntieos.settings.integrationManage': true });
  });

  it('getFeatureFlags defaults to {} when the callable returns no flags', async () => {
    call.mockResolvedValue({});
    expect(await getFeatureFlags()).toEqual({});
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
