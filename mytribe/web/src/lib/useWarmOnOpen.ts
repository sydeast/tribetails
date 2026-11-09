import { useEffect, useRef } from 'react';
import { warmSave, type WarmableSave } from './warmSave';

/**
 * #1504: warm [name]'s instance once when the form holding this hook opens.
 *
 * Mount it in the FORM's own component, not the route: a booking note or a
 * share link form opens on a tap, long after its screen did, and that tap is
 * the intent worth acting on.
 *
 * Once per open. A ref, not the effect's dependency list, is what holds it to
 * one call: a re-render never fires again, and neither does React StrictMode's
 * dev-only unmount and remount of the same instance, which keeps the ref.
 * Closing the form and opening it again is a new open and warms again.
 *
 * [enabled] lets a form that mounts before it can save (a wizard still loading
 * its catalog, an editor for a Kin that has not arrived) wait until it can;
 * the first render with `enabled` true is the open.
 */
export function useWarmOnOpen(name: WarmableSave, enabled = true): void {
  const fired = useRef(false);
  useEffect(() => {
    if (!enabled || fired.current) return;
    fired.current = true;
    void warmSave(name);
  }, [name, enabled]);
}
