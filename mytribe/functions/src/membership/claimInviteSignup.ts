import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { enforceRateLimit } from '../lib/rateLimit';
import { wrapCallable } from '../lib/wrapCallable';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { InviteRequestDoc } from '../lib/schema';
import { FULL_CPU } from '../lib/runtimeOptions';

/**
 * Public (unauthenticated) account creation for invited kinfolk.
 *
 * This project deliberately sets `disabledUserSignup` so the client SDK
 * cannot mint accounts (auth/admin-restricted-operation). Invited kinfolk
 * still need a first account, so this callable creates it server-side via
 * the Admin SDK — but ONLY when the caller holds a live invite. The account
 * is always created with the invite's email (never caller-supplied), marked
 * verified (the invite link was delivered to that mailbox), and exchanged
 * for a custom token the client signs in with before calling acceptInvite.
 *
 * Existing account for that email -> 'already-exists'; the claim screen
 * flips to sign-in mode.
 */
const Args = z.object({
  inviteId: z.string().min(1).max(200),
  password: z.string().min(8).max(1024),
});

export async function claimInviteSignupHandler(
  req: CallableRequest<unknown>,
): Promise<{ token: string }> {
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'Password needs at least 8 characters.');
    }
    throw err;
  }

  const ip = req.rawRequest?.ip ?? 'unknown';
  await enforceRateLimit('claimSignup', ip, 20, 3600);
  await enforceRateLimit('claimSignup', args.inviteId, 10, 3600);

  const snap = await db().doc(`inviteRequests/${args.inviteId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'invite not found');
  const invite = snap.data() as InviteRequestDoc;
  if (invite.status === 'ACCEPTED' || invite.status === 'REVOKED' || invite.status === 'EXPIRED') {
    throw new HttpsError('failed-precondition', 'invite no longer valid');
  }
  if ((invite.expiresAt as unknown as { toMillis(): number }).toMillis() < Date.now()) {
    throw new HttpsError('failed-precondition', 'invite expired');
  }

  const auth = getAuth();
  const email = invite.invitedEmail.toLowerCase();
  const existing = await auth.getUserByEmail(email).catch((err: { code?: string }) => {
    if (err?.code === 'auth/user-not-found') return null;
    throw err;
  });
  if (existing) {
    throw new HttpsError('already-exists', 'EMAIL_EXISTS');
  }

  const user = await auth.createUser({ email, password: args.password, emailVerified: true });
  const token = await auth.createCustomToken(user.uid);

  logEvent({
    severity: 'info',
    function: 'claimInviteSignup',
    event: 'portal.claim.signup',
    uid: user.uid,
    extra: { inviteId: args.inviteId, tribeId: invite.tribeId },
  });

  return { token };
}

export const claimInviteSignup = onCall(
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('claimInviteSignup', claimInviteSignupHandler),
);
