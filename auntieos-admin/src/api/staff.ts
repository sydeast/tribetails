import { call } from '../lib/fns';

/**
 * The staff roster, for the Assigned Auntie picker on the Schedule booking
 * detail sheet.
 *
 * Wraps the DEPLOYED `listStaff` admin callable
 * (`mytribe/functions/src/admin/listStaff.ts`), which reads one doc per staff
 * member from `staff/{uid}` and returns `{ staff: StaffMemberDto[] }` already
 * sorted by display name. No new backend: this is the client half that never
 * got written.
 *
 * Loaded LAZILY (first time the operator opens the picker), not on every
 * detail open, matching the archive's `LaunchedEffect(pickerOpen)`. The
 * roster is a handful of docs, but it is one extra callable round trip per
 * modal open for a control most opens never touch.
 */
export interface StaffMember {
  uid: string;
  /**
   * The name to show. Since #1564 the server fills a staff record with no name
   * from the sign-in account's display name, then an email.
   */
  displayName: string | null;
  email: string | null;
  /**
   * #1820: 'owner' or 'auntie', from the sign-in account's claims. Null when
   * the server could not tell (or is an older deploy that does not say).
   */
  role?: StaffRole | null;
}

/** Which side of the admin/Auntie split a staff account is on. */
export type StaffRole = 'owner' | 'auntie';

function staffRole(v: unknown): StaffRole | null {
  return v === 'owner' || v === 'auntie' ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Fetch the roster. Rows with no `uid` are DROPPED rather than rendered: the
 * uid is what `assignAuntie` writes, so a row without one is an unassignable
 * picker entry, i.e. exactly the dead control `Buttons.tsx` exists to prevent.
 *
 * Throws (via `lib/fns.call`) on auth/permission failures; the caller surfaces
 * the message inline with a retry rather than showing an empty roster, which
 * would read as "no staff exist".
 */
export async function listStaff(): Promise<StaffMember[]> {
  const res = await call<Record<string, never>, { staff?: unknown }>('listStaff', {});
  const rows = Array.isArray(res?.staff) ? res.staff : [];
  return rows
    .map((row) => (row ?? {}) as Record<string, unknown>)
    .filter((row) => typeof row.uid === 'string' && row.uid !== '')
    .map((row) => ({
      uid: row.uid as string,
      displayName: str(row.displayName),
      email: str(row.email),
      role: staffRole(row.role),
    }));
}

/**
 * uid -> the byline a screen shows for a staff member who wrote, uploaded or
 * saved something (#1564: the Gallery's uploader line showed a raw uid).
 */
export function staffNamesByUid(staff: readonly StaffMember[]): Map<string, string> {
  return new Map(staff.map((m) => [m.uid, staffByline(m)]));
}

/** True for a value shaped like an email address, which is never a name. */
export function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

/**
 * The word a byline uses for a staff member with no name on file (#1882): the
 * same words the visit notes already sign with. Never an email, never a uid.
 */
export function staffRoleWord(role: StaffRole | null | undefined): string {
  if (role === 'owner') return 'Office';
  if (role === 'auntie') return 'Auntie';
  return 'Staff';
}

/**
 * A person's byline (#1882): their name, else the word for their role. An
 * email stored as a display name is not a name. The picker keeps
 * `staffLabel` below, which must tell two unnamed Aunties apart (#1857).
 */
export function staffByline(member: StaffMember): string {
  const name = (member.displayName ?? '').trim();
  return name !== '' && !looksLikeEmail(name) ? name : staffRoleWord(member.role);
}

/**
 * uid -> role, for the Activity Log's "Actor role" (#1820). Only staff the
 * server could place are in it; a uid that is absent is not relabelled.
 */
export function staffRolesByUid(staff: readonly StaffMember[]): Map<string, StaffRole> {
  const out = new Map<string, StaffRole>();
  for (const m of staff) if (m.role != null) out.set(m.uid, m.role);
  return out;
}

let staffRosterOnce: Promise<StaffMember[]> | null = null;
let staffNamesOnce: Promise<Map<string, string>> | null = null;

/**
 * The staff roster, read once per page load and shared by every caller
 * (`loadStaffNames` and `useStaffRoster` both sit on this one read). A failed
 * read resolves to an empty roster (and is retried on the next call), so a
 * screen that only wants to name a person never fails over it.
 */
export function loadStaffRoster(): Promise<StaffMember[]> {
  if (staffRosterOnce === null) {
    staffRosterOnce = listStaff().catch(() => {
      staffRosterOnce = null;
      staffNamesOnce = null;
      return [];
    });
  }
  return staffRosterOnce;
}

/**
 * The staff names, read once per page load and shared by every caller. A
 * failed read resolves to an empty map (and is retried on the next call), so a
 * screen that only wants nicer labels never fails over it.
 */
export function loadStaffNames(): Promise<Map<string, string>> {
  if (staffNamesOnce === null) staffNamesOnce = loadStaffRoster().then(staffNamesByUid);
  return staffNamesOnce;
}

/** The staff roles (#1820), from the same roster read as the names. */
export function loadStaffRoles(): Promise<Map<string, StaffRole>> {
  return loadStaffRoster().then(staffRolesByUid);
}

/** Test seam: forget the cached read. */
export function resetStaffNamesForTest(): void {
  staffRosterOnce = null;
  staffNamesOnce = null;
}

/**
 * #1857: the staff member's name, and nothing else. `listStaff` fills a
 * nameless record with the sign-in email, which is not a name; neither is the
 * uid. Null when the roster holds no name for them.
 */
export function staffName(member: StaffMember): string | null {
  const name = (member.displayName ?? '').trim();
  if (name === '' || looksLikeEmail(name) || name === member.uid) return null;
  return name;
}

/**
 * #1857: what Staffing calls a staff member: their name, else the role they
 * hold. The Assigned Auntie picker and row never show a sign-in email or a
 * uid. Never blank, so a picker button always has a name.
 */
export function staffPersonLabel(member: StaffMember): string {
  return staffName(member) ?? staffRoleWord(member.role);
}

/**
 * #1857: the Assigned Auntie row. The name stored with the assignment when it
 * is one, else the roster's label for that uid, else "Assigned" only while the
 * roster has not answered.
 */
export function assignedAuntieLabel(
  assignedUid: string | null,
  storedName: string | null,
  roster: readonly StaffMember[] | null,
): string {
  if (assignedUid === null) return 'Unassigned';
  const stored = (storedName ?? '').trim();
  if (stored !== '' && !looksLikeEmail(stored)) return stored;
  const member = roster?.find((m) => m.uid === assignedUid);
  if (member !== undefined) return staffPersonLabel(member);
  // An empty roster is a read that failed (`loadStaffRoster` resolves [] then), not proof of who it is.
  return roster === null || roster.length === 0 ? 'Assigned' : staffRoleWord(null);
}

/** The picker label: display name, then email, then the uid. Never blank, so
 *  the control always has an accessible name. */
export function staffLabel(member: StaffMember): string {
  const name = (member.displayName ?? '').trim();
  if (name !== '') return name;
  const email = (member.email ?? '').trim();
  if (email !== '') return email;
  return member.uid;
}
