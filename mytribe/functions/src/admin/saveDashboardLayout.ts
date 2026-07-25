import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * 17.3 Dashboard customization: the operator's OWN Home widget layout.
 *
 * Stored as an ordered list of "key:size" tokens at
 * `users/{uid}.dashboardWidgets`, the same field the android app
 * (`AuntieRepository.saveUserProfile`) and the superseded wasm admin
 * (`FirestoreClient.saveUserProfile`) already read and write. One operator, one
 * field, on every surface, so a layout arranged on the phone opens arranged on
 * the web.
 *
 * WHY A CALLABLE AT ALL, given `firestore.rules:742` grants
 * `match /users/{uid} { allow read, write: if isAuntie(); }`:
 *
 * 1. The rule permits the write but validates nothing. Tokens are a storage
 *    contract three clients parse; a client bug that wrote junk would persist
 *    it, and every surface would then quietly drop the unreadable entries and
 *    show the operator a dashboard they did not arrange. The zod schema below
 *    is the only place that shape is actually enforced.
 * 2. The existing clients write the WHOLE user document (android's
 *    `set(profile)` is a full overwrite, which is why `HomeViewModel` has to
 *    re-read the profile before every layout save so it does not clobber theme
 *    and nav prefs saved elsewhere). This writes one field with `{ merge: true }`,
 *    so the clobber it works around cannot happen here.
 *
 * The handler writes the CALLER's own document (`req.auth.uid`), never a uid
 * from the payload, so an admin can only rearrange their own dashboard.
 *
 * NOTE on the document choice: the implementation plan sketched
 * `staff/{uid}.dashboardWidgets`. It writes `users/{uid}` instead, deliberately.
 * `staff/*` has no `match` block in `firestore.rules`, so it is default-deny to
 * every client, and android reads this value straight off `users/{uid}`. Writing
 * the web's layout to `staff/` would leave the two apps persisting one operator
 * setting in two places that never agree, with no error anywhere to show it.
 *
 * Reads need no callable: `users/{uid}` is already client-readable for an
 * admin, so `auntieos-admin/src/api/dashboardLayout.ts` reads it directly, the
 * same access `api/account.ts` uses for the rest of that document.
 */

/**
 * A layout token is `<key>:<size>`. The key is matched loosely on purpose
 * (`[a-zA-Z]+`, not a fixed key list): clients ship on different cadences, and a
 * newer client's widget must not be rejected by an older server. Every client
 * already drops keys it does not know when parsing. The SIZE is closed, because
 * all three renderers branch on exactly these two values.
 *
 * `.max(30)` caps the list: there are 19 known widgets, so 30 leaves room for
 * growth while keeping an unbounded array off the document.
 */
export const Args = z.object({
  tokens: z.array(z.string().regex(/^[a-zA-Z]+:(compact|wide)$/)).max(30),
});

export type SaveDashboardLayoutArgs = z.infer<typeof Args>;

export async function saveDashboardLayoutHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; tokens: string[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);

  await db().collection('users').doc(uid).set(
    {
      dashboardWidgets: args.tokens,
      dashboardWidgetsUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'saveDashboardLayout',
    event: 'admin.dashboard.layout.saved',
    uid,
    extra: { widgetCount: args.tokens.length },
  });

  // Echo what was stored so the client can reconcile its optimistic order with
  // what the server actually holds, rather than assuming they match.
  return { ok: true, tokens: args.tokens };
}

export const saveDashboardLayout = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveDashboardLayout', saveDashboardLayoutHandler),
);
