/**
 * Wire types + typed wrappers for the S5 web-push callables
 * (functions/src/portal/registerFcmToken.ts). Self-contained, mirrors
 * api/invoicesApi.ts's `call()` pattern.
 */
import { call } from '../lib/fns';

export type FcmPlatform = 'android' | 'web' | 'jvm';

export interface RegisterFcmTokenRequest {
  token: string;
  platform: FcmPlatform;
  appVersion?: string;
}

/** Stores this device's FCM token so scheduled/notification jobs can target it. */
export function registerFcmToken(token: string): Promise<{ ok: true }> {
  const payload: RegisterFcmTokenRequest = { token, platform: 'web' };
  return call<RegisterFcmTokenRequest, { ok: true }>('registerFcmToken', payload);
}

export interface UnregisterFcmTokenRequest {
  token: string;
}

/** Removes this device's FCM token (only deletes if it belongs to the caller). */
export function unregisterFcmToken(token: string): Promise<{ ok: true }> {
  const payload: UnregisterFcmTokenRequest = { token };
  return call<UnregisterFcmTokenRequest, { ok: true }>('unregisterFcmToken', payload);
}
