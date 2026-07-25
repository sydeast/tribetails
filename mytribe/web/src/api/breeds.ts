import { call } from '../lib/fns';

/**
 * The seeded dog / cat breed banks behind the Kin breed dropdown, from the
 * `getBreeds` callable (`functions/src/portal/getBreeds.ts`). It reads the
 * `dog_breeds` (478) and `cat_breeds` (103) collections with the Admin SDK and
 * returns their names sorted.
 *
 * A callable rather than a direct read because neither collection has an
 * `allow read` rule of its own: the Admin SDK read is what makes the bank
 * reachable from a client at all. Signed-in only, same as every portal read.
 */

export interface BreedBanks {
  dogBreeds: string[];
  catBreeds: string[];
}

export const EMPTY_BREED_BANKS: BreedBanks = { dogBreeds: [], catBreeds: [] };

/**
 * Pure decode of the callable body. A non-array, or an entry that is not a
 * non-blank string, decodes to nothing rather than throwing: a malformed
 * response degrades the field to the free text it already was, where a throw
 * would take the whole Kin editor down over a dropdown. No fabricated breeds.
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

export async function getBreeds(): Promise<BreedBanks> {
  return decodeBreedBanks(await call<Record<string, never>, unknown>('getBreeds', {}));
}

/**
 * Query options for the bank. The catalog is seeded data that changes on the
 * order of never, so it is cached for the session rather than refetched on
 * every mount of the editor; `retry: 1` keeps a cold start from surfacing as a
 * permanent free-text degradation on the first try.
 */
export const BREEDS_QUERY = {
  queryKey: ['breeds'] as const,
  queryFn: getBreeds,
  staleTime: Infinity,
  gcTime: Infinity,
  retry: 1,
};
