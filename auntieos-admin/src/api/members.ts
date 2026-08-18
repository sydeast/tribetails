/**
 * Household members and invites, the READ half. (B1)
 *
 * TRANSPORT: callables, not direct Firestore reads, and deliberately so.
 * `firestore.rules` does grant `isAuntie()` a read of both
 * `families/{fid}/members/{uid}` and `inviteRequests`, so a direct read would
 * be permitted. Two things make the callables the right seam anyway:
 *
 *  - `inviteRequests` has no `tribeId` + `createdAt` composite index
 *    (`mytribe/firestore.indexes.json` carries only status + expiresAt, for the
 *    nightly sweep), so a client-side ordered query would need an index deploy.
 *  - `listInvites` reconciles expiry at read time. `expireStaleInvites` is a
 *    02:00 nightly job, so a lapsed invite still READS as EMAIL_SENT in
 *    Firestore for up to a day. Doing that reconciliation here would mean doing
 *    it again, identically, in the Android mirror. The server does it once.
 *
 * The write half is `membersWrite.ts`. Nothing in this file catches: a failed
 * read propagates so the screen can say so, per the fail-loud rule.
 */

import { call } from '../lib/fns';

export type MemberRole = 'PRIMARY' | 'SECONDARY';
export type MemberStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export type InviteStatus = 'PENDING' | 'EMAIL_SENT' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface MemberPermissions {
  billing_full: boolean;
  messaging_direct: boolean;
  messaging_group: boolean;
  kin_edit: boolean;
  kintales_only: boolean;
  home_access: boolean;
}

export type PermissionKey = keyof MemberPermissions;

export interface PermissionMeta {
  readonly key: PermissionKey;
  readonly label: string;
  readonly description: string;
  // `adminOnly` used to live here, on `billing_full`, claiming the household's
  // own PRIMARY could not move that flag. Per the operator ruling a PRIMARY may
  // grant a SECONDARY any permission except admin, billing included, so the
  // badge asserted a restriction the server does not enforce and the product
  // does not want. Removed rather than relabelled: nothing else used the flag,
  // and the description below carries the weight honestly.
  /**
   * The server refuses to change it. `mintInvite` forces `kintales_only: true`
   * on every invite and `setMemberPermissions` does not accept the key at all,
   * so rendering it as a live toggle would be a control that no-ops.
   */
  readonly serverLocked?: true;
}

/** Order is the order rendered. Mirrors `lib/schema.ts` MemberPermissions. */
export const PERMISSION_META: readonly PermissionMeta[] = [
  {
    key: 'billing_full',
    label: 'Full billing',
    description:
      'Full access to invoices and payment methods. The household PRIMARY can grant this too; every change is audited.',
  },
  {
    key: 'messaging_direct',
    label: 'Direct messaging',
    description: 'One to one messages with the Auntie.',
  },
  {
    key: 'messaging_group',
    label: 'Group messaging',
    description: 'Takes part in the household group thread.',
  },
  {
    key: 'kin_edit',
    label: 'Edit kin',
    description: 'Adds or edits the household pet records.',
  },
  {
    key: 'home_access',
    label: 'Home access',
    description: 'Sees the household home details, including entry notes.',
  },
  {
    key: 'kintales_only',
    label: 'KinTales feed',
    description: 'Always reads the household KinTales feed. Locked on by the server.',
    serverLocked: true,
  },
];

/** The five keys `setMemberPermissions` will accept. `kintales_only` is absent. */
export const EDITABLE_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_META.filter(
  (p) => p.serverLocked !== true,
).map((p) => p.key);

/**
 * True when this member's entitlements are theirs by ROLE, and the flags on
 * their member doc are inert.
 *
 * RULING (2026-08-04): "admin can edit permissions but not like primary's
 * access to full billing, home access, kin edit, etc. The screen makes it seem
 * like these account must needs can be turned off."
 *
 * They cannot. `requirePerm` and `hasKinfolkPerm` in
 * `mytribe/functions/src/lib/memberGate.ts` both answer for a PRIMARY before
 * they ever read `permissions`, so every flag on a primary is dead data, and
 * `setMemberPermissions` now refuses a primary target outright. Any surface
 * rendering a member's permissions MUST ask this first: a toggle a primary
 * appears able to lose billing or home access to is a control that lies twice
 * over, once about what it does and once about what the role is.
 */
export function permissionsFollowRole(role: MemberRole): boolean {
  return role === 'PRIMARY';
}

export interface HouseholdMember {
  uid: string;
  secondaryLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
  permissions: MemberPermissions;
  invitedEmail: string | null;
}

