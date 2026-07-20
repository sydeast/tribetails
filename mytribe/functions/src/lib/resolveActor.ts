import { db } from './firestoreAdmin';

export interface ResolvedActor {
  actorName: string | null;
  actorPhotoUrl: string | null;
}

/**
 * AO-28: best-effort display name + photo for a notification's ACTOR (whoever
 * caused it), so a NotificationEntry can render "Nora sent a visit report" with
 * an avatar instead of a bare catalog key. Looks in `staff` first (the operator
 * / Aunties), then `kinfolk` (a client actor). Never throws: an absent or
 * unresolvable actor yields nulls, and actor enrichment must never block or fail
 * a dispatch.
 */
export async function resolveActor(uid: string | null | undefined): Promise<ResolvedActor> {
  if (!uid) return { actorName: null, actorPhotoUrl: null };
  try {
    const staff = await db().collection('staff').doc(uid).get();
    if (staff.exists) {
      const d = (staff.data() ?? {}) as Record<string, unknown>;
      const name = (typeof d.displayName === 'string' && d.displayName) || null;
      const photo =
        (typeof d.photoUrl === 'string' && d.photoUrl) ||
        (typeof d.photoURL === 'string' && d.photoURL) ||
        (typeof d.avatarUrl === 'string' && d.avatarUrl) ||
        null;
      if (name || photo) return { actorName: name, actorPhotoUrl: photo };
    }
    const kin = await db().collection('kinfolk').doc(uid).get();
    if (kin.exists) {
      const d = (kin.data() ?? {}) as Record<string, unknown>;
      const first = typeof d.firstName === 'string' ? d.firstName : '';
      const last = typeof d.lastName === 'string' ? d.lastName : '';
      const name = `${first} ${last}`.trim() || null;
      const photo = (typeof d.profilePictureUrl === 'string' && d.profilePictureUrl) || null;
      return { actorName: name, actorPhotoUrl: photo };
    }
  } catch {
    // Best-effort: fall through to nulls rather than fail the dispatch.
  }
  return { actorName: null, actorPhotoUrl: null };
}
