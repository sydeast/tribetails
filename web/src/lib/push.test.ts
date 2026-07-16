// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, deleteToken, isSupported } from 'firebase/messaging';
import { registerFcmToken, unregisterFcmToken } from '../api/pushApi';

vi.mock('./firebase', () => ({ app: {} }));
vi.mock('../api/pushApi', () => ({
  registerFcmToken: vi.fn().mockResolvedValue({ ok: true }),
  unregisterFcmToken: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('firebase/messaging', () => ({
  getMessaging: vi.fn().mockReturnValue({}),
  getToken: vi.fn(),
  deleteToken: vi.fn().mockResolvedValue(true),
  onMessage: vi.fn(),
  isSupported: vi.fn(),
}));

function setNotificationPermission(permission: NotificationPermission | undefined) {
  if (permission === undefined) {
    delete (globalThis as { Notification?: unknown }).Notification;
    return;
  }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: {
      permission,
      requestPermission: vi.fn().mockResolvedValue(permission === 'default' ? 'granted' : permission),
    },
  });
}

function setServiceWorkerRegistration(reg: unknown) {
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(reg) },
  });
}

describe('push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNotificationPermission('default');
    setServiceWorkerRegistration({ showNotification: vi.fn() });
    vi.mocked(isSupported).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('isPushSupported is false when Notification is unavailable in this browser', async () => {
    setNotificationPermission(undefined);
    const { isPushSupported } = await import('./push');
    await expect(isPushSupported()).resolves.toBe(false);
  });

  it('registerForPush returns unsupported when the browser lacks FCM support', async () => {
    vi.mocked(isSupported).mockResolvedValue(false);
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'unsupported' });
    expect(registerFcmToken).not.toHaveBeenCalled();
  });

  it('registerForPush returns denied without re-prompting when permission was already denied', async () => {
    setNotificationPermission('denied');
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'denied' });
    expect(globalThis.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('registerForPush prompts once when permission is undecided and returns denied if the user declines', async () => {
    setNotificationPermission('default');
    globalThis.Notification.requestPermission = vi.fn().mockResolvedValue('denied');
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'denied' });
    expect(registerFcmToken).not.toHaveBeenCalled();
  });

  it('registerForPush returns no-service-worker when the app shell worker never registered', async () => {
    setServiceWorkerRegistration(null);
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'no-service-worker' });
  });

  it('registerForPush registers the token with the backend and reuses the app-shell SW registration', async () => {
    const swReg = { showNotification: vi.fn() };
    setServiceWorkerRegistration(swReg);
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { registerForPush } = await import('./push');

    await expect(registerForPush()).resolves.toEqual({ status: 'registered' });

    expect(getToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serviceWorkerRegistration: swReg }),
    );
    expect(registerFcmToken).toHaveBeenCalledWith('a-device-token');
  });

  it('registerForPush surfaces a thrown error rather than swallowing it', async () => {
    vi.mocked(getToken).mockRejectedValue(new Error('network down'));
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'error', message: 'network down' });
  });

  it('unregisterForPush unregisters the current token and never throws', async () => {
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { unregisterForPush } = await import('./push');
    await expect(unregisterForPush()).resolves.toBeUndefined();
    expect(unregisterFcmToken).toHaveBeenCalledWith('a-device-token');
    expect(deleteToken).toHaveBeenCalled();
  });

  it('unregisterForPush no-ops cleanly when push was never supported', async () => {
    vi.mocked(isSupported).mockResolvedValue(false);
    const { unregisterForPush } = await import('./push');
    await expect(unregisterForPush()).resolves.toBeUndefined();
    expect(unregisterFcmToken).not.toHaveBeenCalled();
  });
});
