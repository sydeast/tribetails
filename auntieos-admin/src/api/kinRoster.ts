import { call } from '../lib/fns';

/** One Kin a visit can cover. */
export interface RosterKin {
  /** The id a visit stores for this Kin: its admin record's when it has one. */
  id: string;
  /** Null when the Kin has no name on file. */
  name: string | null;
  /** The Kin's own card in MyTribe, when its id differs from [id]. Some older visits stored this one. */
  householdId: string | null;
}

export interface HouseholdKinRoster {
  /** The household's active Kin: the ones a new visit covers. */
  kin: RosterKin[];
  /**
   * Whether specific Kin can be chosen for a visit (the "Choose Kin for a
   * visit" feature flag). False, the default: every visit covers every Kin,
   * and no screen shows a picker.
   */
  chooseKin: boolean;
}

/**
 * getHouseholdKinRoster (#1822, #1862): the Kin a visit for this household
 * covers, as the server will store them, and whether they may be narrowed.
 *
 * Every Kin list on a booking screen comes from here. The wizard used to read
 * the admin `kin` records itself and listed six Kin for a booking the server
 * then wrote for three.
 */
export async function getHouseholdKinRoster(kinfolkId: string): Promise<HouseholdKinRoster> {
  const res = await call<{ kinfolkId: string }, { kin?: unknown; chooseKin?: unknown }>(
    'getHouseholdKinRoster',
    { kinfolkId },
  );
  if (!Array.isArray(res?.kin)) throw new Error('getHouseholdKinRoster: no answer');
  const kin: RosterKin[] = [];
  for (const row of res.kin as unknown[]) {
    const r = (row ?? {}) as { id?: unknown; name?: unknown; householdId?: unknown };
    if (typeof r.id !== 'string' || r.id === '') continue;
    kin.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : null,
      householdId: typeof r.householdId === 'string' && r.householdId !== '' && r.householdId !== r.id ? r.householdId : null,
    });
  }
  return { kin, chooseKin: res.chooseKin === true };
}
