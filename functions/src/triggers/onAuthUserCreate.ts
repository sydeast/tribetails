import { auth } from 'firebase-functions/v1';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { wrapTrigger } from '../lib/wrapTrigger';

// v1 auth trigger has no `runWith` config in this codebase; SENTRY_DSN must be
// available via the Functions runtime config (set via `firebase functions:secrets:set`).
export const onAuthUserCreate = auth.user().onCreate(
  wrapTrigger('onAuthUserCreate', async (user) => {
    // NEVER write kinfolkIds here. This trigger fires async after createUser
    // and can land AFTER acceptInvite's transaction (observed 2026-06-12:
    // claim flow stomped to []). Membership is owned solely by acceptInvite;
    // getMyAccess treats a missing field as [].
    await db().doc(`clients/${user.uid}`).set(
      {
        email: user.email ?? null,
        // Never seed displayName with the email — that surfaces the email in the
        // "First & Last Name" field until the user overwrites it. Leave it null;
        // the client shows the email only as a fallback label, never stored.
        displayName: user.displayName ?? null,
        avatarUrl: user.photoURL ?? null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }),
);
