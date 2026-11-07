import { useEffect, useState } from 'react';
import { loadStaffNames } from '../api/staff';

const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * uid -> person, for a screen that stores a staff uid and must show a name
 * (#1564: the Gallery's uploader line printed `nppJNdMNYJfUigibGKUQj3n4obt2`).
 * Empty until the one shared `listStaff` read lands; a uid it does not know
 * keeps showing what it showed before.
 */
export function useStaffNames(): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(EMPTY);
  useEffect(() => {
    let live = true;
    void loadStaffNames().then((m) => {
      if (live) setNames(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return names;
}
