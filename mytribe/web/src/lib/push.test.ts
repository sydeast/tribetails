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

  // #1550: nothing threw, so there is no code or error, but the outcome carries
  // the same browser snapshot as the error branch so the walk can see it.
  it('registerForPush returns no-service-worker with a browser snapshot when the app shell worker never registered (#1550)', async () => {
    setNotificationPermission('granted');
    setServiceWorkerRegistration(null);
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({
      status: 'no-service-worker',
      diagnostics: { permission: 'granted', serviceWorker: 'none', vapidKeySet: true },
    });
    expect(registerFcmToken).not.toHaveBeenCalled();
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

  it('registerForPush surfaces a thrown error rather than swallowing it, naming the stage that threw', async () => {
    vi.mocked(getToken).mockRejectedValue(new Error('network down'));
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toMatchObject({
      status: 'error',
      message: 'network down',
      code: 'Error',
      stage: 'token',
    });
  });

  // #1547: the 2026-11-04 walk lost everything but the message. The error
  // outcome now carries the FCM code, the stage, the thrown value (for Sentry)
  // and a snapshot of the browser state, with no token and no key material.
  it('registerForPush carries the FCM error code and a browser snapshot when getToken throws a FirebaseError (#1547)', async () => {
    setNotificationPermission('granted');
    setServiceWorkerRegistration({ active: {}, showNotification: vi.fn() });
    const fcmError = Object.assign(new Error('Request timed out.'), { code: 'messaging/token-subscribe-failed' });
    vi.mocked(getToken).mockRejectedValue(fcmError);
    const { registerForPush } = await import('./push');

    const outcome = await registerForPush();

    expect(outcome).toMatchObject({
      status: 'error',
      message: 'Request timed out.',
      code: 'messaging/token-subscribe-failed',
      stage: 'token',
      diagnostics: { permission: 'granted', serviceWorker: 'active', vapidKeySet: true },
    });
    expect((outcome as { error: unknown }).error).toBe(fcmError);
    expect(registerFcmToken).not.toHaveBeenCalled();
  });

  it('registerForPush names the permission stage when the prompt itself throws (#1547)', async () => {
    globalThis.Notification.requestPermission = vi.fn().mockRejectedValue(new TypeError('prompt blocked'));
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toMatchObject({
      status: 'error',
      code: 'TypeError',
      stage: 'permission',
      diagnostics: { serviceWorker: 'none' },
    });
  });

  it('registerForPush names the service-worker stage when getRegistration rejects (#1547)', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockRejectedValue(new Error('worker lookup failed')) },
    });
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toMatchObject({
      status: 'error',
      message: 'worker lookup failed',
      stage: 'service-worker',
      diagnostics: { serviceWorker: 'none' },
    });
  });

  it('registerForPush names the register stage and the callable code when the backend call fails (#1547)', async () => {
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    vi.mocked(registerFcmToken).mockRejectedValueOnce(Object.assign(new Error('internal'), { code: 'functions/internal' }));
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toMatchObject({
      status: 'error',
      code: 'functions/internal',
      stage: 'register',
    });
  });

  it('registerForPush reports an empty token as its own code at the token stage (#1547)', async () => {
    vi.mocked(getToken).mockResolvedValue('');
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toMatchObject({
      status: 'error',
      message: 'No token returned.',
      code: 'no-token',
      stage: 'token',
    });
    expect(registerFcmToken).not.toHaveBeenCalled();
  });

  it('registerForPush reports a waiting or installing service worker as such in the snapshot (#1547)', async () => {
    vi.mocked(getToken).mockRejectedValue(new Error('x'));
    const { registerForPush } = await import('./push');

    setServiceWorkerRegistration({ waiting: {}, showNotification: vi.fn() });
    await expect(registerForPush()).resolves.toMatchObject({ diagnostics: { serviceWorker: 'waiting' } });

    setServiceWorkerRegistration({ installing: {}, showNotification: vi.fn() });
    await expect(registerForPush()).resolves.toMatchObject({ diagnostics: { serviceWorker: 'installing' } });
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
