import { useEffect, useState } from 'react';
import { loadSharedWorkSettings } from './useWorkSettings';

/**
 * ISSUE #1608: is "Verify arrival and departure" on? Only a stored `true` is
 * on (`lib/completeRule.ts`), on both reads below.
 *
 * #2164: the owner reads it off the settings document as before; an Auntie,
 * who cannot read that document, gets it from the narrow staff read. Before
 * that her read failed every time and the rule was never known on her board.
 *
 * One read for every card on a board: it joins the shared work-settings read
 * (keyed by the signed-in session), so twenty Auntie Time cards and the board's
 * own notice make one request. Held for a minute here; a switch flipped in
 * Settings while a board is open is still caught by the server.
 */
export const ARRIVAL_RULE_TTL_MS = 60 * 1000;

export async function loadArrivalRule(): Promise<boolean> {
  return (await loadSharedWorkSettings(ARRIVAL_RULE_TTL_MS)).requireArrivalDepartureVerification;
}

/**
 * The rule, or null while it loads or when it could not be read. A failed read
 * stays null rather than guessing either way: `completeRefusal` lets a null
 * through and the server decides, exactly as before this check existed. The
 * board says so out loud through `useWorkSettings`.
 */
export function useArrivalRule(): boolean | null {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    loadArrivalRule()
      .then((v) => {
        if (live) setRequired(v);
      })
      .catch(() => {
        if (live) setRequired(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return required;
}
