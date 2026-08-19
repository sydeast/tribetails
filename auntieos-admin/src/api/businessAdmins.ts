import { call } from '../lib/fns';
import { arr, str } from '../lib/coerce';

/**
 * WHO "every business admin" is, by name (issue #450).
 *
 * The notification gate resolves every other audience to a description of a
 * person. A `businessAdmins` row could only manage a count and a Firestore
 * path, because nothing read the roster back: `businessSettings/admins` has a
 * write surface (`provisionBusinessAdmins` and friends) and had no reader any
 * client could call. This module is the web side of `listBusinessAdmins`
 * (mytribe/functions/src/admin/provisionBusinessAdmins.ts), added in the same
 * change.
 *
 * STAFF DATA, ADMIN ONLY. The callable is behind `wrapAdminCallable` and there
 * is no kinfolk-facing caller of any of this. `businessSettings` has no client
 * read rule either, so a callable is the only way to read it at all.
 */

export interface BusinessAdminMember {
  uid: string;
  /** From `staff/{uid}`. Null when there is no staff record, or it carries no name. */
  displayName: string | null;
  email: string | null;
  /**
   * False when this uid has no `staff/{uid}` document. Not an error: an
   * operator seeded from the `AUNTIE_OPERATOR_UIDS` allowlist can have none,
   * and they receive the mail regardless, so they are listed with their uid.
   */
  hasStaffRecord: boolean;
  /** True when unassigned visits default to this person. */
  defaultAssignee: boolean;
}

/** Which arm of the server's recipient order answered. */
export type BusinessAdminRosterSource = 'roster' | 'operatorAllowlist' | 'none';

export interface BusinessAdminRoster {
  members: BusinessAdminMember[];
  source: BusinessAdminRosterSource;
  /** Where the roster lives, for an operator who wants to check it. */
  rosterPath: string;
  /** Why nobody is on it, when nobody is. Null when there are members. */
  reason: string | null;
}

interface RawMember {
  uid?: string;
  displayName?: string | null;
  email?: string | null;
  hasStaffRecord?: boolean;
  defaultAssignee?: boolean;
}

interface RawRoster {
  members?: RawMember[];
  source?: string;
  rosterPath?: string;
  reason?: string | null;
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function decodeSource(raw: unknown): BusinessAdminRosterSource {
  return raw === 'roster' || raw === 'operatorAllowlist' || raw === 'none' ? raw : 'none';
}

function decodeMember(raw: RawMember): BusinessAdminMember {
  return {
    uid: str(raw.uid),
    displayName: nullableStr(raw.displayName),
    email: nullableStr(raw.email),
    // An absent flag reads as "no staff record", so the screen shows the uid
    // rather than claiming a name it was never given.
    hasStaffRecord: raw.hasStaffRecord === true,
    defaultAssignee: raw.defaultAssignee === true,
  };
}

/** Everyone a business notification reaches right now. Never writes anything. */
export async function listBusinessAdmins(): Promise<BusinessAdminRoster> {
  const raw = await call<Record<string, never>, RawRoster>('listBusinessAdmins', {});
  return {
    members: arr<RawMember>(raw.members).map(decodeMember),
    source: decodeSource(raw.source),
    rosterPath: str(raw.rosterPath) || 'businessSettings/admins.uids',
    reason: nullableStr(raw.reason),
  };
}
