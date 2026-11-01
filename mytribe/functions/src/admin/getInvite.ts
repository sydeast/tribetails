import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { auth, db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { mapInviteDoc, toIsoOrNull } from './listInvites';
import { householdNameFor, type AdminInviteDTO } from './listAllInvites';

/**
 * ONE invite, by id, for the admin's invite detail screen (#1339).
 *
 * WHY IT EXISTS. The `invite.auntie-notify` email links to
 * `${AUNTIE_OS_REVIEW_BASE_URL}/invites/<inviteId>`, and until #1339 the admin
 * app had no such route. The route needs a read that cannot miss its row:
 * `listAllInvites` is one page of 200, so "find it in the list" would turn an
 * older invite into a "not found" that is not true.
 *
 * THE PROJECTION IS `listAllInvites`'s, plus what a single invite can afford to
 * say that a list cannot: who sent it, who claimed it, and when. `mapInviteDoc`
 * and `householdNameFor` are imported, not restated, so `effectiveStatus`,
 * `redeemable` and the household fallbacks have one implementation.
 *
 * WHO SENT IT. `primaryUid` on the invite doc is the inviting household
 * PRIMARY (`mintInviteFromPrimary`, `addSecondaryContact`), or `''` when the
 * business minted it (`mintInvite`, `inviteKinfolkToPortal`,
 * `provisionTribe`, `executePrimaryRecovery`). Names come from Firebase Auth;
 * an account that cannot be read leaves the name and email null and keeps the
 * uid, so the screen can say "unknown account" instead of hiding the row.
 *
 * WHEN IT WAS CLAIMED. `acceptInvite` stamps `acceptedAt` from #1339 on.
 * Invites accepted before that carry only `acceptedUid`, and `acceptedAt` reads
 * null: a date this read does not have is a date it does not invent.
 *
 * SECURITY. The id is the claim-link bearer token (see `listInvites.ts`). It
 * is the argument here because the email link carries it, and it reaches
 * neither `logEvent` nor the audit payload.
 */
const Args = z.object({
  inviteId: z.string().trim().min(1).max(200),
});

export interface InviteParty {
  uid: string;
  /** Firebase Auth `displayName`, or null when unset or unreadable. */
  displayName: string | null;
  /** Firebase Auth `email`, or null when unset or unreadable. */
  email: string | null;
}

export interface InviteDetailDTO extends AdminInviteDTO {
  /** `'AUNTIE'` when the business minted the invite (`primaryUid === ''`), else `'PRIMARY'`. */
  invitedByRole: 'AUNTIE' | 'PRIMARY';
  /** The inviting PRIMARY's account. Null when the business minted it. */
  invitedBy: InviteParty | null;
  /** The account that claimed the invite. Null until it is claimed. */
  acceptedBy: InviteParty | null;
  /** ISO-8601, or null when not claimed or claimed before `acceptedAt` was stamped. */
  acceptedAt: string | null;
  /** `inviteRequests.source` when the writer set one (e.g. `mytribe-portal`), else null. */
  source: string | null;
}

export interface GetInviteResult {
  invite: InviteDetailDTO;
}

async function partyFor(uid: string): Promise<InviteParty> {
  const user = await auth()
    .getUser(uid)
    .catch(() => null);
  const displayName = typeof user?.displayName === 'string' && user.displayName.trim() !== '' ? user.displayName.trim() : null;
  const email = typeof user?.email === 'string' && user.email !== '' ? user.email : null;
  return { uid, displayName, email };
}

export async function getInviteHandler(req: CallableRequest<unknown>): Promise<GetInviteResult> {
  initSentry();

  // Defense in depth: wrapAdminCallable already enforces this.
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getInvite validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // A doc id cannot contain a slash; refuse it here rather than letting the SDK
  // read it as a sub-path.
  if (args.inviteId.includes('/')) {
    throw new HttpsError('invalid-argument', 'getInvite validation failed', {
      validationErrors: [{ path: 'inviteId', message: 'Invalid invite id' }],
    });
  }

  const snap = await db().collection('inviteRequests').doc(args.inviteId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No invite with that id.');
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const row = mapInviteDoc(snap.id, data, Date.now());

  let householdName: string;
  if (row.tribeId === '') {
    householdName = householdNameFor('', undefined);
  } else {
    const hh = await db().collection('kinfolk').doc(row.tribeId).get();
    householdName = householdNameFor(
      row.tribeId,
      hh.exists ? (hh.data() as Record<string, unknown>) : undefined,
    );
  }

  const primaryUid = typeof data['primaryUid'] === 'string' ? (data['primaryUid'] as string) : '';
  const [invitedBy, acceptedBy] = await Promise.all([
    primaryUid === '' ? Promise.resolve(null) : partyFor(primaryUid),
    row.acceptedUid === null ? Promise.resolve(null) : partyFor(row.acceptedUid),
  ]);

  const invite: InviteDetailDTO = {
    ...row,
    householdName,
    invitedByRole: primaryUid === '' ? 'AUNTIE' : 'PRIMARY',
    invitedBy,
    acceptedBy,
    acceptedAt: toIsoOrNull(data['acceptedAt']),
    source: typeof data['source'] === 'string' && data['source'] !== '' ? (data['source'] as string) : null,
  };

  // Cross-tenant by definition, same as listAllInvites. Best-effort.
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.OPERATOR_CROSSTENANT_ACCESS,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    familyId: row.tribeId === '' ? undefined : row.tribeId,
    payload: { function: 'getInvite' },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'getInvite',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  // No invite id here: it is the claim token.
  logEvent({
    severity: 'info',
    function: 'getInvite',
    event: 'membership.invite.read',
    uid,
    extra: { familyId: row.tribeId },
  });

  return { invite };
}

export const getInvite = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getInvite', getInviteHandler),
);
