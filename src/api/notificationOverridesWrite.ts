import { call } from '../lib/fns';
import { encodeOverridePayload, type WireOverride } from '../lib/notificationGateEdit';
import type { NotificationOverride } from './myNotifications';

/**
 * The write half of the BUSINESS notification gate matrix. `getNotificationMatrix`
 * (api/myNotifications.ts) reads the catalog + saved overrides; this saves one
 * key's override, and reverts one key to its catalog default. It is the operator
 * setting the GATE (which channels each notification offers, and whether any are
 * locked on), distinct from `myNotificationsWrite.ts` which saves the operator's
 * OWN receive prefs.
 *
 * Both callables already exist and are DEPLOYED in MyTribe
 * (functions/src/admin/notificationOverrides.ts, admin-gated via
 * wrapAdminCallable, tested in functions/test/notificationOverrides.test.ts): no
 * new backend. The payload is encoded by `encodeOverridePayload` to match the
 * `saveBusinessNotificationOverride` zod schema exactly (literal-true lock maps,
 * `lockReason: ""` as the explicit clear, per-stream overlays), the same wire
 * shape the wasm `CloudNotificationOverridesRepository` sends.
 *
 * Fail-loud by construction: `call()` (lib/fns.ts) surfaces a rejected callable
 * as a rejected promise, never a swallowed failure, so the gate screen must catch
 * and show it (it does: an inline error banner plus a reload to server truth).
 */

/** Persist one catalog key's business gate override. */
export async function saveBusinessNotificationOverride(
  key: string,
  override: NotificationOverride,
): Promise<void> {
  await call<{ key: string; override: WireOverride }, { ok: true; key: string }>(
    'saveBusinessNotificationOverride',
    { key, override: encodeOverridePayload(override) },
  );
}

/** Revert one catalog key to its catalog default (removes the stored override). */
export async function deleteBusinessNotificationOverride(key: string): Promise<void> {
  await call<{ key: string }, { ok: true; key: string }>('deleteBusinessNotificationOverride', { key });
}
