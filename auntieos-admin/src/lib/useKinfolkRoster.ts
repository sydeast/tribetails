import { useMemo } from 'react';
import { KINFOLK_QUERY, sortKinfolkRoster, type Kinfolk } from '../api/directory';
import type { Async } from './async';
import { useCollection } from './firestore';
/**
 * The kinfolk roster, A to Z, with EVERY record in it (#1565).
 *
 * `KINFOLK_QUERY` pages by document id so that Firestore never drops a record
 * missing a sort field; this hook puts the display order back on the client.
 * Every screen and picker that lists households reads through here, so a
 * kinfolk with no last name appears in all of them.
 */
export function useKinfolkRoster(): Async<Kinfolk[]> {
  const state = useCollection<Kinfolk>(KINFOLK_QUERY);
  return useMemo(
    () => (state.status === 'ready' ? { ...state, data: sortKinfolkRoster(state.data) } : state),
    [state],
  );
}
