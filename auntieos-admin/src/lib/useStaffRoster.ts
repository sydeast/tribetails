import { useEffect, useState } from 'react';
import { loadStaffRoster, type StaffMember } from '../api/staff';

/**
 * The staff roster for `actorLabel` (#1962): null until the one shared
 * `listStaff` read lands, then the members. A failed read lands as an empty
 * roster, so a stamp reads as the plain fallback and never as an id.
 *
 * Null and empty are different on purpose. While it is null the screen has
 * nobody to name yet and leaves the "by ..." clause off.
 */
export function useStaffRoster(): readonly StaffMember[] | null {
  const [staff, setStaff] = useState<readonly StaffMember[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadStaffRoster().then((members) => {
      if (live) setStaff(members);
    });
    return () => {
      live = false;
    };
  }, []);
  return staff;
}
