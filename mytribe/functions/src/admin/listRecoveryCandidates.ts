import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { listRecoveryCandidates as resolveCandidates } from '../lib/recoveryCandidates';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { MemberRole, MemberStatus } from '../lib/schema';

const Args = z.object({
  familyId: z.string().min(1),
  oldUid: z.string().optional(),
});

export interface RecoveryCandidateDTO {
  uid: string;
  email: string;
  secondaryLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
}

interface ListRecoveryCandidatesResult {
  candidates: RecoveryCandidateDTO[];
}

/**
 * The addresses `executePrimaryRecovery` will accept for one household.
 *
 * WHY A READ CALLABLE AND NOT A CLIENT QUERY. Whether an address is eligible
 * turns on `emailVerified` on the Firebase Auth account, which no client can
 * see for anybody but itself. The member doc's `email` field is not the same
 * question — it is whatever was typed when the member was invited, verified or
 * not — so a roster read would produce a list that looks right and disagrees
 * with the gate.
 *
 * This deliberately shares `lib/recoveryCandidates.ts` with the execute path.
 * The recovery dialog exists so the operator picks from a set instead of typing
 * into a box; if this list and the server's gate were computed separately, the
 * dialog would eventually offer a choice that fails on submit, which is worse
 * than the text box it replaced.
 *
 * Sends no mail, changes no household state and writes no Activity Log line.
 * Only the owner reaches it, and operator ruling 2026-11-12 (#1839) stopped
 * logging the owner's own looks; it used to write a cross-tenant access line.
 */
export async function listRecoveryCandidatesHandler(
  req: CallableRequest<unknown>,
): Promise<ListRecoveryCandidatesResult> {
  const uid = req.auth?.uid;
  const args = Args.parse(req.data);
  const candidates = await resolveCandidates(args.familyId, { excludeUid: args.oldUid });

  // #1839: no Activity Log line. Only the owner reaches this callable, and
  // operator ruling 2026-11-12 stopped logging her own looks.

  logEvent({
    severity: 'info',
    function: 'listRecoveryCandidates',
    event: 'admin.recovery.candidates.listed',
    uid,
    extra: { familyId: args.familyId, count: candidates.length },
  });

  return { candidates };
}

export const listRecoveryCandidates = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listRecoveryCandidates', listRecoveryCandidatesHandler),
);
