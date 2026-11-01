import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import type { UserNotificationPrefs } from '../notifications/types';
import { applyPrefsPatch, prefsSetOptions, PortalSaveArgs } from '../notifications/prefsSchema';
import { withAliasedChoicesResolved } from '../notifications/prefs';
import { TRIBETAILS_CORS } from '../lib/cors';
import { refuseAuntie } from '../lib/staffGate';

/**
 * Hybrid notification preferences.
 *
 * Schema (matches notifications/types.ts UserNotificationPrefs):
 *   byCategory:     per-category select-all defaults (UI row toggle)
 *   byKey:          per-key granular overrides (UI expand)
 *   marketingOptIn: per marketingCategory consent (newsletter / survey / marketing)
 *
 * Stored at `clients/{uid}.notificationPrefs` for kinfolk.
 * Staff/admin prefs use the same shape at `staff/{uid}.notificationPrefs`.
 */
interface PrefsDto {
  prefs: UserNotificationPrefs;
  updatedAtMs: number | null;
}

export async function getMyNotificationPrefsHandler(
  req: CallableRequest<unknown>,
): Promise<PrefsDto> {
  refuseAuntie(req.auth, 'getMyNotificationPrefs'); // docket Q1: an Auntie never uses the portal
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const data = clientSnap.data() ?? {};
  // #501: aliases resolved here, not in each client. A choice stored under a
  // retired key is honored by `resolveChannels` and invisible to every screen
  // that looks the canonical key up, so the screen draws ON while the
  // dispatcher sends nothing. See withAliasedChoicesResolved.
  const prefs = withAliasedChoicesResolved(
    (data['notificationPrefs'] as UserNotificationPrefs | undefined) ?? {},
  );
  const ts = data['notificationPrefsUpdatedAt'];
  const updatedAtMs =
    ts && typeof (ts as { toMillis?: () => number }).toMillis === 'function'
      ? (ts as { toMillis(): number }).toMillis()
      : null;

  return { prefs, updatedAtMs };
}

export async function saveMyNotificationPrefsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  refuseAuntie(req.auth, 'saveMyNotificationPrefs'); // docket Q1: an Auntie never uses the portal
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = PortalSaveArgs.parse(req.data);
  const firestore = db();
  if (args.patch) {
    // #1292: one toggle, one patch. Read-merge-write in a transaction so two
    // taps (or two devices) cannot overwrite each other's choice, and so the
    // write never rebuilds the subtree from one screen's partial state.
    const patch = args.patch;
    const ref = firestore.collection('clients').doc(uid);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = (snap.data()?.['notificationPrefs'] as UserNotificationPrefs | undefined) ?? undefined;
      tx.set(
        ref,
        {
          notificationPrefs: applyPrefsPatch(existing, patch),
          notificationPrefsUpdatedAt: FieldValue.serverTimestamp(),
        },
        prefsSetOptions(),
      );
    });
    logEvent({ severity: 'info', function: 'saveMyNotificationPrefs', event: 'portal.prefs.patched', uid });
    return { ok: true };
  }
  // prefsSetOptions(), not { merge: true }: the client sends the whole prefs
  // object, and clearing a per-key override means the entry is ABSENT from it.
  // A merge set would leave the stale entry on the server. See prefsSchema.ts.
  await firestore.collection('clients').doc(uid).set(
    {
      notificationPrefs: args.prefs,
      notificationPrefsUpdatedAt: FieldValue.serverTimestamp(),
    },
    prefsSetOptions(),
  );

  logEvent({ severity: 'info', function: 'saveMyNotificationPrefs', event: 'portal.prefs.saved', uid });
  return { ok: true };
}

export const getMyNotificationPrefs = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getMyNotificationPrefs', getMyNotificationPrefsHandler),
);

export const saveMyNotificationPrefs = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('saveMyNotificationPrefs', saveMyNotificationPrefsHandler),
);
