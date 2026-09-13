import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { addDoc, updateDoc } from '../lib/firestoreWrite';
import { type CollectionSpec } from '../lib/firestore';
import { db } from '../lib/firebase';
import { str } from '../lib/coerce';
import {
  HOUSEHOLD_FIELD_KEYS,
  blankHouseholdFields,
  type HouseholdFields,
} from '../lib/householdDataSchema';

/**
 * `household_data`, one doc per Kinfolk: the shared facts that belong to the
 * HOUSEHOLD rather than to any one Kin (the vet, where the food is, what the
 * alarm does). Ported from android `AuntieRepository.getHouseholdData` (:1301)
 * and `saveHouseholdData` (:1313).
 *
 * DIRECT Firestore, no callable. Verified before writing a line of this:
 * `grep -rn "clear_dossier_household_notes\|householdData" MyTribe/functions/src`
 * finds nothing, so there is no callable to prefer and none to invent UI for
 * (the "verify the callable is real" rule). `firestore.rules:601` backs the
 * direct path: `match /household_data/{id} { allow read, write: if isAuntie(); }`.
 *
 * NO `orderBy`, ANYWHERE IN THIS FILE, and that is the load-bearing decision.
 * An `orderBy` on a field a doc lacks does not sort that doc last, it DROPS it,
 * which has already cost this codebase two live data-loss bugs (invoices 0 of
 * 18, sessions 23 of 99). A household has at most one record here and it is
 * fetched by an equality filter, so ordering buys nothing and could only lose
 * the single row that matters. `where('kinfolkId','==',x) + limit(1)` also needs
 * no composite index, and none exists for this collection in
 * `MyTribe/firestore.indexes.json`, so the query cannot fail
 * 'failed-precondition' at runtime either.
 */

export interface HouseholdRecord extends HouseholdFields {
  /** Firestore doc id. BLANK means no record exists yet, and the next save creates one. */
  _id: string;
  kinfolkId: string;
  /** ISO-8601 UTC strings, matching the Kotlin model's `String` timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** The record a household with nothing on file starts from. Never written until saved. */
export function blankHouseholdRecord(kinfolkId: string): HouseholdRecord {
  return { ...blankHouseholdFields(), _id: '', kinfolkId, createdAt: '', updatedAt: '' };
}

/**
 * Field-by-field merge over the blank shape, the `mergeKinfolkProfile` pattern.
 * Never `undefined`, never fabricated: a legacy doc missing half the fields
 * reads as blanks, which is exactly what "not filled in yet" means here, and a
 * non-string value reads blank rather than throwing mid-render (see lib/coerce).
 */
export function mergeHouseholdRecord(
  id: string,
  kinfolkId: string,
  raw: Record<string, unknown> | undefined | null,
): HouseholdRecord {
  const source = raw ?? {};
  const merged = blankHouseholdRecord(kinfolkId);
  for (const key of HOUSEHOLD_FIELD_KEYS) merged[key] = str(source[key]);
  merged._id = id;
  // The doc's own kinfolkId wins when present; the argument is the fallback for
  // a legacy doc that was written without one.
  const stored = str(source['kinfolkId']);
  if (stored !== '') merged.kinfolkId = stored;
  merged.createdAt = str(source['createdAt']);
  merged.updatedAt = str(source['updatedAt']);
  return merged;
}

/**
 * The household's record, or `null` when none exists yet.
 *
 * `null` is a real answer, not a failure: most households have no structured
 * record until an operator fills the first section. A read REJECTION propagates
 * so the screen can fail loud; the two must never look alike.
 */
export async function getHouseholdData(kinfolkId: string): Promise<HouseholdRecord | null> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('getHouseholdData requires a kinfolk id');

  const snap = await getDocs(
    query(collection(db, 'household_data'), where('kinfolkId', '==', id), limit(1)),
  );
  const first = snap.docs[0];
  return first ? mergeHouseholdRecord(first.id, id, first.data() as Record<string, unknown>) : null;
}

