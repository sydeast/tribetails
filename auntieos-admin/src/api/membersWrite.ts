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
import { type MemberPermissions, type MemberRole, type PermissionKey } from './members';

/** `SECONDARY_LABEL_MAX` in `mytribe/functions/src/lib/schema.ts`. */
export const SECONDARY_LABEL_MAX = 24;

/** `INVITE_TTL_DAYS` in `mytribe/functions/src/lib/schema.ts`. */
export const INVITE_TTL_DAYS = 14;

export interface MintInviteInput {
  familyId: string;
  invitedEmail: string;
  secondaryLabel?: string;
  proposedRole?: MemberRole;
  proposedPermissions: MemberPermissions;
}

export interface MintInviteResult {
  inviteId: string;
}

/**
 * A sensible starting permission set for a new SECONDARY: they can talk to the
 * Auntie and read the feed, and nothing else. Billing, kin edits and home
 * access are grants the operator makes deliberately, not defaults.
 *
 * `kintales_only` is true because the server forces it true anyway; sending
 * false would be a lie the response would silently correct.
 */
export const DEFAULT_INVITE_PERMISSIONS: MemberPermissions = {
  billing_full: false,
  messaging_direct: true,
  messaging_group: true,
  kin_edit: false,
  kintales_only: true,
  home_access: false,
};

/**
 * Mints one invite and emails the claim link.
 *
 * `proposedPermissions` must carry ALL SIX booleans: the server's Zod schema
 * requires every key, so a partial object comes back as a validation failure,
 * not a merge. The local guards below cost no round trip and produce a message
 * the operator can act on.
 */
export async function mintInvite(input: MintInviteInput): Promise<MintInviteResult> {
  const familyId = input.familyId.trim();
  if (familyId === '') throw new Error('mintInvite requires a household id');

  const invitedEmail = input.invitedEmail.trim();
  if (invitedEmail === '') throw new Error('An email address is required to send an invite.');
  // Cheap shape check only. The server's z.string().email() is the real gate;
  // this exists so an obvious typo does not cost a round trip to say so.
  if (!invitedEmail.includes('@')) throw new Error(`"${invitedEmail}" is not an email address.`);

  const secondaryLabel = (input.secondaryLabel ?? '').trim();
  if (secondaryLabel.length > SECONDARY_LABEL_MAX) {
    throw new Error(`The label must be ${SECONDARY_LABEL_MAX} characters or fewer.`);
  }

  return call<
    {
      familyId: string;
      invitedEmail: string;
      secondaryLabel: string;
      proposedRole: MemberRole;
      proposedPermissions: MemberPermissions;
    },
    MintInviteResult
  >('mintInvite', {
    familyId,
    invitedEmail,
    // The server defaults a blank label to 'Folk' after sanitising; send its
    // default explicitly rather than an empty string it would have to guess at.
    secondaryLabel: secondaryLabel === '' ? 'Folk' : secondaryLabel,
    proposedRole: input.proposedRole ?? 'SECONDARY',
    proposedPermissions: { ...input.proposedPermissions, kintales_only: true },
  });
}

/** Marks an invite REVOKED. `acceptInvite` then refuses it permanently. */
export async function revokeInvite(inviteId: string): Promise<void> {
  const id = inviteId.trim();
  if (id === '') throw new Error('revokeInvite requires an invite id');
  await call<{ inviteId: string }, { ok: true }>('revokeInvite', { inviteId: id });
}

/**
 * Changes one or more permission flags on an existing member.
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
 * Distinct from `mintInvite`, which adds a SECONDARY to a household that
 * already has a portal account. This one resolves the kinfolk record's email,
 * ensures the MyTribe family envelope exists, and sends a PRIMARY claim.
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
