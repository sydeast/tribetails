import { call } from '../lib/fns';
import type { AdminNotificationPrefs } from './myNotifications';

/**
 * The write half of `api/myNotifications.ts`'s `getMyNotificationPrefs`: saves
 * the operator's OWN receive prefs back to `staff/{uid}.notificationPrefs` via
 * `saveMyAdminNotificationPrefs` (MyTribe/functions/src/admin/
 * myAdminNotificationPrefs.ts). Confirmed against the deployed handler and its
 * shared zod contract (notifications/prefsSchema.ts `SaveArgs`): the payload is
 * exactly `{ prefs }`, where `prefs` is the same `{ byKey, byCategory,
 * marketingOptIn }` shape the read side already decodes, so no new wire type is
 * needed here; `AdminNotificationPrefs` (with its `{}` defaults) already
 * satisfies the schema's optional-record fields.
 *
 * The uid is never sent: `saveMyAdminNotificationPrefsHandler` writes the
 * CALLER's own staff doc from `req.auth.uid` server-side, mirroring the read
 * side's doc comment. wrapAdminCallable auth-gates it; a signed-out or
 * non-admin caller gets a callable error, which `call()` (lib/fns.ts) surfaces
 * as a rejected promise, not a swallowed failure, so this stays fail-loud by
 * construction: callers must catch and show it, never assume success.
 */
export async function saveMyAdminNotificationPrefs(prefs: AdminNotificationPrefs): Promise<void> {
  await call<{ prefs: AdminNotificationPrefs }, { ok: true }>('saveMyAdminNotificationPrefs', { prefs });
}
