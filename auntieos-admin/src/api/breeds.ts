import { useEffect, useState } from 'react';
import { call } from '../lib/fns';

/**
 * The seeded dog / cat breed banks behind the Kin breed dropdown, read through
 * the `getBreeds` callable (`mytribe/functions/src/portal/getBreeds.ts`), which
 * reads the `dog_breeds` (478) and `cat_breeds` (103) collections with the Admin
 * SDK and returns their names sorted.
 *
 * A callable rather than a direct read, and that is not a style choice: those
 * two collections have no `allow read` rule of their own, so a client read would
 * be denied. The callable's Admin SDK read bypasses rules, which is why no rule
 * change was needed to ship this originally and why none is needed to restore
 * it. The Kotlin admin reaches the same callable
 * (`FirestoreClient.kt#breeds`), so both surfaces see one bank.
 */

export interface BreedBanks {
  dogBreeds: string[];
  catBreeds: string[];
}

export const EMPTY_BREED_BANKS: BreedBanks = { dogBreeds: [], catBreeds: [] };

/**
 * Pure decode of the callable body. Anything that is not an array of strings
 * decodes to an empty list rather than throwing: a malformed or partial response
 * degrades the field to free text, which is a working field, where a throw would
 * take the whole Kin editor down over a dropdown.
 *
 * It is exported because that "no fabricated breeds" rule is the part worth
 * pinning in a test, and the Kotlin twin (`decodeBreedLists`) has one.
 */
export function decodeBreedBanks(data: unknown): BreedBanks {
  const obj = (data ?? {}) as Record<string, unknown>;
  const names = (key: string): string[] => {
    const raw = obj[key];
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  };
  return { dogBreeds: names('dogBreeds'), catBreeds: names('catBreeds') };
}

/**
 * One in-flight request and one resolved value per page load. The bank is a
 * seeded catalog that changes on the order of never, and the Kin editor, the
 * Add-kin dialog and any future kin form would otherwise each pay a cold-start
 * callable round trip for the same 581 strings.
 *
 * A FAILED load is deliberately not cached. The failure mode this protects
 * against is a cold start or a dropped POST, and caching that would leave the
 * field degraded to free text for the rest of the session with no way back.
 */
let inFlight: Promise<BreedBanks> | null = null;
let cached: BreedBanks | null = null;

export async function getBreeds(): Promise<BreedBanks> {
  if (cached !== null) return cached;
  if (inFlight === null) {
    inFlight = call<Record<string, never>, unknown>('getBreeds', {})
      .then((data) => {
        cached = decodeBreedBanks(data);
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Test seam: drops the memoized bank so a suite can control what the next call resolves to. */
export function resetBreedCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * Subscribe a form to the breed banks.
 *
 * A load failure resolves to EMPTY banks rather than an error state, and the
 * caller is told through `failed` so it can DISCLOSE the degradation next to the
 * field ("Breed list unavailable here, type it in.") instead of silently
 * offering an empty dropdown. Fail-loud, but not fatal: breed stays free text,
 * so a fault in a catalog read never blocks saving a pet.
 */
export function useBreedBanks(): { banks: BreedBanks; loading: boolean; failed: boolean } {
  const [banks, setBanks] = useState<BreedBanks>(cached ?? EMPTY_BREED_BANKS);
  const [loading, setLoading] = useState(cached === null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await getBreeds();
        if (!live) return;
        setBanks(next);
        setFailed(false);
      } catch {
        if (!live) return;
        setBanks(EMPTY_BREED_BANKS);
        setFailed(true);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return { banks, loading, failed };
}
