import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { FULL_PERMISSIONS, type MemberPermissions } from './schema';

/**
 * THE HOUSEHOLD MEMBER RECORD, ONE SHAPE (#1840, #2096).
 *
 * `families/{id}/members/{uid}` with `status: 'ACTIVE'` is what makes a login
 * part of a household: `resolveKinfolkUid` sends household notices only to
 * such a login (#1840), the Members panel lists it, and the rules read it.
 * `acceptInvite` is the reference writer. Every other path that attaches a
 * login to a household (`setKinfolkClaim`, the test-login scripts, the
 * after-release backfill) writes the same shape through this file, so there
 * is no second hand-rolled copy to drift.
 *
 * PURE, ON PURPOSE. No firebase-admin runtime import: the scripts under
 * `mytribe/scripts` load firebase-admin through their own guarded handle
 * (`scripts/lib/firebaseAdmin.ts`, #846), and a `FieldValue` from a second
 * module instance cannot be written by their Firestore client. So the caller
 * passes its own `FieldValue.serverTimestamp()` as `stamp`, and the reads
 * take the caller's own Firestore and Auth handles. `import type` is erased
 * at build.
 */

export interface ActiveMemberInput {
  uid: string;
  displayName: string | null;
  role: 'PRIMARY' | 'SECONDARY';
  secondaryLabel: string | null;
  permissions: MemberPermissions;
  /** When the invite was sent, or null when the login was linked without one. */
  invitedAt: unknown;
}

