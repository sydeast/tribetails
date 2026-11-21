import { call } from '../lib/fns';

/** What `addKinToUpcomingVisits` answers. */
export interface AddKinToUpcomingVisitsResult {
  /** The id the visits store for this Kin. */
  kinId: string;
  kinName: string | null;
  /** Upcoming visits that do not carry this Kin yet. */
  upcoming: number;
  /** Visits the call changed (0 for a preview). */
  added: number;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * addKinToUpcomingVisits (#1822): the owner's step for a Kin adopted after
 * visits were booked. `apply: false` asks how many upcoming visits do not
 * carry the Kin; `apply: true` adds the Kin to them. Owner only.
 */
export async function addKinToUpcomingVisits(
  kinfolkId: string,
  kinId: string,
  apply: boolean,
): Promise<AddKinToUpcomingVisitsResult> {
  const res = await call<
    { kinfolkId: string; kinId: string; apply: boolean },
    { ok?: unknown; kinId?: unknown; kinName?: unknown; upcoming?: unknown; added?: unknown }
  >('addKinToUpcomingVisits', { kinfolkId, kinId, apply });
  if (res?.ok !== true || typeof res.kinId !== 'string') throw new Error('addKinToUpcomingVisits: no answer');
  return {
    kinId: res.kinId,
    kinName: typeof res.kinName === 'string' && res.kinName.trim() !== '' ? res.kinName : null,
    upcoming: count(res.upcoming),
    added: count(res.added),
  };
}