export interface HouseholdInvite {
  /**
   * Also the claim-link bearer token (`?invite=<inviteId>`). Shown truncated so
   * the operator can match a row to an audit entry; never rendered as a URL and
   * never offered for copy. See listInvites.ts.
   */
  inviteId: string;
  tribeId: string;
  invitedEmail: string;
  secondaryLabel: string | null;
  proposedRole: MemberRole;
  proposedPermissions: MemberPermissions;
  /** Raw document status. Prefer `effectiveStatus` for anything the eye sees. */
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

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

/** Complete permission shape from an arbitrary payload; absent flags read false. */
function asPermissions(v: unknown): MemberPermissions {
  const p = (v ?? {}) as Record<string, unknown>;
  return {
    billing_full: bool(p['billing_full']),
    messaging_direct: bool(p['messaging_direct']),
    messaging_group: bool(p['messaging_group']),
    kin_edit: bool(p['kin_edit']),
    kintales_only: bool(p['kintales_only']),
    home_access: bool(p['home_access']),
  };
}

function asRole(v: unknown): MemberRole {
  return v === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY';
}

function asMemberStatus(v: unknown): MemberStatus {
  return v === 'ACTIVE' || v === 'SUSPENDED' ? v : 'INVITED';
}

const INVITE_STATUSES: readonly InviteStatus[] = [
  'PENDING',
  'EMAIL_SENT',
  'ACCEPTED',
  'REVOKED',
  'EXPIRED',
];

function asInviteStatus(v: unknown): InviteStatus {
  return INVITE_STATUSES.includes(v as InviteStatus) ? (v as InviteStatus) : 'PENDING';
}

/**
 * The household roster.
 *
 * `listMembers` is the shared portal callable: an operator may target any
 * household (audited cross-tenant server-side) and MUST pass a kinfolkId,
 * because staff have no default household of their own.
 */
export async function listHouseholdMembers(kinfolkId: string): Promise<HouseholdMember[]> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('listHouseholdMembers requires a household id');

  const res = await call<{ kinfolkId: string }, { members?: unknown }>('listMembers', {
    kinfolkId: id,
  });
  const rows = Array.isArray(res?.members) ? res.members : [];
  return rows
    .map((row) => (row ?? {}) as Record<string, unknown>)
    .filter((row) => typeof row['uid'] === 'string' && row['uid'] !== '')
    .map((row) => ({
      uid: row['uid'] as string,
      secondaryLabel: str(row['secondaryLabel']),
      role: asRole(row['role']),
      status: asMemberStatus(row['status']),
      permissions: asPermissions(row['permissions']),
      invitedEmail: str(row['invitedEmail']),
    }));
}

/** A household member the recovery claim link may legally be sent to. */
export interface RecoveryCandidate {
  uid: string;
  /** The address on the Auth account, lowercased by the server. */
  email: string;
  secondaryLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
}

/**
 * The addresses `executePrimaryRecovery` will accept for this household.
 *
 * WHY THE SERVER OWNS THE LIST. Eligibility turns on `emailVerified` on the
 * Firebase Auth account, which the client cannot see for anybody but the signed
 * in operator, and it is deliberately NOT the same question as the `email`
 * field on the member doc (that one is whatever was typed at invite time). So
 * this cannot be derived from `listHouseholdMembers`, and must not be: the
 * recovery dialog offers exactly what the gate accepts, or it is a picker that
 * fails on submit.
 *
 * `oldUid` is the primary being recovered away from. The server leaves them out
 * of the answer, because the one place a recovery link cannot go is back to the
 * account that has just lost the household.
 *
 * Nothing catches: a failed read propagates so the dialog can say so.
 */
export async function listRecoveryCandidates(
  familyId: string,
  oldUid?: string,
): Promise<RecoveryCandidate[]> {
  const id = familyId.trim();
  if (id === '') throw new Error('listRecoveryCandidates requires a household id');

  const res = await call<{ familyId: string; oldUid?: string }, { candidates?: unknown }>(
    'listRecoveryCandidates',
    oldUid === undefined || oldUid.trim() === ''
      ? { familyId: id }
      : { familyId: id, oldUid: oldUid.trim() },
  );
  const rows = Array.isArray(res?.candidates) ? res.candidates : [];
  return rows
    .map((row) => (row ?? {}) as Record<string, unknown>)
    .filter((row) => typeof row['uid'] === 'string' && row['uid'] !== '')
    .filter((row) => typeof row['email'] === 'string' && row['email'] !== '')
    .map((row) => ({
      uid: row['uid'] as string,
      email: row['email'] as string,
      secondaryLabel: str(row['secondaryLabel']),
      role: asRole(row['role']),
      status: asMemberStatus(row['status']),
    }));
}

/**
 * One invite row from either read. Shared, not copied: `listInvites` and
 * `listAllInvites` return the identical projection (the callable literally
 * imports `mapInviteDoc` from its sibling), and two hand-kept mappers would be
 * two places for `redeemable`'s default to drift.
 */
