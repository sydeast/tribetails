/**
 * Household members and invites, the WRITE half. (B1)
 *
 * Every call here is a callable, and there is no direct-Firestore alternative:
 * `firestore.rules` sets `inviteRequests` to `allow create, update, delete: if
 * false` outright, and the `families/{fid}/members/{uid}` update branch is
 * gated on `isPrimary(fid)` with `isAuntie()` deliberately absent. An operator
 * literally cannot write either collection from a client SDK. That is the
 * design: the callables own the audit trail, the email send, and the
 * `kintales_only` lock.
 *
 * Nothing here catches. A failed mint, revoke or permission write propagates so
 * the screen can name what failed, per the fail-loud rule. The one thing this
 * file DOES do is refuse to pretend: `inviteKinfolkToPortal` answers
 * `already_active` and `no_email` as SUCCESS responses, and
 * `describePortalInviteOutcome` below makes the caller say which happened
 * instead of reporting all three as "invite sent".
 *
 * Read half: `members.ts`.
 */

import { call } from '../lib/fns';
import { type MemberRole, type PermissionKey } from './members';

/** `INVITE_TTL_DAYS` in `mytribe/functions/src/lib/schema.ts`. */
export const INVITE_TTL_DAYS = 14;

export interface MintInviteInput {
  familyId: string;
  invitedEmail: string;
}

export interface MintInviteResult {
  inviteId: string;
}

/**
 * Mints a PRIMARY claim for one household and emails the link.
 *
 * RULING (2026-08-04): the primary kinfolk invites the secondary; the admin
 * does not, and the admin's only invite is inviting the primary to the portal.
 * So there is no role argument here any more, and no starting permission set:
 * a primary holds every entitlement by role, `mintInvite` writes
 * `FULL_PERMISSIONS` server-side, and the callable now REFUSES
 * `proposedRole: 'SECONDARY'` rather than accepting it as it used to by
 * default. The secondary is invited from the kinfolk portal, by their own
 * primary, through `addSecondaryContact`.
 *
 * `SECONDARY_LABEL_MAX` and `DEFAULT_INVITE_PERMISSIONS` used to live here for
 * the label and permission fields of that form. Both are gone with it: a label
 * describes a secondary's place in a household, and a starting permission set
 * is a choice that has no effect on a primary.
 */
export async function mintInvite(input: MintInviteInput): Promise<MintInviteResult> {
  const familyId = input.familyId.trim();
  if (familyId === '') throw new Error('mintInvite requires a household id');

  const invitedEmail = input.invitedEmail.trim();
  if (invitedEmail === '') throw new Error('An email address is required to send an invite.');
  // Cheap shape check only. The server's z.string().email() is the real gate;
  // this exists so an obvious typo does not cost a round trip to say so.
  if (!invitedEmail.includes('@')) throw new Error(`"${invitedEmail}" is not an email address.`);

  return call<
    { familyId: string; invitedEmail: string; proposedRole: MemberRole },
    MintInviteResult
  >('mintInvite', {
    familyId,
    invitedEmail,
    // Sent explicitly, though the server defaults it: this is the one grant
    // this call can make, and it should read that way at the call site.
    proposedRole: 'PRIMARY',
  });
}

/** Marks an invite REVOKED. `acceptInvite` then refuses it permanently. */
export async function revokeInvite(inviteId: string): Promise<void> {
  const id = inviteId.trim();
  if (id === '') throw new Error('revokeInvite requires an invite id');
  await call<{ inviteId: string }, { ok: true }>('revokeInvite', { inviteId: id });
}

/**
 * Changes one or more permission flags on an existing SECONDARY.
 *
 * SECONDARY, not "member": the server answers `failed-precondition` /
 * `target not SECONDARY` for a primary target, because a primary's
 * entitlements come from the role and no enforcement path reads their flags.
 * The roster must therefore never offer a primary a permission toggle; this
 * function does not take a role and cannot check it for you.
 *
 * `kintales_only` is not in the server's argument schema, so it is stripped
 * here too: sending it would be silently dropped, and a toggle that silently
 * does nothing is worse than no toggle.
 */
export async function setMemberPermissions(
  familyId: string,
  targetUid: string,
  permissions: Partial<Record<PermissionKey, boolean>>,
): Promise<void> {
  const fid = familyId.trim();
  const uid = targetUid.trim();
  if (fid === '') throw new Error('setMemberPermissions requires a household id');
  if (uid === '') throw new Error('setMemberPermissions requires a member uid');

  const payload: Partial<Record<Exclude<PermissionKey, 'kintales_only'>, boolean>> = {};
  for (const [key, value] of Object.entries(permissions)) {
    if (key === 'kintales_only') continue;
    if (typeof value !== 'boolean') continue;
    payload[key as Exclude<PermissionKey, 'kintales_only'>] = value;
  }
  if (Object.keys(payload).length === 0) {
    throw new Error('setMemberPermissions was given no permission to change.');
  }

  await call<
    { familyId: string; targetUid: string; permissions: typeof payload },
    { ok: true }
  >('setMemberPermissions', { familyId: fid, targetUid: uid, permissions: payload });
}

