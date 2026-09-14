import { useSyncExternalStore } from 'react';
import type { NewKinfolkInput } from '../api/directoryWrite';
import type { EmergencyContactDraft } from '../api/emergencyContacts';

/**
 * #890: a household Add Kinfolk created whose Emergency Contact has not saved yet.
 *
 * Add creates the household, then saves its contact. When the contact save
 * failed and the operator closed the dialog, the created id used to live only in
 * the dialog's state and was gone, so the next Add made a second household. This
 * keeps it outside the dialog, per operator, for the rest of the browser session,
 * until the contact saves or the operator chooses Discard. Admin Android keeps the
 * same thing in DirectoryViewModel (`leaveAddKinfolk`).
 *
 * SESSION STORAGE, with a copy in memory. Storage carries it across a reload
 * within the tab. Every access is wrapped because storage throws outright in some
 * privacy modes, and then the in-memory copy still carries it for this page.
 *
 * DISCARD writes nothing to the server. The household stays as it was created,
 * with its No Emergency Contact flag, and is fixed from its own profile.
 */

export const PENDING_ADD_KINFOLK_STORAGE_PREFIX = 'auntieos.pendingAddKinfolk.';

export interface PendingAddKinfolk {
  kinfolkId: string;
  /** The household fields as they were saved, shown locked when Add continues. */
  household: NewKinfolkInput;
  /** The contact as last typed, so continuing does not make the operator retype it. */
  contacts: EmergencyContactDraft[];
}

const memory = new Map<string, PendingAddKinfolk>();
const listeners = new Set<() => void>();
/** The last value handed to each uid's subscribers, so useSyncExternalStore sees a stable reference. */
const snapshots = new Map<string, PendingAddKinfolk | null>();

function key(uid: string): string {
  return `${PENDING_ADD_KINFOLK_STORAGE_PREFIX}${uid}`;
}

function isPending(v: unknown): v is PendingAddKinfolk {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['kinfolkId'] === 'string' &&
    o['kinfolkId'] !== '' &&
    !!o['household'] &&
    typeof o['household'] === 'object' &&
    Array.isArray(o['contacts'])
  );
}

function load(uid: string): PendingAddKinfolk | null {
  try {
    const raw = sessionStorage.getItem(key(uid));
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      return isPending(parsed) ? parsed : null;
    }
    // Nothing stored: either there is nothing pending, or storage refused the write.
    return memory.get(uid) ?? null;
  } catch {
    return memory.get(uid) ?? null;
  }
}

function notify(uid: string): void {
  snapshots.delete(uid);
  for (const l of listeners) l();
}

export function readPendingAddKinfolk(uid: string | null | undefined): PendingAddKinfolk | null {
  if (!uid) return null;
  return load(uid);
}

export function savePendingAddKinfolk(uid: string | null | undefined, pending: PendingAddKinfolk): void {
  if (!uid) return;
  memory.set(uid, pending);
  try {
    sessionStorage.setItem(key(uid), JSON.stringify(pending));
  } catch {
    // Storage refused. The in-memory copy still carries it for this page.
  }
  notify(uid);
}

export function clearPendingAddKinfolk(uid: string | null | undefined): void {
  if (!uid) return;
  memory.delete(uid);
  try {
    sessionStorage.removeItem(key(uid));
  } catch {
    // Nothing stored to remove.
  }
  notify(uid);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The operator's pending household, re-rendering when it is saved or cleared. */
export function usePendingAddKinfolk(uid: string | null | undefined): PendingAddKinfolk | null {
  return useSyncExternalStore(subscribe, () => {
    if (!uid) return null;
    if (!snapshots.has(uid)) snapshots.set(uid, load(uid));
    return snapshots.get(uid) ?? null;
  });
}

/** How the Continue prompt names the household. */
export function pendingHouseholdName(pending: PendingAddKinfolk): string {
  const name = `${pending.household.firstName.trim()} ${pending.household.lastName.trim()}`.trim();
  return name === '' ? 'this household' : name;
}
