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
    }));
}

/**
 * uid -> the label `staffLabel` gives, for screens that hold a staff uid and
 * must show a person (#1564: the Gallery's uploader line showed a raw uid).
 */
export function staffNamesByUid(staff: readonly StaffMember[]): Map<string, string> {
  return new Map(staff.map((m) => [m.uid, staffLabel(m)]));
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

/** Test seam: forget the cached read. */
export function resetStaffNamesForTest(): void {
  staffRosterOnce = null;
  staffNamesOnce = null;
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
