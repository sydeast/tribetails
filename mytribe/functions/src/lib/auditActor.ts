import { db } from './firestoreAdmin';
import { isAuntieClaim, isOwner, isOwnerClaim, type StaffToken } from './staffGate';
import { STAFF_ROLE_AUNTIE } from './auntieAccess';
import type { ActorRole } from './schema';

/**
 * Who is this caller, for the Activity Log? (#1820)
 *
 * `logActivity` used to write `actorRole: 'PRIMARY'` for every line a client
 * asked it to record, so the owner's own clock taps were filed under "Primary
 * kinfolk", a household role. The role is now worked out here, from the
 * caller's verified token and records, and nothing the client sends takes part.
 *
 * `ActorRole` IS NOT EXTENDED, for the reason `signInAuditActor`
 * (auth/loginSecurity.ts) gives: `'AUNTIE'` already means "the business side"
 * at about 130 writers and in every row stored so far. The owner and a
 * caretaker therefore share that band, and the row says which of the two she
 * was in the same two payload keys the sign-in rows use: `admin` and
 * `staffRole`. The admin clients read those keys to print "Operator" or
 * "Auntie".
 *
 * Precedence matches every other gate in the #944 split: caretaker first,
 * including an account that carries both claims, then the owner (the `admin`
 * claim or the logged allowlist fallback), then the household.
 *
 * A household caller is PRIMARY unless a member record says SECONDARY. A
 * household with no member record is the legacy single-primary account
 * (`lib/memberGate.ts` makes the same call).
 */
export interface AuditActor {
  readonly actorUid: string;
  readonly actorRole: ActorRole;
  /** True for the owner. Stamped on the row as `payload.admin`. */
  readonly admin: boolean;
  /** `'auntie'` for a caretaker, else null. Stamped as `payload.staffRole`. */
  readonly staffRole: typeof STAFF_ROLE_AUNTIE | null;
}

/**
 * The payload keys the server stamps from [AuditActor]. A client payload may
 * never carry them (`lib/activityPayload.ts` refuses both).
 */
export const AUDIT_ACTOR_PAYLOAD_KEYS = ['admin', 'staffRole'] as const;

/** The two server-stamped payload keys for this actor. Household rows carry neither. */
export function auditActorPayload(actor: AuditActor): Record<string, unknown> {
  if (actor.actorRole !== 'AUNTIE') return {};
  return { admin: actor.admin, staffRole: actor.staffRole };
}

/**
 * Resolve the caller. `familyId` is the household the entry is about, when the
 * caller named one; it is used only for a household caller, and only when that
 * household is one of the caller's own.
 *
 * Never throws for a signed-in caller: a failed household read leaves the role
 * at PRIMARY rather than losing the line.
 */
export async function resolveAuditActor(
  auth: { uid?: string; token?: StaffToken } | undefined,
  functionName: string,
  familyId?: string,
): Promise<AuditActor> {
  const uid = auth?.uid ?? '';
  const token = auth?.token;
  if (isAuntieClaim(token)) {
    return { actorUid: uid, actorRole: 'AUNTIE', admin: false, staffRole: STAFF_ROLE_AUNTIE };
  }
  if (isOwner(uid, isOwnerClaim(token), functionName)) {
    return { actorUid: uid, actorRole: 'AUNTIE', admin: true, staffRole: null };
  }
  return { actorUid: uid, actorRole: await householdRole(uid, familyId), admin: false, staffRole: null };
}

async function householdRole(uid: string, familyId: string | undefined): Promise<'PRIMARY' | 'SECONDARY'> {
  if (uid === '') return 'PRIMARY';
  try {
    const clientSnap = await db().collection('clients').doc(uid).get();
    const own = ((clientSnap.data()?.kinfolkIds ?? []) as unknown[]).filter(
      (id): id is string => typeof id === 'string' && id !== '',
    );
    const household = familyId !== undefined && own.includes(familyId) ? familyId : own.length === 1 ? own[0] : undefined;
    if (household === undefined) return 'PRIMARY';
    const memberSnap = await db().doc(`families/${household}/members/${uid}`).get();
    return memberSnap.exists && memberSnap.data()?.role === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
  } catch {
    return 'PRIMARY';
  }
}
