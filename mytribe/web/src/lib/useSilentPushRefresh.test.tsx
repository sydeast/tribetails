// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
const refreshPushRegistration = vi.fn();
vi.mock('./push', () => ({ refreshPushRegistration: (...a: unknown[]) => refreshPushRegistration(...a) }));
import { useSilentPushRefresh } from './useSilentPushRefresh';
function setPermission(value: NotificationPermission | 'missing') {
  if (value === 'missing') {
    vi.stubGlobal('Notification', undefined);
    return;
  }
  vi.stubGlobal('Notification', { permission: value });
}
describe('useSilentPushRefresh (#1787)', () => {
  beforeEach(() => {
    refreshPushRegistration.mockReset().mockResolvedValue({ status: 'registered' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('registers quietly when the browser already allowed notifications', async () => {
    setPermission('granted');
    renderHook(() => useSilentPushRefresh());
    await waitFor(() => expect(refreshPushRegistration).toHaveBeenCalledTimes(1));
  });
  it.each(['default', 'denied'] as const)('does nothing when permission is %s', async (permission) => {
    setPermission(permission);
    renderHook(() => useSilentPushRefresh());
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshPushRegistration).not.toHaveBeenCalled();
  });
  it('does nothing in a browser with no Notification API', async () => {
    setPermission('missing');
    renderHook(() => useSilentPushRefresh());
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshPushRegistration).not.toHaveBeenCalled();
  });
  it('swallows a failed registration so a screen never breaks on it', async () => {
    setPermission('granted');
    refreshPushRegistration.mockRejectedValue(new Error('nope'));
    renderHook(() => useSilentPushRefresh());
    await waitFor(() => expect(refreshPushRegistration).toHaveBeenCalled());
  });
});
