import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { enforceRateLimit } from '../lib/rateLimit';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { InviteRequestDoc } from '../lib/schema';

/**
 * Public (unauthenticated) preview of an invite for the claim screen.
 *
 * A brand-new kinfolk clicking the welcome email has no account yet, so the
 * claim screen cannot call any authed endpoint before sign-up. This callable
 * lets it greet the invitee and prefill/lock the email field on the
 * create-account (set password) step.
 *
 * Capability model: possession of the inviteId (random Firestore doc id,
 * delivered only to the invited mailbox) is the proof of access — same
 * threshold acceptInvite's email check enforces at claim time. The invited
 * email is only returned while the invite is still claimable; expired /
 * claimed / revoked / unknown ids reveal nothing but that status.
 */
const Args = z.object({ inviteId: z.string().min(1).max(200) });

export type InvitePreviewResult =
  | { status: 'valid'; invitedEmail: string; tribeName: string }
  | { status: 'not_found' | 'expired' | 'claimed' | 'revoked' };

export async function getInvitePreviewHandler(
  req: CallableRequest<unknown>,
): Promise<InvitePreviewResult> {
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'inviteId is required');
    }
    throw err;
  }

  const ip = req.rawRequest?.ip ?? 'unknown';
  await enforceRateLimit('invitePreview', ip, 60, 3600);

  const snap = await db().doc(`inviteRequests/${args.inviteId}`).get();
  if (!snap.exists) return { status: 'not_found' };
  const invite = snap.data() as InviteRequestDoc;

  if (invite.status === 'ACCEPTED') return { status: 'claimed' };
  if (invite.status === 'REVOKED' || invite.status === 'EXPIRED') return { status: 'revoked' };
  if ((invite.expiresAt as unknown as { toMillis(): number }).toMillis() < Date.now()) {
    return { status: 'expired' };
  }

  const familySnap = await db().doc(`families/${invite.tribeId}`).get();
  const tribeName =
    (familySnap.exists ? (familySnap.data()?.displayName as string | undefined) : undefined) ?? '';

  return { status: 'valid', invitedEmail: invite.invitedEmail, tribeName };
}

export const getInvitePreview = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] , minInstances: 1 },
  wrapCallable('getInvitePreview', getInvitePreviewHandler),
);
