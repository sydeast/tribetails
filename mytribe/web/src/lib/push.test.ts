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

function setServiceWorkerRegistration(
  reg: unknown,
  extra: { register?: unknown; ready?: unknown } = {},
) {
  const container = {
    getRegistration: vi.fn().mockResolvedValue(reg),
    // Default: registering the app-shell worker is impossible in this browser.
    register: vi.fn().mockRejectedValue(new Error('register blocked')),
    ready: Promise.resolve(reg),
    ...extra,
  };
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { configurable: true, value: container });
  return container;
}

describe('push', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
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

  // #1547 (a): click-time lookup waits for an active worker and registers one when absent.
  it('registerForPush registers the app-shell worker when none is registered, then uses it (#1547)', async () => {
    setNotificationPermission('granted');
    const registered = { active: {}, showNotification: vi.fn() };
    const container = setServiceWorkerRegistration(undefined, { register: vi.fn().mockResolvedValue(registered) });
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'registered' });
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(getToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serviceWorkerRegistration: registered }),
    );
  });
  it('registerForPush waits on serviceWorker.ready when the worker is still installing (#1547)', async () => {
    setNotificationPermission('granted');
    const installing = { installing: {}, showNotification: vi.fn() };
    const active = { active: {}, showNotification: vi.fn() };
    setServiceWorkerRegistration(installing, { ready: Promise.resolve(active) });
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { registerForPush } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'registered' });
    expect(getToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serviceWorkerRegistration: active }),
    );
  });
  it('registerForPush does not touch ready or register when a worker is already active (#1547)', async () => {
    setNotificationPermission('granted');
    const reg = { active: {}, showNotification: vi.fn() };
    const container = setServiceWorkerRegistration(reg);
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { registerForPush } = await import('./push');
    await registerForPush();
    expect(container.register).not.toHaveBeenCalled();
  });
  // #1547 (b): every stage ends in a coded, named error instead of a hang.
  it('registerForPush ends a worker that never becomes ready in push/service-worker-timeout (#1547)', async () => {
    vi.useFakeTimers();
    setNotificationPermission('granted');
    setServiceWorkerRegistration({ installing: {}, showNotification: vi.fn() }, { ready: new Promise(() => undefined) });
    const { registerForPush, PUSH_TIMEOUTS_MS } = await import('./push');
    const pending = registerForPush();
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUTS_MS.serviceWorker);
    await expect(pending).resolves.toMatchObject({
      status: 'error',
      code: 'push/service-worker-timeout',
      stage: 'service-worker',
    });
    expect(getToken).not.toHaveBeenCalled();
  });
  it('registerForPush ends a getToken that never settles in push/token-timeout (#1547)', async () => {
    vi.useFakeTimers();
    setNotificationPermission('granted');
    setServiceWorkerRegistration({ active: {}, showNotification: vi.fn() });
    vi.mocked(getToken).mockReturnValue(new Promise(() => undefined));
    const { registerForPush, PUSH_TIMEOUTS_MS } = await import('./push');
    const pending = registerForPush();
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUTS_MS.token);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      status: 'error',
      code: 'push/token-timeout',
      stage: 'token',
      diagnostics: { serviceWorker: 'active' },
    });
    expect((outcome as { message: string }).message).toContain('token step');
    expect(registerFcmToken).not.toHaveBeenCalled();
  });
  it('registerForPush ends a callable that never answers in push/register-timeout (#1547)', async () => {
    vi.useFakeTimers();
    setNotificationPermission('granted');
    setServiceWorkerRegistration({ active: {}, showNotification: vi.fn() });
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    vi.mocked(registerFcmToken).mockReturnValueOnce(new Promise(() => undefined));
    const { registerForPush, PUSH_TIMEOUTS_MS } = await import('./push');
    const pending = registerForPush();
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUTS_MS.register);
    await expect(pending).resolves.toMatchObject({ status: 'error', code: 'push/register-timeout', stage: 'register' });
  });
  it('registerForPush ends a permission prompt that never resolves in push/permission-timeout (#1547)', async () => {
    vi.useFakeTimers();
    setNotificationPermission('default');
    globalThis.Notification.requestPermission = vi.fn().mockReturnValue(new Promise(() => undefined));
    const { registerForPush, PUSH_TIMEOUTS_MS } = await import('./push');
    const pending = registerForPush();
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUTS_MS.permission);
    await expect(pending).resolves.toMatchObject({ status: 'error', code: 'push/permission-timeout', stage: 'permission' });
  });
  it('registerForPush does not report a timeout when a step finishes in time (#1547)', async () => {
    vi.useFakeTimers();
    setNotificationPermission('granted');
    setServiceWorkerRegistration({ active: {}, showNotification: vi.fn() });
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { registerForPush, PUSH_TIMEOUTS_MS } = await import('./push');
    await expect(registerForPush()).resolves.toEqual({ status: 'registered' });
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUTS_MS.permission);
    expect(vi.getTimerCount()).toBe(0);
  });
  // #1787: silent registration on sign-in.
  it('refreshPushRegistration registers silently when permission is already granted, once per sign-in', async () => {
    setNotificationPermission('granted');
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { refreshPushRegistration } = await import('./push');
    await expect(refreshPushRegistration()).resolves.toEqual({ status: 'registered' });
    await expect(refreshPushRegistration()).resolves.toEqual({ status: 'registered' });
    expect(registerFcmToken).toHaveBeenCalledTimes(1);
    expect(registerFcmToken).toHaveBeenCalledWith('a-device-token');
  });
  it('refreshPushRegistration never prompts and never registers when permission is default or denied', async () => {
    const requestPermission = vi.fn();
    Object.defineProperty(globalThis.Notification, 'requestPermission', { configurable: true, value: requestPermission });
    const { refreshPushRegistration } = await import('./push');
    setNotificationPermission('default');
    await refreshPushRegistration();
    setNotificationPermission('denied');
    await refreshPushRegistration();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(registerFcmToken).not.toHaveBeenCalled();
  });
  it('refreshPushRegistration returns the coded error, does not rerun it, and a Retry replaces the answer', async () => {
    setNotificationPermission('granted');
    vi.mocked(getToken).mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'messaging/token-subscribe-failed' }));
    const { refreshPushRegistration, registerForPush } = await import('./push');
    const first = await refreshPushRegistration();
    expect(first).toMatchObject({ status: 'error', code: 'messaging/token-subscribe-failed', stage: 'token' });
    await refreshPushRegistration();
    expect(getToken).toHaveBeenCalledTimes(1);
    vi.mocked(getToken).mockResolvedValue('later-token');
    await expect(registerForPush()).resolves.toEqual({ status: 'registered' });
    await expect(refreshPushRegistration()).resolves.toEqual({ status: 'registered' });
    expect(getToken).toHaveBeenCalledTimes(2);
  });
  it('unregisterForPush on sign-out lets the next sign-in register again', async () => {
    setNotificationPermission('granted');
    vi.mocked(getToken).mockResolvedValue('a-device-token');
    const { refreshPushRegistration, unregisterForPush } = await import('./push');
    await refreshPushRegistration();
    await expect(unregisterForPush()).resolves.toBeUndefined();
    expect(unregisterFcmToken).toHaveBeenCalledWith('a-device-token');
    await refreshPushRegistration();
    expect(registerFcmToken).toHaveBeenCalledTimes(2);
  });
  it('a registration still in flight at sign-out does not seed the next sign-in', async () => {
    setNotificationPermission('granted');
    let release: (t: string) => void = () => {};
    vi.mocked(getToken).mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const { refreshPushRegistration, unregisterForPush } = await import('./push');
    const inFlight = refreshPushRegistration();
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled());
    await unregisterForPush();
    release('stale-token');
    await inFlight;
    vi.mocked(getToken).mockResolvedValue('fresh-token');
    await refreshPushRegistration();
    expect(registerFcmToken).toHaveBeenLastCalledWith('fresh-token');
  });
  // #1808: what Notification Settings reads to draw "on" without a signing-up frame.
  it('settledPushRegistration is null while the sign-up runs, the answer once it lands, and null after sign-out', async () => {
    setNotificationPermission('granted');
    let release: (t: string) => void = () => {};
    vi.mocked(getToken).mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const { refreshPushRegistration, settledPushRegistration, unregisterForPush } = await import('./push');
    expect(settledPushRegistration()).toBeNull();
    const inFlight = refreshPushRegistration();
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled());
    expect(settledPushRegistration()).toBeNull();
    release('a-device-token');
    await inFlight;
    expect(settledPushRegistration()).toEqual({ status: 'registered' });
    await unregisterForPush();
    expect(settledPushRegistration()).toBeNull();
  });
  it('settledPushRegistration keeps a failure, and a Retry that works replaces it', async () => {
    setNotificationPermission('granted');
    vi.mocked(getToken).mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'messaging/token-subscribe-failed' }));
    const { refreshPushRegistration, registerForPush, settledPushRegistration } = await import('./push');
    await refreshPushRegistration();
    expect(settledPushRegistration()).toMatchObject({ status: 'error', code: 'messaging/token-subscribe-failed' });
    vi.mocked(getToken).mockResolvedValue('later-token');
    await registerForPush();
    expect(settledPushRegistration()).toEqual({ status: 'registered' });
  });
  it('a sign-up that finishes after sign-out leaves nothing settled for the next sign-in', async () => {
    setNotificationPermission('granted');
    let release: (t: string) => void = () => {};
    vi.mocked(getToken).mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const { refreshPushRegistration, settledPushRegistration, unregisterForPush } = await import('./push');
    const inFlight = refreshPushRegistration();
    await vi.waitFor(() => expect(getToken).toHaveBeenCalled());
    await unregisterForPush();
    release('stale-token');
    await inFlight;
    expect(settledPushRegistration()).toBeNull();
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
