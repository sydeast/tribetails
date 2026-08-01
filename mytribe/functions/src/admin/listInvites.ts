import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { InviteStatus, MemberPermissions, MemberRole } from '../lib/schema';

/**
 * B1: the READ side of the household invite surface.
 *
 * `mintInvite`, `revokeInvite` and `inviteKinfolkToPortal` all WRITE
 * `inviteRequests`, and `expireStaleInvites` sweeps it nightly, but nothing
 * could ever read the collection back for an operator. Without this the admin
 * Members-and-Invites screen can send an invite and then never tell anyone what
 * happened to it, which is the same defect class as a write-only button.
 *
 * Why a callable and not a direct client query:
 *  - `firestore.rules` lets `isAuntie()` read `inviteRequests`, but a
 *    `where('tribeId','==',x).orderBy('createdAt','desc')` query needs a
 *    composite index that does not exist (`firestore.indexes.json` carries only
 *    status+expiresAt, for the nightly sweep). The equality-only query below
 *    rides the automatic single-field index and sorts in memory, so this ships
 *    without an index deploy.
 *  - Both clients (React admin and Android) need the same expiry reconciliation
 *    and the same ISO timestamps. Doing it once server-side keeps the two
 *    mirrors from drifting.
 *
 * `effectiveStatus` is the load-bearing field. `expireStaleInvites` runs at
 * 02:00 America/New_York, so a PENDING/EMAIL_SENT invite whose `expiresAt` has
 * already passed still READS as live in Firestore for up to a day. Rendering the
 * raw status would advertise a dead invite as pending and offer a Revoke button
 * for something `acceptInvite` already refuses. `effectiveStatus` reconciles
 * that at read time; `redeemable` is the single boolean the UI gates on.
 *
 * SECURITY. `inviteId` is the Firestore auto-id, and the claim link is
 * `${CLAIM_LINK_BASE_URL}?invite=${inviteId}` — so the id IS the bearer token.
 * It is returned here because `revokeInvite` takes it and because the rules
 * already grant an operator read of the whole document. It is deliberately NOT
 * logged in `logEvent` below (only a count is), and the clients must never
 * render or offer to copy the claim URL. Possession of the id alone still does
 * not redeem: `acceptInvite` additionally requires the caller's VERIFIED token
 * email to equal `invitedEmail`.
 *
 * Read-only: this callable writes no invite or member state. It does write one
 * cross-tenant access audit entry, mirroring `resolveKinfolkAccess`'s hardening
 * for staff reaching into a household they do not belong to.
 */
const Args = z.object({
  familyId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(200).optional(),
});

const DEFAULT_LIMIT = 100;

export interface InviteDTO {
  inviteId: string;
  tribeId: string;
  invitedEmail: string;
  secondaryLabel: string | null;
  proposedRole: MemberRole;
  proposedPermissions: MemberPermissions;
  requiresAuntieAck: boolean;
  /** Exactly what the document says, unreconciled. */
  status: InviteStatus;
  /** `status`, except a lapsed PENDING/EMAIL_SENT reads EXPIRED. */
  effectiveStatus: InviteStatus;
  /** True only when `acceptInvite` would still accept this invite today. */
  redeemable: boolean;
  createdAt: string | null;
  sentToInviteeAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  acceptedUid: string | null;
}

export interface ListInvitesResult {
  invites: InviteDTO[];
  /** How many rows were read before the in-memory sort, so an empty list is
   *  distinguishable from a household that has never been invited. */
  scanned: number;
}

/** Firestore Timestamp | Date | string -> ISO-8601, else null. Never throws. */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

