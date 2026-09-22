import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { enforceRateLimit } from '../lib/rateLimit';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { InviteRequestDoc } from '../lib/schema';
import { FULL_CPU } from '../lib/runtimeOptions';
import { clientIpOf, ipRateLimitKey } from '../auth/loginSecurity';

/** Previews per caller address per hour. Unchanged since before #910. */
export const INVITE_PREVIEW_IP_LIMIT = 60;
/**
 * #910: previews per invite id per hour, across every address. Well above what
 * one invitee's claim screen spends (one preview per open, one retry on web, a
 * "Try Again" on the portal app), far below scripted hammering of one id.
 */
export const INVITE_PREVIEW_PER_INVITE_LIMIT = 30;

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

  // #910: keyed on the entry Google appended to X-Forwarded-For (`clientIpOf`),
  // never `rawRequest.ip`, which under `trust proxy` is the caller's own first
  // entry. Called directly (no Hosting rewrite points here), so one trusted hop.
  // IPv6 is keyed on its /64 and an untrusted entry on the shared sentinel.
  const ipKey = ipRateLimitKey(clientIpOf(req.rawRequest));
  await enforceRateLimit('invitePreview', ipKey, INVITE_PREVIEW_IP_LIMIT, 3600);
  // #910: a per-invite ceiling as well, so rotating addresses cannot hammer one
  // invite id and so a shared per-IP bucket is not the only bound. Checked
  // BEFORE the invite is read: an unknown id and a real one spend and refuse
  // identically, so a refusal says nothing about whether the invite exists.
  await enforceRateLimit('invitePreviewInvite', args.inviteId, INVITE_PREVIEW_PER_INVITE_LIMIT, 3600);

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
  // First screen an invitee ever hits.
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('getInvitePreview', getInvitePreviewHandler),
);
