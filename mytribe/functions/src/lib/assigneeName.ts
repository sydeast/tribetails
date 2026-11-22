import { db } from './firestoreAdmin';
import { withSignInFallback } from './staffIdentity';

/**
 * #1857, #1870: the name stored with a visit's assignment, which a household
 * reads as `auntieDisplayName`.
 *
 * The name comes from the one staff identity chain (`withSignInFallback` in
 * staffIdentity.ts), so a screen and a visit can never disagree about what a
 * person is called. That chain may answer with an email on an account with no
 * name, and an email is never a name a household reads, so it is dropped here.
 * A visit whose assignee has no name carries only the `auntieAssigned` flag.
 */

type StaffNameRecord = { displayName?: unknown; email?: unknown };

/** A name a household may read: trimmed, not blank, and not shaped like an email. */
export function householdSafeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name === '' || name.includes('@') ? null : name;
}

/** True when a visit's stored assignee is a real uid. The uid itself never leaves the server. */
export function hasAssignee(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The visit's fields as a household may read them: an email stored where the
 * name belongs is removed, whether or not the visit still has an assignee.
 */
export function withoutEmailName(data: Record<string, unknown>): Record<string, unknown> {
  const stored = data['auntieDisplayName'];
  if (typeof stored !== 'string' || !stored.includes('@')) return data;
  return { ...data, auntieDisplayName: null };
}

/** uid -> name, for the uids the identity chain holds a real name for. */
async function namesThroughIdentityChain(
  uids: readonly string[],
  records: ReadonlyArray<StaffNameRecord | undefined>,
  context: string,
): Promise<Map<string, string>> {
  // A record whose "name" is an email has no name: blank it so the chain reads its next source.
  const named = records.map((record) =>
    record === undefined ? undefined : { displayName: householdSafeName(record.displayName) ?? '' },
  );
  const identities = await withSignInFallback(uids, named, context);
  const out = new Map<string, string>();
  for (const identity of identities) {
    const name = householdSafeName(identity.displayName);
    if (name !== null) out.set(identity.uid, name);
  }
  return out;
}

/** The name to store with an assignment, for one staff uid whose record is in hand. */
export async function staffNameFor(
  uid: string,
  record: StaffNameRecord | undefined,
  context: string,
): Promise<string | null> {
  if (uid === '') return householdSafeName(record?.displayName);
  return (await namesThroughIdentityChain([uid], [record], context)).get(uid) ?? null;
}

/**
 * The assignee uid of a visit that has no usable name stored beside it, or null.
 * Visits assigned before #1857 carry the uid alone.
 */
export function needsAssigneeName(data: Record<string, unknown>): string | null {
  const uid = data['assignedAuntieUid'];
  if (typeof uid !== 'string' || uid === '') return null;
  return householdSafeName(data['auntieDisplayName']) === null ? uid : null;
}

/**
 * uid -> name for every uid given. A uid with no name anywhere is left out.
 * Never throws: a failed read leaves the visit as it was stored.
 */
export async function assigneeNamesFor(
  uids: readonly string[],
  context: string,
): Promise<Map<string, string>> {
  const unique = [...new Set(uids.filter((uid) => uid !== ''))];
  if (unique.length === 0) return new Map();
  try {
    const firestore = db();
    const snaps = await firestore.getAll(...unique.map((uid) => firestore.collection('staff').doc(uid)));
    const records = snaps.map((snap) => (snap.exists ? (snap.data() as StaffNameRecord) : undefined));
    return await namesThroughIdentityChain(unique, records, context);
  } catch {
    return new Map();
  }
}

/** The visit's fields with its assignee's name filled in, when it was missing and is now known. */
export function withAssigneeName(
  data: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const uid = needsAssigneeName(data);
  if (uid === null) return data;
  const name = names.get(uid);
  return name === undefined ? data : { ...data, auntieDisplayName: name };
}