/** Milliseconds since epoch for a Timestamp/Date/ISO string, else null. */
function toMillisOrNull(v: unknown): number | null {
  const iso = toIsoOrNull(v);
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const INVITE_STATUSES: readonly InviteStatus[] = [
  'PENDING',
  'EMAIL_SENT',
  'ACCEPTED',
  'REVOKED',
  'EXPIRED',
];

/** Coerce to the closed InviteStatus set. An unrecognised value reads PENDING,
 *  which is the conservative choice: it keeps the row visible and revocable. */
function asStatus(v: unknown): InviteStatus {
  return INVITE_STATUSES.includes(v as InviteStatus) ? (v as InviteStatus) : 'PENDING';
}

function asRole(v: unknown): MemberRole {
  return v === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY';
}

/** Complete MemberPermissions, every absent flag false. */
function asPermissions(v: unknown): MemberPermissions {
  const p = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const bool = (x: unknown): boolean => x === true;
  return {
    billing_full: bool(p['billing_full']),
    messaging_direct: bool(p['messaging_direct']),
    messaging_group: bool(p['messaging_group']),
    kin_edit: bool(p['kin_edit']),
    kintales_only: bool(p['kintales_only']),
    home_access: bool(p['home_access']),
  };
}

/**
 * Reconcile the stored status against the wall clock, exported for direct test.
 *
 * Mirrors `acceptInvite`'s own precedence: ACCEPTED/REVOKED/EXPIRED are
 * terminal and are never re-derived, and only a live PENDING/EMAIL_SENT can
 * lapse into EXPIRED. An invite with no readable `expiresAt` is left alone
 * rather than guessed at.
 */
export function effectiveInviteStatus(
  status: InviteStatus,
  expiresAtMs: number | null,
  nowMs: number,
): InviteStatus {
  if (status === 'ACCEPTED' || status === 'REVOKED' || status === 'EXPIRED') return status;
  if (expiresAtMs !== null && expiresAtMs < nowMs) return 'EXPIRED';
  return status;
}

export function mapInviteDoc(
  id: string,
  data: Record<string, unknown>,
  nowMs: number,
): InviteDTO {
  const status = asStatus(data['status']);
  const expiresAtMs = toMillisOrNull(data['expiresAt']);
  const effectiveStatus = effectiveInviteStatus(status, expiresAtMs, nowMs);
  const rawLabel = data['secondaryLabel'];
  const acceptedUid = data['acceptedUid'];
  return {
    inviteId: id,
    tribeId: typeof data['tribeId'] === 'string' ? (data['tribeId'] as string) : '',
    invitedEmail: typeof data['invitedEmail'] === 'string' ? (data['invitedEmail'] as string) : '',
    secondaryLabel: typeof rawLabel === 'string' ? rawLabel : null,
    proposedRole: asRole(data['proposedRole']),
    proposedPermissions: asPermissions(data['proposedPermissions']),
    requiresAuntieAck: data['requiresAuntieAck'] === true,
    status,
    effectiveStatus,
    redeemable: effectiveStatus === 'PENDING' || effectiveStatus === 'EMAIL_SENT',
    createdAt: toIsoOrNull(data['createdAt']),
    sentToInviteeAt: toIsoOrNull(data['sentToInviteeAt']),
    expiresAt: toIsoOrNull(data['expiresAt']),
    revokedAt: toIsoOrNull(data['revokedAt']),
    acceptedUid: typeof acceptedUid === 'string' ? (acceptedUid as string) : null,
  };
}

/** Newest first. Rows with no readable createdAt sort last, never first. */
export function sortInvitesNewestFirst(rows: InviteDTO[]): InviteDTO[] {
  return [...rows].sort((a, b) => {
    const am = a.createdAt === null ? -Infinity : Date.parse(a.createdAt);
    const bm = b.createdAt === null ? -Infinity : Date.parse(b.createdAt);
    const an = Number.isNaN(am) ? -Infinity : am;
    const bn = Number.isNaN(bm) ? -Infinity : bm;
    if (an === bn) return a.inviteId.localeCompare(b.inviteId);
    return bn - an;
  });
}

export async function listInvitesHandler(
  req: CallableRequest<unknown>,
): Promise<ListInvitesResult> {
  initSentry();

  // Defense in depth: wrapAdminCallable already enforces this, kept in-handler
  // so a refactor that unwraps the export cannot silently open the read.
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listInvites validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // Existence check, mirroring resolveKinfolkAccess hardening 1: an operator may
  // target any household, but not a household that does not exist. Without this
  // a typo'd id returns a plausible empty list instead of saying it is wrong.
  const kinSnap = await db().collection('kinfolk').doc(args.familyId).get();
  if (!kinSnap.exists) throw new HttpsError('not-found', 'kinfolkId not found.');

  const snap = await db()
    .collection('inviteRequests')
    .where('tribeId', '==', args.familyId)
    .limit(args.limit ?? DEFAULT_LIMIT)
    .get();

  const nowMs = Date.now();
  const invites = sortInvitesNewestFirst(
    snap.docs.map((d) => mapInviteDoc(d.id, (d.data() ?? {}) as Record<string, unknown>, nowMs)),
  );

  // Staff reading a household's invite roster is cross-tenant by definition (an
  // operator has no member doc for any family), so it is audited the same way
  // resolveKinfolkAccess audits an operator read. Best-effort: a failed audit
  // must not make a successful read look like a failed one.
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.OPERATOR_CROSSTENANT_ACCESS,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.familyId,
    familyId: args.familyId,
    payload: { function: 'listInvites', kinfolkId: args.familyId, count: invites.length },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'listInvites',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  // Count only. The invite ids are bearer tokens (see the file header) and do
  // not belong in structured logs.
  logEvent({
    severity: 'info',
    function: 'listInvites',
    event: 'membership.invites.listed',
    uid,
    extra: { kinfolkId: args.familyId, count: invites.length },
  });

  return { invites, scanned: snap.docs.length };
}

export const listInvites = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listInvites', listInvitesHandler),
);
