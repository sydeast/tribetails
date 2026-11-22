import { useEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';

export interface KinRoute {
  id: string;
  edit: boolean;
}

export interface KinSearch {
  kin?: string;
  kinView?: string;
}

/** How deep the address is: 0 no Kin, 1 the Kin page, 2 its edit form. Pure. */
export function kinDepth(kin: string | undefined, kinView: string | undefined): number {
  if (kin === undefined) return 0;
  return kinView === 'edit' ? 2 : 1;
}

/** The search params for a Kin address. Pure. */
export function kinSearch(next: KinRoute | null): KinSearch {
  if (next === null) return {};
  return next.edit ? { kin: next.id, kinView: 'edit' } : { kin: next.id };
}

/**
 * #1893: the Kin page and its edit form as addresses, so reload stays put and
 * Back returns to the page before. Going deeper pushes an entry. Coming back
 * pops the entries this mount pushed, and otherwise (opened cold, by a reload
 * or a link) replaces, so Back from the profile still leaves the profile.
 */
export function useKinRoute(
  kin: string | undefined,
  kinView: string | undefined,
  go: (search: KinSearch, replace: boolean) => void,
) {
  const router = useRouter();
  const pushed = useRef(0);
  const depth = kinDepth(kin, kinView);

  // Browser Back moves the address without a call here, so the count follows it.
  useEffect(() => {
    pushed.current = Math.min(pushed.current, depth);
  }, [depth]);

  const routedKin: KinRoute | null = kin === undefined ? null : { id: kin, edit: kinView === 'edit' };

  function onKinRouteChange(next: KinRoute | null) {
    const target = next === null ? 0 : next.edit ? 2 : 1;
    if (target > depth) {
      pushed.current += target - depth;
      go(kinSearch(next), false);
      return;
    }
    if (target < depth && pushed.current >= depth - target) {
      pushed.current -= depth - target;
      router.history.go(target - depth);
      return;
    }
    if (target < depth) pushed.current = 0;
    go(kinSearch(next), true);
  }

  return { routedKin, onKinRouteChange };
}
