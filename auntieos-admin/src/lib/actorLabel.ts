import type { StaffMember } from '../api/staff';

/**
 * #1962: the name a screen prints for whoever did something, from the stamp a
 * record holds for them.
 *
 * A stamp is a staff uid (what the server writes), or on older records the
 * sign-in email, or some other string. None of those is a name, so THE STAMP IS
 * NEVER RETURNED: the answer is the staff member's display name, or `fallback`
 * when nobody on the roster answers to it, or when the only label the roster
 * has for them is itself an email or the uid (`listStaff` fills a nameless
 * record from the sign-in account, down to its email).
 *
 * `''` means there is nothing to print yet: the stamp is blank, or the roster
 * has not been read (`staff` is null). A caller drops its "by ..." clause then,
 * so the line never shows a guess that changes a moment later.
 *
 * Shared on purpose. The Kotlin twin is `ui/admin/ActorLabel.kt`.
 */
export const ADMIN_ACTOR_FALLBACK = 'an Admin';

function looksLikeEmail(s: string): boolean {
  return s.includes('@');
}

function same(a: string | null, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.toLowerCase();
}

export function actorLabel(
  stamp: string | null | undefined,
  staff: readonly StaffMember[] | null,
  fallback: string = ADMIN_ACTOR_FALLBACK,
): string {
  const who = (stamp ?? '').trim();
  if (who === '' || staff === null) return '';
  const member =
    staff.find((m) => m.uid === who) ??
    // An email stamp: the staff record's own email, or the sign-in email the
    // server put in the name's place.
    (looksLikeEmail(who) ? staff.find((m) => same(m.email, who) || same(m.displayName, who)) : undefined);
  const name = (member?.displayName ?? '').trim();
  if (member === undefined || name === '' || looksLikeEmail(name) || name === member.uid || name === who) {
    return fallback;
  }
  return name;
}
