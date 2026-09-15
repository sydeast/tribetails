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
 * DISCARD writes nothing to the household. It records the discarded id (#907
 * review item 1a), because Discard means "the next Add is a new household": the
 * next create sends that id as `ignoreDuplicateOf`, so the server's duplicate
 * check does not hand the discarded household back.
 *
 * A DUPLICATE ANSWER (#907 review item 1b). When the server answers `duplicateOf`,
 * what the operator typed is kept here, keyed by that household, so its edit
 * screen can fill in the fields that differ as unsaved changes. Nothing typed is
 * lost and nothing is written until the operator saves.
 */

export const PENDING_ADD_KINFOLK_STORAGE_PREFIX = 'auntieos.pendingAddKinfolk.';
export const DISCARDED_ADD_KINFOLK_STORAGE_PREFIX = 'auntieos.discardedAddKinfolk.';
export const DUPLICATE_ADD_KINFOLK_STORAGE_PREFIX = 'auntieos.duplicateAddKinfolk.';

export interface PendingAddKinfolk {
  kinfolkId: string;
  /** The household fields as they were saved, shown locked when Add continues. */
  household: NewKinfolkInput;
  /** The contact as last typed, so continuing does not make the operator retype it. */
  contacts: EmergencyContactDraft[];
}

/** What the operator typed into an Add the server answered with `duplicateOf`. Same shape. */
export type DuplicateAddKinfolk = PendingAddKinfolk;

const memory = new Map<string, unknown>();

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

function isId(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function load<T>(key: string, valid: (v: unknown) => v is T): T | null {
  const fromMemory = (): T | null => {
    const m = memory.get(key);
    return valid(m) ? m : null;
  };
  try {
    const raw = sessionStorage.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      return valid(parsed) ? parsed : null;
    }
    // Nothing stored: either there is nothing kept, or storage refused the write.
    return fromMemory();
  } catch {
    return fromMemory();
  }
}

function store(key: string, value: unknown): void {
  memory.set(key, value);
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused. The in-memory copy still carries it for this page.
  }
}

function remove(key: string): void {
  memory.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing stored to remove.
  }
}

export function readPendingAddKinfolk(uid: string | null | undefined): PendingAddKinfolk | null {
  if (!uid) return null;
  return load(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}${uid}`, isPending);
}

export function savePendingAddKinfolk(uid: string | null | undefined, pending: PendingAddKinfolk): void {
  if (!uid) return;
  store(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}${uid}`, pending);
}

export function clearPendingAddKinfolk(uid: string | null | undefined): void {
  if (!uid) return;
  remove(`${PENDING_ADD_KINFOLK_STORAGE_PREFIX}${uid}`);
}

/** The household this operator last Discarded, sent as `ignoreDuplicateOf` on their next create. */
export function readDiscardedAddKinfolk(uid: string | null | undefined): string | null {
  if (!uid) return null;
  return load(`${DISCARDED_ADD_KINFOLK_STORAGE_PREFIX}${uid}`, isId);
}

export function saveDiscardedAddKinfolk(uid: string | null | undefined, kinfolkId: string): void {
  if (!uid || kinfolkId === '') return;
  store(`${DISCARDED_ADD_KINFOLK_STORAGE_PREFIX}${uid}`, kinfolkId);
}

export function clearDiscardedAddKinfolk(uid: string | null | undefined): void {
  if (!uid) return;
  remove(`${DISCARDED_ADD_KINFOLK_STORAGE_PREFIX}${uid}`);
}

/** Kept for the household's edit screen. One at a time per operator: a newer duplicate replaces it. */
export function saveDuplicateAddKinfolk(uid: string | null | undefined, typed: DuplicateAddKinfolk): void {
  if (!uid) return;
  store(`${DUPLICATE_ADD_KINFOLK_STORAGE_PREFIX}${uid}`, typed);
}

/** What was typed for THIS household, or null. Another household's edit screen never sees it. */
export function readDuplicateAddKinfolk(uid: string | null | undefined, kinfolkId: string): DuplicateAddKinfolk | null {
  if (!uid) return null;
  const typed = load(`${DUPLICATE_ADD_KINFOLK_STORAGE_PREFIX}${uid}`, isPending);
  return typed !== null && typed.kinfolkId === kinfolkId ? typed : null;
}

export function clearDuplicateAddKinfolk(uid: string | null | undefined): void {
  if (!uid) return;
  remove(`${DUPLICATE_ADD_KINFOLK_STORAGE_PREFIX}${uid}`);
}

/** How the Continue prompt names the household. */
export function pendingHouseholdName(pending: PendingAddKinfolk): string {
  const name = `${pending.household.firstName.trim()} ${pending.household.lastName.trim()}`.trim();
  return name === '' ? 'this household' : name;
}
