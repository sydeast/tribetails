import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeBusinessAdminUids, resolveBusinessAdminUids } from '../lib/businessAdmins';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  /** Extra operator uids to include. The caller is always included. */
  uids: z.array(z.string().min(1)).max(20).optional(),
  /** Who unassigned visits default to. Only applied when none is stored yet. */
  defaultAssigneeUid: z.string().min(1).optional(),
});

/**
 * Seeds `businessSettings/admins`, the roster that decides who receives
 * business notifications and who a visit defaults to.
 *
 * This exists because that document had two readers and no writer, and in prod
 * it did not exist at all. 16 catalog keys name `businessAdmins` as their
 * primary resolver, so `kincare.requested`, `message.received` and
 * `rating.submitted.bad` all threw "cannot dispatch" and the operator was never
 * told. Nothing in the system could create it, which is why the gap survived.
 *
 * Admin-gated, idempotent, and never narrowing: the stored roster is unioned
 * with whatever is passed, so calling it twice (or with a partial list) cannot
 * drop an operator. Safe to call any time.
 */
export async function provisionBusinessAdminsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; uids: string[] }> {
  initSentry();
  const callerUid = req.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data ?? {});
  // The caller passed wrapAdminCallable, so they are an operator by definition.
  // Including them is what makes this work for a solo operator with no env
  // allowlist bound and no roster to copy from.
  const uids = [...new Set([callerUid, ...(args.uids ?? [])])];

  const written = await writeBusinessAdminUids(uids, {
    ...(args.defaultAssigneeUid !== undefined ? { defaultAssigneeUid: args.defaultAssigneeUid } : {}),
    reason: 'provisionBusinessAdmins',
  });

  logEvent({
    severity: 'info',
    function: 'provisionBusinessAdmins',
    event: 'businessAdmins.provisioned',
    uid: callerUid,
    extra: { count: written.length },
  });

  return { ok: true, uids: written };
}

/**
 * Read-only health check: reports whether business notifications can currently
 * be delivered, without sending one. Returns `ok:false` plus the reason instead
 * of throwing, so a status surface can render the problem.
 */
export async function checkBusinessAdminsHandler(
  _req: CallableRequest<unknown>,
): Promise<{ ok: boolean; uids: string[]; reason: string | null }> {
  initSentry();
  try {
    const uids = await resolveBusinessAdminUids('checkBusinessAdmins');
    return { ok: true, uids, reason: null };
  } catch (err) {
    return { ok: false, uids: [], reason: err instanceof Error ? err.message : 'unknown' };
  }
}

export const provisionBusinessAdmins = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('provisionBusinessAdmins', provisionBusinessAdminsHandler),
);

export const checkBusinessAdmins = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('checkBusinessAdmins', checkBusinessAdminsHandler),
);