function mapInviteRow(row: Record<string, unknown>): HouseholdInvite {
  return {
    inviteId: row['inviteId'] as string,
    tribeId: typeof row['tribeId'] === 'string' ? (row['tribeId'] as string) : '',
    invitedEmail: typeof row['invitedEmail'] === 'string' ? (row['invitedEmail'] as string) : '',
    secondaryLabel: str(row['secondaryLabel']),
    proposedRole: asRole(row['proposedRole']),
    proposedPermissions: asPermissions(row['proposedPermissions']),
    status: asInviteStatus(row['status']),
    effectiveStatus: asInviteStatus(row['effectiveStatus'] ?? row['status']),
    // Absent `redeemable` must NOT default true: offering Revoke on an invite
    // the server considers dead is a control that fails when clicked.
    redeemable: bool(row['redeemable']),
    createdAt: str(row['createdAt']),
    sentToInviteeAt: str(row['sentToInviteeAt']),
    expiresAt: str(row['expiresAt']),
    revokedAt: str(row['revokedAt']),
    acceptedUid: str(row['acceptedUid']),
  };
}

/** Rows carrying an id, which is the only thing a caller can act on. */
function inviteRows(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map((row) => (row ?? {}) as Record<string, unknown>)
    .filter((row) => typeof row['inviteId'] === 'string' && row['inviteId'] !== '');
}

/** Every invite ever minted for one household, newest first. */
export async function listHouseholdInvites(familyId: string): Promise<HouseholdInvite[]> {
  const id = familyId.trim();
  if (id === '') throw new Error('listHouseholdInvites requires a household id');

  const res = await call<{ familyId: string }, { invites?: unknown }>('listInvites', {
    familyId: id,
  });
  return inviteRows(res?.invites).map(mapInviteRow);
}

/**
 * A household invite, carrying the name of the household it belongs to.
 *
 * The one added field, and it exists because the admin-wide list is the only
 * place a row is read outside its own household's screen, where `tribeId`
 * alone is an opaque id.
 */
export interface AdminInvite extends HouseholdInvite {
  /** Never blank. An unnameable household says so in words; see below. */
  householdName: string;
}

/**
 * Every invite across every household, newest first.
 *
 * WHY IT EXISTS. `listInvites` is scoped to one household, so "who never
 * accepted" meant opening all 13 households by hand and comparing four lists.
 *
 * READ ONLY, and permanently so. Per the invite ruling the admin's only invite
 * is inviting a PRIMARY to the portal, which is household-scoped
 * (`mintInvite` / `inviteKinfolkToPortal`); the PRIMARY invites the secondary
 * from MyTribe. An admin-WIDE surface has no household to mint into, so there
 * is deliberately no write beside this read.
 *
 * Nothing catches: a failed read propagates so the screen can say so.
 */
export async function listAllInvites(): Promise<AdminInvite[]> {
  const res = await call<Record<string, never>, { invites?: unknown }>('listAllInvites', {});
  return inviteRows(res?.invites).map((row) => ({
    ...mapInviteRow(row),
    // The server always sends one, including its own loud markers for a missing
    // or unnamed household, and those are passed through verbatim. This branch
    // covers an older server that sends none: it names the id rather than
    // rendering a card with a blank heading, which would read as "no household".
    householdName:
      str(row['householdName']) ??
      `(household name missing: ${typeof row['tribeId'] === 'string' ? row['tribeId'] : '?'})`,
  }));
}

/** Display name for a member row. Never blank: falls back to the uid. */
export function memberLabel(member: HouseholdMember): string {
  return member.invitedEmail ?? member.secondaryLabel ?? member.uid;
}

export type PillTone = 'success' | 'warning' | 'error' | 'muted' | 'neutral';

export function inviteStatusTone(status: InviteStatus): PillTone {
  if (status === 'ACCEPTED') return 'success';
  if (status === 'EMAIL_SENT' || status === 'PENDING') return 'warning';
  if (status === 'REVOKED') return 'error';
  if (status === 'EXPIRED') return 'muted';
  return 'neutral';
}

export function memberStatusTone(status: MemberStatus): PillTone {
  if (status === 'ACTIVE') return 'success';
  if (status === 'INVITED') return 'warning';
  if (status === 'SUSPENDED') return 'error';
  return 'neutral';
}

/** Human status text. EXPIRED-by-lapse and EXPIRED-by-sweep read the same. */
export function inviteStatusLabel(status: InviteStatus): string {
  if (status === 'EMAIL_SENT') return 'Email sent';
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/**
 * `2026-05-20` from an ISO string. Returns null for null or unparseable input
 * rather than a today's-date stand-in, so a missing timestamp reads as missing.
 */
export function formatInviteDate(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A short, non-reversible handle for an invite, for matching a row against the
 * activity log. Truncated on purpose: the full id is the claim token.
 */
export function inviteHandle(inviteId: string): string {
  return inviteId.length <= 8 ? inviteId : `${inviteId.slice(0, 8)}…`;
}
