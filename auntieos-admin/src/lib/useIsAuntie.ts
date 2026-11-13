import { useEffect, useState } from 'react';
import { currentSessionSeat } from './sessionSeat';

/**
 * Is an Auntie signed in? For picking COPY only (#2185).
 *
 * Operator ruling 2026-11-13: an Auntie never sees Business Settings or
 * Templates, so a line that tells the owner "change it in Settings" must not
 * send her there. Screens ask this once and pass the answer to the line.
 *
 * `false` until the token is read, and on any failure: the owner's wording is
 * the default, it is only a sentence, and nothing here decides what she can
 * read or do (the rules and the callable gate do that). Built on
 * `currentSessionSeat`, the same reading the #2164 staff reads use, so a
 * double-claimed account reads as her here as it does everywhere else.
 *
 * Its own module, not `lib/access.ts`: several tests mock that module with a
 * bare `{ useAdminAccess }`, and a new export there would break them.
 */
export function useIsAuntie(): boolean {
  const [auntie, setAuntie] = useState(false);
  useEffect(() => {
    let live = true;
    void currentSessionSeat()
      .then((seat) => {
        if (live) setAuntie(seat.caretaker);
      })
      .catch(() => {
        // The owner's wording stands.
      });
    return () => {
      live = false;
    };
  }, []);
  return auntie;
}