/** The ACTIVE member record, as `acceptInvite` writes it. `stamp` is the caller's server timestamp. */
export function activeMemberRecord(input: ActiveMemberInput, stamp: unknown): Record<string, unknown> {
  return {
    uid: input.uid,
    displayName: input.displayName,
    role: input.role,
    secondaryLabel: input.secondaryLabel,
    permissions: input.permissions,
    status: 'ACTIVE',
    invitedAt: input.invitedAt,
    joinedAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * The household's PRIMARY, for a login attached without an invite. Full
 * permissions, because a login with no member record is already treated as
 * the household's primary everywhere else (`hasKinfolkPerm`'s "legacy
 * primary", and `kinfolkBillingAccess` in the rules), so this records the
 * access it already has rather than granting more. `displayName` is the
 * login's email, as `acceptInvite` writes it.
 */
export function primaryMemberRecord(uid: string, displayName: string | null, stamp: unknown): Record<string, unknown> {
  return activeMemberRecord(
    { uid, displayName, role: 'PRIMARY', secondaryLabel: null, permissions: FULL_PERMISSIONS, invitedAt: null },
    stamp,
  );
}

/**
 * Is this a staff login, from its custom claims? The owner carries `admin`
 * (the rules' `isOwner()` reads nothing else), an Auntie carries `staffRole`,
 * and any future staff role carries `staffRole` too. `resolveKinfolkUid`
 * keeps its own copy of this test so the notice path loads no extra module.
 */
export function isStaffClaims(claims: Record<string, unknown> | null | undefined): boolean {
  if (!claims) return false;
  return claims['admin'] === true || 'staffRole' in claims;
}

/** Why a login is not made the household's PRIMARY. Each is a stop, never a guess. */
export type PrimaryLinkRefusal =
  /** No `families/{id}` envelope: nothing to be a member of. */
  | 'no_household'
  /** No sign-in account under that uid. */
  | 'no_login'
  /** A staff login. Staff are a household only by accepting its invite (#1840). */
  | 'staff_login'
  /** A member record exists and is not ACTIVE: the operator removed this login. Never resurrected. */
  | 'member_record_not_active'
  /** The login is linked to, or a member of, a different household. */
  | 'belongs_to_another_household'
  /** The household already has a different ACTIVE PRIMARY. */
  | 'household_has_primary';

export type PrimaryLinkDecision =
  | { action: 'none' }
  | { action: 'create_primary' }
  | { action: 'refuse'; why: PrimaryLinkRefusal };

/** What the decision needs, read once by {@link readPrimaryLinkFacts}. */
export interface PrimaryLinkFacts {
  householdExists: boolean;
  loginExists: boolean;
  /** The login's email, for the record's `displayName` (as `acceptInvite` writes it). Never printed. */
  email: string | null;
  /** This login's member record in THIS household: its status, or null when there is none. */
  memberStatus: string | null;
  /** The household's ACTIVE PRIMARY members. */
  activePrimaryUids: string[];
  /** A `staff/{uid}` record, an `admin` claim, or a `staffRole` claim. */
  isStaff: boolean;
  /** Whether `clients/{uid}.kinfolkIds` lists THIS household. */
  listedOnHousehold: boolean;
  /** Other households this login is listed on (`clients/{uid}.kinfolkIds`) or stamped on (`kinfolk.uid`). */
  otherHouseholds: string[];
}

/** PURE. Whether to make `uid` the household's ACTIVE PRIMARY, from {@link PrimaryLinkFacts}. */
export function decidePrimaryLink(uid: string, facts: PrimaryLinkFacts): PrimaryLinkDecision {
  if (!facts.householdExists) return { action: 'refuse', why: 'no_household' };
  if (!facts.loginExists) return { action: 'refuse', why: 'no_login' };
  if (facts.memberStatus === 'ACTIVE') return { action: 'none' };
  if (facts.memberStatus !== null) return { action: 'refuse', why: 'member_record_not_active' };
  if (facts.isStaff) return { action: 'refuse', why: 'staff_login' };
  if (facts.otherHouseholds.length > 0) return { action: 'refuse', why: 'belongs_to_another_household' };
  if (facts.activePrimaryUids.some((p) => p !== uid)) return { action: 'refuse', why: 'household_has_primary' };
  return { action: 'create_primary' };
}

/**
 * READS ONLY. Everything {@link decidePrimaryLink} needs about `uid` and
 * `familyId`. A missing login is a fact (`loginExists: false`); any other
 * read failure throws.
 */
export async function readPrimaryLinkFacts(
  deps: { db: Firestore; auth: Auth },
  familyId: string,
  uid: string,
): Promise<PrimaryLinkFacts> {
  const fs = deps.db;
  const [family, member, primaries, staff, client, stamped, user] = await Promise.all([
    fs.doc(`families/${familyId}`).get(),
    fs.doc(`families/${familyId}/members/${uid}`).get(),
    fs.collection(`families/${familyId}/members`).where('role', '==', 'PRIMARY').get(),
    fs.doc(`staff/${uid}`).get(),
    fs.doc(`clients/${uid}`).get(),
    fs.collection('kinfolk').where('uid', '==', uid).get(),
    deps.auth.getUser(uid).catch((err: unknown) => {
      if ((err as { code?: unknown })?.code === 'auth/user-not-found') return null;
      throw err;
    }),
  ]);
  const listed = (client.data() as { kinfolkIds?: unknown } | undefined)?.kinfolkIds;
  const others = new Set<string>();
  let listedHere = false;
  if (Array.isArray(listed)) {
    for (const id of listed) {
      if (id === familyId) listedHere = true;
      else if (typeof id === 'string' && id !== '') others.add(id);
    }
  }
  for (const d of stamped.docs) if (d.id !== familyId) others.add(d.id);
  const status = member.exists ? (member.data() as { status?: unknown } | undefined)?.status : undefined;
  const claims = (user?.customClaims ?? null) as Record<string, unknown> | null;
  return {
    householdExists: family.exists,
    loginExists: user !== null,
    email: typeof user?.email === 'string' && user.email !== '' ? user.email : null,
    memberStatus: member.exists ? (typeof status === 'string' ? status : 'UNKNOWN') : null,
    activePrimaryUids: primaries.docs
      .filter((d) => (d.data() as { status?: unknown }).status === 'ACTIVE')
      .map((d) => d.id),
    isStaff: staff.exists || isStaffClaims(claims),
    listedOnHousehold: listedHere,
    otherHouseholds: [...others].sort(),
  };
}

/** Plain words for a refusal, for a script's output or a callable's error. No ids. */
export function primaryLinkRefusalText(why: PrimaryLinkRefusal): string {
  switch (why) {
    case 'no_household':
      return 'the household has no portal record yet';
    case 'no_login':
      return 'there is no sign-in account for this login';
    case 'staff_login':
      return 'this is a staff login, and staff join a household only by accepting its invite';
    case 'member_record_not_active':
      return 'this login was removed from the household, and is not added back without a new invite';
    case 'belongs_to_another_household':
      return 'this login already belongs to another household';
    case 'household_has_primary':
      return 'the household already has a primary member';
  }
}
