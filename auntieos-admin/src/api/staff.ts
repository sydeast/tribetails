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

/** The picker label: display name, then email, then the uid. Never blank, so
 *  the control always has an accessible name. */
export function staffLabel(member: StaffMember): string {
  const name = (member.displayName ?? '').trim();
  if (name !== '') return name;
  const email = (member.email ?? '').trim();
  if (email !== '') return email;
  return member.uid;
}
