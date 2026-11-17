import { useEffect, useState } from 'react';
import { getHouseholdKinRoster, type RosterKin } from '../api/kinRoster';

/**
 * Which Kin a visit covers (#1822, #1862, operator ruling 2026-11-12).
 *
 * EVERY VISIT COVERS EVERY KIN. That is the default, and with the "Choose Kin
 * for a visit" feature flag off no screen offers anything else. With the flag
 * on, New booking, New visit and the visit's own Kin row show the household's
 * Kin with every one ticked, and unticking narrows the visit.
 *
 * A choice is `null` for "every Kin" or the list of chosen ids. `null` rather
 * than the full list, so a Kin that joins the household while a form is open
 * is covered too, the way the form says.
 */
export type KinChoice = readonly string[] | null;

/** The household's Kin as a screen holds them while it asks the server. */
export type KinRosterState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; kin: RosterKin[]; chooseKin: boolean }
  | { status: 'error' };

/**
 * The server's Kin for one household. `idle` while no household is picked.
 *
 * Asked again whenever the household changes, never cached: the flag and the
 * roster can both change between two bookings.
 */
export function useHouseholdKinRoster(kinfolkId: string): KinRosterState {
  const [state, setState] = useState<KinRosterState>({ status: 'idle' });

  useEffect(() => {
    if (kinfolkId.trim() === '') {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    getHouseholdKinRoster(kinfolkId).then(
      (answer) => {
        if (live) setState({ status: 'ready', ...answer });
      },
      (err: unknown) => {
        console.warn('[kinRoster] could not read the Kin of this household', err);
        if (live) setState({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  return kinfolkId.trim() === '' ? { status: 'idle' } : state;
}

/** One Kin's display name, never blank. */
export function rosterKinLabel(k: Pick<RosterKin, 'name'>): string {
  const name = (k.name ?? '').trim();
  return name === '' ? 'Unnamed Kin' : name;
}

/** Whether specific Kin can be chosen right now. Never while the answer is unknown. */
export function canChooseKin(roster: KinRosterState): boolean {
  return roster.status === 'ready' && roster.chooseKin && roster.kin.length > 0;
}

/** The Kin of [roster] that [choice] covers. */
export function chosenKin(choice: KinChoice, roster: readonly RosterKin[]): RosterKin[] {
  if (choice === null) return [...roster];
  return roster.filter((k) => choice.includes(k.id));
}

/**
 * Ticks or unticks one Kin. Ticking the last unticked Kin is "every Kin"
 * again, so the form never holds a full list that would leave out a Kin added
 * a moment later.
 */
export function toggleKinChoice(choice: KinChoice, kinId: string, roster: readonly RosterKin[]): KinChoice {
  const ids = roster.map((k) => k.id);
  const current = choice === null ? ids : ids.filter((id) => choice.includes(id));
  const next = current.includes(kinId) ? current.filter((id) => id !== kinId) : ids.filter((id) => id === kinId || current.includes(id));
  return next.length === ids.length ? null : next;
}

/**
 * The `kinIds` a booking call sends. Empty means every Kin: the server stores
 * the whole roster for it. Always empty unless Kin can be chosen, so a form
 * left open across a flag change cannot send a stale narrowing.
 */
export function kinIdsToSend(choice: KinChoice, roster: KinRosterState): string[] {
  if (choice === null || !canChooseKin(roster) || roster.status !== 'ready') return [];
  return chosenKin(choice, roster.kin).map((k) => k.id);
}

/** True when Kin can be chosen and none is: the one state a form must not submit. */
export function noKinChosen(choice: KinChoice, roster: KinRosterState): boolean {
  return canChooseKin(roster) && roster.status === 'ready' && chosenKin(choice, roster.kin).length === 0;
}

/**
 * The choice a saved visit's stored ids make against today's roster, for the
 * visit's own Kin row. Some older visits stored the Kin's MyTribe card id, so
 * either id ticks the Kin.
 */
export function choiceFromStoredIds(storedIds: readonly string[], roster: readonly RosterKin[]): string[] {
  return roster.filter((k) => storedIds.includes(k.id) || (k.householdId !== null && storedIds.includes(k.householdId))).map((k) => k.id);
}