/**
 * Removes a member from the household.
 *
 * SOFT on the server: the member doc goes SUSPENDED, the household id is pulled
 * off `clients/{uid}.kinfolkIds`, and their refresh tokens are revoked. The row
 * therefore stays in the roster afterwards, marked Suspended. The screen must
 * not claim the member is gone.
 */
export async function removeMember(familyId: string, targetUid: string): Promise<void> {
  const fid = familyId.trim();
  const uid = targetUid.trim();
  if (fid === '') throw new Error('removeMember requires a household id');
  if (uid === '') throw new Error('removeMember requires a member uid');
  await call<{ familyId: string; targetUid: string }, { ok: true }>('removeMember', {
    familyId: fid,
    targetUid: uid,
  });
}

export type PortalInviteStatus = 'sent' | 'already_active' | 'no_email';

export interface InviteKinfolkToPortalResult {
  kinfolkId: string;
  status: PortalInviteStatus;
  inviteId?: string;
}

/**
 * Invites an EXISTING household to the kinfolk portal as its PRIMARY.
 *
 * The same grant as `mintInvite`, reached differently: this one resolves the
 * address off the kinfolk record, ensures the MyTribe family envelope exists,
 * and skips a household that already has an active primary. `mintInvite` takes
 * an address the operator types, for a household whose record carries the
 * wrong one or none.
 */
export async function inviteKinfolkToPortal(
  kinfolkId: string,
): Promise<InviteKinfolkToPortalResult> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('inviteKinfolkToPortal requires a household id');

  const res = await call<{ kinfolkId: string }, InviteKinfolkToPortalResult>(
    'inviteKinfolkToPortal',
    { kinfolkId: id },
  );
  // A shape we cannot read is not a success. Falling through to "sent" here is
  // exactly the fabricated-success failure the repo rule forbids.
  if (res?.status !== 'sent' && res?.status !== 'already_active' && res?.status !== 'no_email') {
    throw new Error('inviteKinfolkToPortal returned an unrecognised status.');
  }
  return res;
}

export interface PortalInviteOutcome {
  /** True only for `sent`. The other two did NOT email anybody. */
  sent: boolean;
  message: string;
}

/**
 * Turns the three-way response into something the screen can say out loud.
 *
 * `already_active` and `no_email` are HTTP successes that sent no email. Both
 * have to read as "nothing was sent, and here is why", or the operator walks
 * away believing a household was invited when it was not.
 */
export function describePortalInviteOutcome(
  result: InviteKinfolkToPortalResult,
  householdName: string,
): PortalInviteOutcome {
  const who = householdName.trim() === '' ? 'This household' : householdName.trim();
  if (result.status === 'sent') {
    return { sent: true, message: `Portal invite sent to ${who}. It expires in ${INVITE_TTL_DAYS} days.` };
  }
  if (result.status === 'already_active') {
    return {
      sent: false,
      message: `No invite sent: ${who} already has an active portal account. Remove the primary member first if you need to re-invite.`,
    };
  }
  return {
    sent: false,
    message: `No invite sent: ${who} has no email address on file. Add one on the household profile, then try again.`,
  };
}

export interface ExecutePrimaryRecoveryInput {
  familyId: string;
  /** Must be one of `listRecoveryCandidates`' addresses. The server re-checks. */
  newEmail: string;
  /** The sitting primary. They are suspended when the recovery goes through. */
  oldUid: string;
  recoveryRequestId?: string;
}

/**
 * Hands a household's primary role to another member, by mailing them a claim
 * link and suspending the sitting primary.
 *
 * THE HEAVIEST WRITE ON THIS SCREEN. The mail this sends does not describe an
 * account, it grants one: whoever opens the link becomes the primary, holding
 * every entitlement including billing, and the previous primary is locked out
 * in the same call.
 *
 * `newEmail` is therefore not a free-text field. The server accepts it only
 * when it belongs to a verified Auth account already on the household, and
 * answers `failed-precondition` with a message naming the eligible addresses
 * otherwise (issue #378). Callers must pick from `listRecoveryCandidates` and
 * must show the server's message verbatim: "recovery failed" tells an operator
 * with a locked-out family nothing they can act on.
 *
 * A refused call changes nothing. No suspension, no invite, no mail.
 */
export async function executePrimaryRecovery(
  input: ExecutePrimaryRecoveryInput,
): Promise<{ inviteId: string }> {
  const familyId = input.familyId.trim();
  const newEmail = input.newEmail.trim();
  const oldUid = input.oldUid.trim();
  if (familyId === '') throw new Error('executePrimaryRecovery requires a household id');
  if (oldUid === '') throw new Error('executePrimaryRecovery requires the current primary uid');
  if (newEmail === '') throw new Error('Pick which member should receive the claim link.');

  return call<
    { familyId: string; newEmail: string; oldUid: string; recoveryRequestId?: string },
    { inviteId: string }
  >('executePrimaryRecovery', {
    familyId,
    newEmail,
    oldUid,
    ...(input.recoveryRequestId === undefined ? {} : { recoveryRequestId: input.recoveryRequestId }),
  });
}
