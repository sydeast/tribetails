import { useEffect, useState } from 'react';
import { loadStaffNames, loadStaffRoles, type StaffRole } from '../api/staff';

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

const NO_ROLES: ReadonlyMap<string, StaffRole> = new Map();

/**
 * uid -> 'owner' | 'auntie', for the Activity Log's actor role (#1820). Shares
 * the one `listStaff` read with [useStaffNames]. Empty until it lands, and a
 * uid it does not hold keeps the role the entry stored.
 */
export function useStaffRoles(): ReadonlyMap<string, StaffRole> {
  const [roles, setRoles] = useState<ReadonlyMap<string, StaffRole>>(NO_ROLES);
  useEffect(() => {
    let live = true;
    void loadStaffRoles().then((m) => {
      if (live) setRoles(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return roles;
}