/**
 * The free-text `householdNotes` blob off the dossier, shown read-only above the
 * editor as a fill-in reference (android `HouseholdDataViewModel` :48). This is
 * the unstructured text an operator is migrating INTO the fields below it.
 *
 * A point read, not the android query. `firestore.rules:583` documents that a
 * dossier's DOC ID IS the kinfolkId ("dossiers are keyed one-per-kinfolk"), and
 * `seed_dossiers_411.py` writes them that way, so the android
 * `whereEqualTo("kinfolkId", ...)` is a collection scan for a doc we can address
 * directly. A missing dossier is blank, not an error.
 */
export async function getDossierHouseholdNotes(kinfolkId: string): Promise<string> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('getDossierHouseholdNotes requires a kinfolk id');

  const snap = await getDoc(doc(db, 'dossiers', id));
  if (!snap.exists()) return '';
  return str((snap.data() as Record<string, unknown>)['householdNotes']);
}

/**
 * Save one section's fields and return the record as it now stands, so the
 * caller updates its view without a second read.
 *
 * PATCH ON UPDATE, NOT A WHOLE-OBJECT WRITE. The android source does
 * `.set(data.copy(updatedAt = timestamp))`, a full-document overwrite of all 30
 * fields from whatever the ViewModel last loaded. That pattern is exactly what
 * destroyed `familyKinPath` and `updatedAt` on the kin collection in the
 * 2026-07-20 diagnosis: anything written by another surface between the read and
 * the save is silently reverted. Here an update sends only the fields the
 * operator actually edited, so two operators in two sections cannot clobber each
 * other, and a field this port does not model cannot be erased by it.
 *
 * The CREATE path does write the full field set, which is correct: there is no
 * document yet, so there is nothing to clobber, and a complete document keeps
 * the android `toObject(HouseholdData::class.java)` deserialization happy.
 */
export async function saveHouseholdSection(
  record: HouseholdRecord,
  patch: Partial<HouseholdFields>,
): Promise<HouseholdRecord> {
  const kinfolkId = record.kinfolkId.trim();
  if (kinfolkId === '') throw new Error('saveHouseholdSection requires a kinfolk id');

  // ISO-8601 UTC, because the stored type is a STRING that android parses
  // (`Instant.now().toString()`), not a Firestore Timestamp. This is a machine
  // audit stamp, never a value grouped into an operator's day, so the AO-18
  // local-vs-UTC rule does not apply to it.
  const updatedAt = new Date().toISOString();
  const next: HouseholdRecord = { ...record, ...patch, kinfolkId, updatedAt };

  if (record._id === '') {
    const createdAt = record.createdAt !== '' ? record.createdAt : updatedAt;
    // Built key by key rather than spread, so `_id` (our own field, not the
    // doc's) can never leak into the document body.
    const payload: Record<string, string> = { kinfolkId, createdAt, updatedAt };
    for (const key of HOUSEHOLD_FIELD_KEYS) payload[key] = next[key];

    const ref = await addDoc(collection(db, 'household_data'), payload);
    return { ...next, _id: ref.id, createdAt };
  }

  const changes: Record<string, string> = { updatedAt };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string') changes[key] = value;
  }
  await updateDoc(doc(db, 'household_data', record._id), changes);
  return next;
}

/**
 * Bounded live query over every household record, for the vet clinics manager's
 * per-clinic usage badge. Same 500 cap and shape as `VET_CLINICS_QUERY`.
 *
 * The badge reads `household_data` because that is where the household vet
 * lives (operator ruling 2026-08-01). It used to scan `kinfolk`, which after
 * the move would have counted a field nothing writes and reported "No
 * households" on every card.
 */
export const HOUSEHOLD_DATA_QUERY: CollectionSpec = {
  path: 'household_data',
  order: ['kinfolkId', 'asc'],
  max: 500,
};
