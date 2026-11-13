import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { staffBypass } from '../lib/staffGate';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import type { MemberDoc, MemberPermissions, MemberRole, MemberStatus } from '../lib/schema';

const Args = z.object({
  kinfolkId: z.string().optional(),
});

/** Safe, non-sensitive projection of a family member for the members-editor. */
export interface MemberDTO {
  uid: string;
  /**
   * The person's name (#1589): the member doc's `displayName`, or for a PRIMARY
   * with none, the household's contact name. Null when nothing names them. The
   * members screens show this instead of the uid.
   */
  displayName: string | null;
  secondaryLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
  /**
   * The full permissions object verbatim (the client decides which toggles to
   * render). Defaults every flag to false when a doc is missing a field so the
   * editor always receives a complete shape.
   */
  permissions: MemberPermissions;
  /**
   * The member's invited email, sourced from the real `email` schema field when
   * present, else null. Never fabricated from any other field.
   */
  invitedEmail: string | null;
}

interface ListMembersResult {
  members: MemberDTO[];
}

/** Coerce an arbitrary value into the closed MemberRole set (defaults SECONDARY). */
function asRole(v: unknown): MemberRole {
  return v === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY';
}

/** Coerce an arbitrary value into the closed MemberStatus set (defaults INVITED). */
function asStatus(v: unknown): MemberStatus {
  return v === 'ACTIVE' || v === 'SUSPENDED' ? v : 'INVITED';
}

/** Build a complete MemberPermissions, defaulting every flag to false. */
function asPermissions(v: unknown): MemberPermissions {
  const p = (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
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
 * Lists the members of a family so the client can render a members-editor (which
 * then calls `updateSecondaryPermissions` per member to persist changes).
 *
 * Auth model: the caller must be the PRIMARY of the family (or an Auntie
 * operator). A SECONDARY — even one with elevated permission flags — cannot list
 * members: managing the household roster is a primary-only concern.
 *
 * Resolution mirrors the sibling read callables: `resolveKinfolkAccess` picks the
 * kinfolkId (operator may target any family; a kinfolk is restricted to their own
 * `clients/{uid}.kinfolkIds`), then `requireKinfolkPrimary` enforces the
 * primary-or-operator gate (with the same legacy anti-lockout fallback: a family
 * with no member doc for the caller is treated as a legacy single-primary
 * account and allowed).
 *
 * Read-only: this callable performs no writes.
 */
export async function listMembersHandler(
  req: CallableRequest<unknown>,
): Promise<ListMembersResult> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);
  // #944: allowlisted - the household roster is household information.
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, staffBypass(req.auth, 'listMembers'), 'listMembers', req.auth);

  // Primary-only (operator bypasses; legacy no-member-doc family falls back to
  // allow, consistent with requireKinfolkPrimary). A secondary is denied here.
  await requireKinfolkPrimary(uid, kinfolkId, staffBypass(req.auth, 'listMembers'), 'listMembers');

  const [snap, householdSnap] = await Promise.all([
    db().collection(`families/${kinfolkId}/members`).get(),
    db().doc(`kinfolk/${kinfolkId}`).get(),
  ]);
  const household = (householdSnap.data() ?? {}) as Record<string, unknown>;
  const contactName = [household['firstName'], household['lastName']]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ')
    .trim();
  const members: MemberDTO[] = snap.docs.map((d) => {
    const data = (d.data() ?? {}) as Partial<MemberDoc> & Record<string, unknown>;
    const rawLabel = data.secondaryLabel;
    const rawEmail = data.email;
    const ownName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
    const role = asRole(data.role);
    return {
      uid: typeof data.uid === 'string' ? data.uid : d.id,
      displayName: ownName !== '' ? ownName : role === 'PRIMARY' && contactName !== '' ? contactName : null,
      secondaryLabel: typeof rawLabel === 'string' ? rawLabel : null,
      role,
      status: asStatus(data.status),
      permissions: asPermissions(data.permissions),
      invitedEmail: typeof rawEmail === 'string' ? rawEmail : null,
    };
  });

  logEvent({
    severity: 'info',
    function: 'listMembers',
    event: 'portal.members.listed',
    uid,
    extra: { kinfolkId, count: members.length },
  });

  return { members };
}

export const listMembers = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('listMembers', listMembersHandler),
);
