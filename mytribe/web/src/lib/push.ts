import { getMessaging, getToken, deleteToken, onMessage, isSupported } from 'firebase/messaging';
import { app } from './firebase';
import { registerFcmToken, unregisterFcmToken } from '../api/pushApi';

/**
 * Web Push (VAPID) application server key for project auntieos-ttpc.
 * Same key already provisioned for the Kotlin/JS reference build
 * (src/jsMain/kotlin/com/kinfolk/portal/push/PushToken.js.kt) — Firebase
 * console > Project settings > Cloud Messaging > Web Push certificates.
 * Public key, not a secret.
 */
const VAPID_KEY = 'BAlfcLT9_cF4Bvd-VSFQkrNIKoKvLXSYuC5zP_Rq2L4l1IRsXBIafs3sOZji8E-uidHRbQhKRWcvAamMV5s12M4';

let foregroundHandlerInstalled = false;
let cachedToken: string | null = null;

/** Whether this browser can support web push at all (feature + secure-context check). */
export async function isPushSupported(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  try {
    return await isSupported();
  } catch {
    return false;
  }
}

/**
 * Foreground messages: while the app has an open, focused tab, FCM delivers
 * `onMessage` directly instead of a 'push' event — the service worker's raw
 * push handler (src/sw.ts) never fires for a foregrounded tab. Surface a
 * system notification anyway (mirrors the Android KinfolkFcmService and the
 * Kotlin/JS reference) rather than silently dropping it, since the portal has
 * no in-app toast surface for arbitrary catalog pushes. Same `tag` convention
 * as sw.ts's push handler so a message that somehow fires both paths
 * replaces rather than duplicates.
 */
function installForegroundHandler(
  messaging: ReturnType<typeof getMessaging>,
  swReg: ServiceWorkerRegistration,
): void {
  if (foregroundHandlerInstalled) return;
  foregroundHandlerInstalled = true;
  onMessage(messaging, (payload) => {
    const title = payload.notification?.title ?? payload.data?.['notificationKey'] ?? 'MyTribe';
    const body = payload.notification?.body ?? '';
    const tag = payload.messageId ?? payload.data?.['notificationKey'];
    void swReg.showNotification(title, {
      body,
      icon: '/icon-192.png',
      ...(tag ? { tag } : {}),
      data: { route: payload.data?.['route'] },
    });
  });
}

/** Which step of [registerForPush] threw. */
export type PushFailureStage = 'permission' | 'service-worker' | 'token' | 'register';

/** The app-shell service worker's lifecycle state at the moment of failure. */
export type ServiceWorkerState = 'active' | 'waiting' | 'installing' | 'none';

/**
 * Snapshot taken when registration fails, so the console line and the Sentry
 * event can say what the browser looked like at that moment (#1547). Nothing
 * here is a secret: no token value, no key material, just states.
 */
export type PushFailureDiagnostics = {
  permission: NotificationPermission | 'unsupported';
  serviceWorker: ServiceWorkerState;
  vapidKeySet: boolean;
};

export type PushRegistrationOutcome =
  | { status: 'registered' }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'no-service-worker' }
  | {
      status: 'error';
      message: string;
      /** FCM error code (`messaging/token-subscribe-failed`, ...) or the error name when there is none. */
      code: string;
      stage: PushFailureStage;
      /** The thrown value, for Sentry; never rendered. */
      error: unknown;
      diagnostics: PushFailureDiagnostics;
    };

/**
 * FirebaseError carries the FCM code on `.code` (`messaging/...`); a plain
 * Error has only a name. `err instanceof Error` does not expose `.code` to
 * TypeScript, hence the structural check.
 */
function errorCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  if (err instanceof Error && err.name) return err.name;
  return 'unknown';
}

function serviceWorkerStateOf(reg: ServiceWorkerRegistration | null | undefined): ServiceWorkerState {
  if (!reg) return 'none';
  if (reg.active) return 'active';
  if (reg.waiting) return 'waiting';
  if (reg.installing) return 'installing';
  return 'none';
}

/** getToken resolved with an empty string: no throw, no token, nothing to register. */
class NoTokenError extends Error {
  readonly code = 'no-token';
  constructor() {
    super('No token returned.');
    this.name = 'NoTokenError';
  }
}

function failure(
  err: unknown,
  stage: PushFailureStage,
  swReg: ServiceWorkerRegistration | null | undefined,
): PushRegistrationOutcome {
  return {
    status: 'error',
    message: err instanceof Error ? err.message : String(err),
    code: errorCodeOf(err),
    stage,
    error: err,
    diagnostics: {
      permission: currentPushPermission(),
      serviceWorker: serviceWorkerStateOf(swReg),
      vapidKeySet: VAPID_KEY.length > 0,
    },
  };
}

/**
 * Requests Notification permission (if not already decided) and registers
 * this browser's FCM token with the backend. Only ever call this from an
 * explicit user action (e.g. a banner's "Enable notifications" button) —
 * never on app boot, so the native permission prompt can't ambush a kinfolk
 * on first paint (same rule PushRegistrationCoordinator.kt documents for the
 * Kotlin build).
 *
 * Reuses the app-shell service worker (src/sw.ts, registered by vite-plugin-pwa)
 * via `serviceWorkerRegistration` rather than letting the SDK auto-register
 * its own firebase-messaging-sw.js — see vite.config.ts's comment for why.
 *
 * An error outcome names the step that threw and the FCM code (#1547): the
 * 2026-11-04 walk saw this fail before the server was reached, and a bare
 * message was all that survived. `stage` is advanced before each await so the
 * catch knows where it was.
 */
export async function registerForPush(): Promise<PushRegistrationOutcome> {
  let stage: PushFailureStage = 'permission';
  let swReg: ServiceWorkerRegistration | null | undefined;
  try {
    if (!(await isPushSupported())) return { status: 'unsupported' };

    if (Notification.permission === 'denied') return { status: 'denied' };
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return { status: 'denied' };
    }

    // getRegistration() (not .ready) so a failed/absent registration resolves
    // to null instead of suspending forever.
    stage = 'service-worker';
    swReg = await navigator.serviceWorker.getRegistration();
    if (!swReg) return { status: 'no-service-worker' };

    stage = 'token';
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) return failure(new NoTokenError(), 'token', swReg);

    stage = 'register';
    cachedToken = token;
    await registerFcmToken(token);
    installForegroundHandler(messaging, swReg);
    return { status: 'registered' };
  } catch (err) {
    return failure(err, stage, swReg);
  }
}

/**
 * Best-effort: unregisters the current device's token from the backend and
 * revokes it client-side. Called on sign-out (src/lib/auth.ts) so a shared/
 * public device doesn't keep receiving another kinfolk's pushes after
 * sign-out. Never throws — sign-out must not be blocked by push cleanup.
 */
export async function unregisterForPush(): Promise<void> {
  try {
    if (!(await isPushSupported())) return;
    const swReg = await navigator.serviceWorker.getRegistration();
    if (!swReg) return;
    const messaging = getMessaging(app);
    const token = cachedToken ?? (await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg }).catch(() => null));
    if (!token) return;
    await unregisterFcmToken(token).catch(() => undefined);
    await deleteToken(messaging).catch(() => undefined);
    cachedToken = null;
  } catch {
    // Best-effort; sign-out proceeds regardless.
  }
}

/** Current permission state, for UI to decide whether to show the enable-push prompt at all. */
export function currentPushPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}
