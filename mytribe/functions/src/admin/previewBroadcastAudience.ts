import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { CriteriaSchema, describeCriteria, resolveRecipientsFromKinfolk } from './audienceCriteria';
import { loadCriteria, toKinfolkLike } from './broadcastMessage';

/**
 * previewBroadcastAudience (admin, #1610). How many households a broadcast
 * audience reaches, asked BEFORE the send so the confirm can say it.
 *
 * The confirm used to read "the exact number reached is reported once the send
 * completes; it isn't known until then", which was true of the old code and
 * left the operator approving a send to an unknown number of people. The
 * audience is resolved here exactly as `broadcastMessage` resolves it (the same
 * `loadCriteria` and `resolveRecipientsFromKinfolk`), so the number on the
 * confirm is the number the send will target.
 *
 * `targeted` is households matched. The per-channel counts say how many of
 * them have the address that channel needs; a household's own preferences can
 * still turn a channel off at send time, and the post-send reach line reports
 * that. `withoutFirstName` is how many will read the stand-in word "Kinfolk"
 * in `{{firstName}}` (operator ruling, 2026-11-05). Writes nothing.
 */
const Args = z
  .object({
    segmentId: z.string().min(1).max(200).optional(),
    criteria: CriteriaSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.segmentId && !val.criteria) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['segmentId'], message: 'provide a segmentId or inline criteria' });
    }
  });

export interface BroadcastAudiencePreview {
  ok: true;
  description: string;
  targeted: number;
  withEmail: number;
  withPhone: number;
  withApp: number;
  withoutFirstName: number;
}

export async function previewBroadcastAudienceHandler(req: CallableRequest<unknown>): Promise<BroadcastAudiencePreview> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'previewBroadcastAudience validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  const criteria = await loadCriteria(args);
  const snap = await db().collection('kinfolk').get();
  const all = snap.docs.map((d) => toKinfolkLike(d.id, d.data() as Record<string, unknown>));
  const recipients = resolveRecipientsFromKinfolk(all, criteria);
  const has = (v: string | undefined): boolean => (v ?? '').trim() !== '';
  return {
    ok: true,
    description: describeCriteria(criteria),
    targeted: recipients.length,
    withEmail: recipients.filter((k) => has(k.email)).length,
    withPhone: recipients.filter((k) => has(k.phoneNumber)).length,
    withApp: recipients.filter((k) => has(k.uid)).length,
    withoutFirstName: recipients.filter((k) => !has(k.firstName)).length,
  };
}

export const previewBroadcastAudience = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('previewBroadcastAudience', previewBroadcastAudienceHandler),
);
