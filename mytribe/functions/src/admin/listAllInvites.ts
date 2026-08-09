import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { mapInviteDoc, sortInvitesNewestFirst, type InviteDTO } from './listInvites';

/**
 * The admin-wide invite read.
 *
 * `listInvites` answers "what happened to this household's invites" and takes a
 * `familyId`, so the only way to ask "who never accepted" was to open all 13
 * households by hand and compare four lists. That is the question the operator
 * actually has, and nothing could answer it.
 *
 * WHAT THIS IS NOT. It mints nothing and revokes nothing. Per the invite ruling
 * the admin's only invite is inviting a PRIMARY to the portal (`mintInvite` /
 * `inviteKinfolkToPortal`, both household-scoped); the PRIMARY invites the
 * secondary from MyTribe. An admin-wide screen has no household context to mint
 * into even if it were allowed to, so this is a read and its clients are lists.
 *
 * EVERY PROJECTION IS `listInvites`'s. `mapInviteDoc` and
 * `sortInvitesNewestFirst` are imported rather than restated, so expiry
 * reconciliation (`effectiveStatus`, `redeemable`) has exactly one
 * implementation. The only field added here is `householdName`.
 *
 * WHY THE SERVER NAMES THE HOUSEHOLD. `tribeId` alone is an opaque id, and a
 * list spanning every household is unreadable without names. The React admin
 * has `householdLabel` in `src/api/directory.ts`, but the Android app has no
 * port of it (the only Kotlin copy lives in the superseded `web/composeApp`
 * tree), so deriving client-side would mean writing a third and fourth copy of
 * the sibilant-plural rule. Same argument `listInvites` makes for
 * `effectiveStatus`: the server does it once and both mirrors obey.
 *
 * FAIL LOUD ON A MISSING HOUSEHOLD. An invite whose `kinfolk` doc is gone is
 * precisely the row an operator needs to see, so it is kept and NAMED as
 * broken. Filtering it would hide the only evidence that it exists.
 *
 * SECURITY. `inviteId` is the claim-link bearer token — see `listInvites.ts`
 * for the full note. It is returned because the clients match rows against the
 * activity log by a truncated handle, and it reaches neither `logEvent` nor the
 * audit payload here (counts only).
 *
 * Read-only apart from one best-effort cross-tenant audit entry. Unlike
 * `listInvites` that entry carries no `familyId`: the read is over every
 * household, and naming one of them would be a lie about its scope.
 */
const Args = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * Default page. Higher than `listInvites`'s 100 because this is one page across
 * every household rather than one household's history, and lower than the 500
 * ceiling so a runaway collection cannot be pulled by accident.
 */
const DEFAULT_LIMIT = 200;

export interface AdminInviteDTO extends InviteDTO {
  /** Never blank. A household that cannot be named says so, in words. */
  householdName: string;
}

export interface ListAllInvitesResult {
  invites: AdminInviteDTO[];
  /** Rows read before the sort, so a full page is distinguishable from a total. */
  scanned: number;
  /** Distinct households those rows touch. */
  households: number;
}

/**
 * Household display name from a `kinfolk` doc, e.g. "the Halbrooks".
 *
 * Mirrors `auntieos-admin/src/api/directory.ts#householdLabel` (itself a port of
 * `util/Households.kt`), sibilant pluralization included: "Brooks" becomes "the
 * Brookses", not "the Brookss".
 *
 * `undefined` data means the document does not exist. Every fallback names the
 * id, because the operator's next move on an unnameable row is to go look it up.
 */
export function householdNameFor(
  tribeId: string,
  data: { firstName?: unknown; lastName?: unknown } | undefined,
): string {
  if (tribeId === '') return '(invite carries no household id)';
  if (data === undefined) return `(household not found: ${tribeId})`;
  const first = typeof data.firstName === 'string' ? data.firstName.trim() : '';
  const last = typeof data.lastName === 'string' ? data.lastName.trim() : '';
  if (last !== '') {
    const plural = /(s|x|z|ch|sh)$/.test(last.toLowerCase()) ? `${last}es` : `${last}s`;
    return `the ${plural}`;
  }
  if (first !== '') return first;
  return `(unnamed household: ${tribeId})`;
}

export async function listAllInvitesHandler(
  req: CallableRequest<unknown>,
): Promise<ListAllInvitesResult> {
  initSentry();

  // Defense in depth: wrapAdminCallable already enforces this, kept in-handler
  // so a refactor that unwraps the export cannot silently open the read.
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listAllInvites validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // No `where`, so this rides the collection scan the automatic index already
  // supports and needs no composite index deploy, exactly as listInvites does.
  const snap = await db()
    .collection('inviteRequests')
    .limit(args.limit ?? DEFAULT_LIMIT)
    .get();

  const nowMs = Date.now();
  const rows = sortInvitesNewestFirst(
    snap.docs.map((d) => mapInviteDoc(d.id, (d.data() ?? {}) as Record<string, unknown>, nowMs)),
  );

  // One read per DISTINCT household, batched. A per-invite read would be N
  // round trips for a household with a long invite history.
  const tribeIds = [...new Set(rows.map((r) => r.tribeId).filter((id) => id !== ''))];
  const names = new Map<string, string>();
  if (tribeIds.length > 0) {
    const snaps = await db().getAll(...tribeIds.map((id) => db().collection('kinfolk').doc(id)));
    snaps.forEach((s, i) => {
      const id = tribeIds[i]!;
      names.set(
        id,
        householdNameFor(id, s.exists ? (s.data() as Record<string, unknown>) : undefined),
      );
    });
  }

  const invites: AdminInviteDTO[] = rows.map((r) => ({
    ...r,
    householdName: names.get(r.tribeId) ?? householdNameFor(r.tribeId, undefined),
  }));

  // Staff reading every household's invite roster is cross-tenant by definition.
  // Best-effort, mirroring listInvites: a failed audit must not make a
  // successful read look like a failed one.
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.OPERATOR_CROSSTENANT_ACCESS,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { function: 'listAllInvites', count: invites.length, households: tribeIds.length },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'listAllInvites',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  // Counts only. The invite ids are bearer tokens (see the file header).
  logEvent({
    severity: 'info',
    function: 'listAllInvites',
    event: 'membership.invites.listedAll',
    uid,
    extra: { count: invites.length, households: tribeIds.length },
  });

  return { invites, scanned: snap.docs.length, households: tribeIds.length };
}

export const listAllInvites = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listAllInvites', listAllInvitesHandler),
);
