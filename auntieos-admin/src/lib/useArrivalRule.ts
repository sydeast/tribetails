import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { BUSINESS_SETTINGS_DOC_ID } from '../api/settings';
import { arrivalRuleRequired } from './completeRule';
import { sharedLoad } from './useSharedOneShot';

/**
 * ISSUE #1608: is "Verify arrival and departure" on? Read off the RAW settings
 * document, because the rule reads absent as off and the settings model
 * defaults it to on (see `lib/completeRule.ts`).
 *
 * One read for every card on a board: the key is shared, so twenty Auntie Time
 * cards mounting together make one `getDoc`. Held for a minute; a switch
 * flipped in Settings while a board is open is still caught by the server.
 */
export const ARRIVAL_RULE_TTL_MS = 60 * 1000;

export async function loadArrivalRule(): Promise<boolean> {
  const snap = await getDoc(doc(db, 'business_settings', BUSINESS_SETTINGS_DOC_ID));
  return arrivalRuleRequired(snap.exists() ? (snap.data() as Record<string, unknown>) : undefined);
}

/**
 * The rule, or null while it loads or when it could not be read. A failed read
 * stays null rather than guessing either way: `completeRefusal` lets a null
 * through and the server decides, exactly as before this check existed.
 */
export function useArrivalRule(): boolean | null {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    sharedLoad('business_settings.requireArrivalDepartureVerification', loadArrivalRule, ARRIVAL_RULE_TTL_MS)
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
