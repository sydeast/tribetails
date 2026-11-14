import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

/**
 * Shared logic for the `vet_clinics` catalog writes (`updateVetClinic`,
 * `archiveVetClinic`). Pure functions live here so they can be unit-tested
 * without a Firestore double, and so both callables agree on what a duplicate
 * name is and which households a clinic reaches.
 */

/**
 * Normalizes a clinic name for case/space-insensitive comparison.
 *
 * Deliberately IDENTICAL to `submitVetClinic.ts#normName`. If the two ever
 * diverge, create would dedupe under one rule and rename would collide under
 * another, and the catalog would accumulate exactly the near-duplicates the
 * dedupe exists to prevent. `test/vetClinicCatalog.test.ts` pins them equal.
 */
export function normClinicName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The editable surface of a clinic. Timestamps and `submittedBy` are not here. */
export interface VetClinicFields {
  name: string;
  phone: string;
  address: string;
  website: string;
  /**
   * Opening hours, e.g. "Mon to Fri 8a to 6p".
   *
   * Lives on the CLINIC rather than on the household that picked it. Hours are
   * a property of the practice: every household using Riverside shares
   * Riverside's hours, so storing them per household (which is what
   * `household_data.primaryVetHours` did) meant one clinic's hours were
   * recorded N times and corrected zero times.
   */
  hours: string;
  isEmergency: boolean;
  notes: string;
}

/**
 * The two `household_data` link slots a clinic can occupy.
 *
 * A household picks a regular vet and, separately, an emergency vet, so one
 * clinic can be referenced twice by the same household through different
 * fields. These live on `household_data` and NOT on `kinfolk`: operator ruling
 * 2026-08-01, "vet info lives on household data, it can be seen on the kin
 * profile", matching the canonical decision in page-specs
 * `04-kinfolk-profile.md` item 3.
 */
export const VET_LINK_SLOTS = ['primaryVetClinicId', 'emergencyVetClinicId'] as const;

export type VetLinkSlot = (typeof VET_LINK_SLOTS)[number];

/**
 * Which households reference [clinicId], by `household_data` document id.
 *
 * Two `where` queries rather than one: Firestore cannot OR across different
 * fields without a composite index and a `Filter.or`, and the two result sets
 * overlap whenever a household picked the same clinic for both slots. Merging
 * through a Set keeps such a household counted once.
 *
 * A blank [clinicId] returns nothing rather than matching every household whose
 * link field is `''`. That guard is load-bearing: an unlinked household carries
 * an empty id, so without it a single clinic edit would appear to touch every
 * unlinked household in the tribe.
 *
 * WHY THIS IS ONLY A COUNT, and never drives a write. Households store the
 * clinic ID ONLY and resolve name, phone, address and hours through it at read
 * time, so there is exactly ONE copy of a clinic's details in the product.
 * Correcting a clinic therefore needs no fan-out: the corrected value IS the
 * value every linked household reads, immediately. This exists so the operator
 * can be told how far a change reaches, not to propagate one.
 */
export async function findLinkedHouseholds(db: Firestore, clinicId: string): Promise<string[]> {
  if (clinicId.trim() === '') return [];

  const ids = new Set<string>();
  for (const slot of VET_LINK_SLOTS) {
    const snap = await db.collection('household_data').where(slot, '==', clinicId).get();
    for (const doc of snap.docs) ids.add(doc.id);
  }
  return [...ids];
}

/** Reads the stored doc into the editable shape, defaulting every absent field. */
export function readClinicFields(data: Record<string, unknown>): VetClinicFields {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    name: str(data['name']),
    phone: str(data['phone']),
    address: str(data['address']),
    website: str(data['website']),
    hours: str(data['hours']),
    isEmergency: data['isEmergency'] === true,
    notes: str(data['notes']),
  };
}

/** True when the stored doc is archived. Absent means active (the field is new). */
export function isClinicArchived(data: Record<string, unknown>): boolean {
  return data['archived'] === true;
}

// ── The household's vet (#1908 kin-vet, #1917) ──────────────────────────────
// Kept in this module, which every vet callable already loads, rather than a
// file of its own: test/coldStartImportGraph.test.ts caps the modules the
// entrypoint loads.

/**
 * #1908 kin-vet, #1917. The household's vet: ONE store for both apps.
 *
 * Owner ruling 2026-11-12: "Vet is a dropdown field preloaded with all vets in
 * the entire area ... to set a vet to the household, the editor (kinfolk &
 * admin) can select a vet from the drop down menu". The admin has always kept
 * it on `household_data.primaryVetClinicId`, a `vet_clinics` id (operator
 * ruling 2026-08-01, "vet info lives on household data"). The portal kept its
 * own copy as the `vetClinicId` row of `families/{id}.customFields`, and
 * nothing joined the two: a vet a household picked never reached the office,
 * and the office's never reached the household.
 *
 * `household_data` is the store. It is staff-only in the rules, so the portal
 * reaches it through `setHouseholdVet` and `getMyTribeProfile`.
 *
 * The legacy row is read only when the household's `household_data` carries no
 * `primaryVetClinicId` at all (a household whose pick predates this), and is
 * deleted whenever the vet is set here. `scripts/backfillKinSharedFields.ts`
 * moves the rest.
 */

/** The legacy portal row key. */
export const LEGACY_VET_ROW_KEY = 'vetClinicId';

type Data = Record<string, unknown>;

interface CustomFieldRow {
  key: string;
  label: string;
  value: string;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The household's `household_data` doc: the one the admin finds (`where
 * kinfolkId ==`, api/householdData.ts), else one keyed by the household id.
 * Null when it has none yet.
 */
export async function findHouseholdData(
  firestore: Firestore,
  kinfolkId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: Data } | null> {
  const byField = await firestore.collection('household_data').where('kinfolkId', '==', kinfolkId).limit(1).get();
  const hit = byField.docs[0];
  if (hit) return { ref: hit.ref, data: (hit.data() ?? {}) as Data };
  const byId = firestore.doc(`household_data/${kinfolkId}`);
  const snap = await byId.get();
  return snap.exists ? { ref: byId, data: (snap.data() ?? {}) as Data } : null;
}
/** The legacy row's clinic id from a families doc's customFields, or ''. */
export function legacyVetRowValue(customFields: unknown): string {
  if (!Array.isArray(customFields)) return '';
  const row = customFields.find(
    (r): r is Data => typeof r === 'object' && r !== null && (r as Data)['key'] === LEGACY_VET_ROW_KEY,
  );
  return row ? text(row['value']) : '';
}

/**
 * The household's vet clinic id, '' for none. `household_data` wins whenever
 * it carries the field at all, even blank (the office cleared it).
 */
export function pickHouseholdVetClinicId(householdData: Data | null, familyCustomFields: unknown): string {
  if (householdData && typeof householdData['primaryVetClinicId'] === 'string') {
    return text(householdData['primaryVetClinicId']);
  }
  return legacyVetRowValue(familyCustomFields);
}

/** Reads the household's vet clinic id ('' for none). */
export async function readHouseholdVetClinicId(firestore: Firestore, kinfolkId: string): Promise<string> {
  const [hd, family] = await Promise.all([
    findHouseholdData(firestore, kinfolkId),
    firestore.doc(`families/${kinfolkId}`).get(),
  ]);
  return pickHouseholdVetClinicId(hd?.data ?? null, (family.data() ?? {})['customFields']);
}

/**
 * The customFields list an old portal client is served: the legacy row made
 * to say what the store says, so a client that still echoes the row back on
 * Save echoes the real vet rather than an old one.
 */
export function withCanonicalVetRow(rows: CustomFieldRow[], clinicId: string): CustomFieldRow[] {
  const rest = rows.filter((r) => r.key !== LEGACY_VET_ROW_KEY);
  if (clinicId === '') return rest;
  const existing = rows.find((r) => r.key === LEGACY_VET_ROW_KEY);
  return [...rest, { key: LEGACY_VET_ROW_KEY, label: existing?.label || 'Vet Clinic', value: clinicId }];
}

export interface VetClinicSummary {
  id: string;
  name: string;
  phone: string;
  address: string;
  isEmergency: boolean;
}

/** Resolves a clinic id to what a screen shows, or null when there is none to show. */
export async function resolveVetClinicSummary(firestore: Firestore, clinicId: string): Promise<VetClinicSummary | null> {
  const id = clinicId.trim();
  // A clinic id is a single document id; a slash would read some other path.
  if (id === '' || id.includes('/')) return null;
  const snap = await firestore.doc(`vet_clinics/${id}`).get();
  if (!snap.exists) return null;
  const data = (snap.data() ?? {}) as Data;
  const name = text(data['name']);
  if (name === '') return null;
  return { id, name, phone: text(data['phone']), address: text(data['address']), isEmergency: data['isEmergency'] === true };
}

/**
 * Sets the household's vet ('' clears it): `household_data.primaryVetClinicId`,
 * creating the household's doc when it has none (keyed by the household id,
 * with the `kinfolkId` field the admin finds it by, so a retry finds the same
 * doc), and deletes the legacy row. One transaction.
 */
export async function writeHouseholdVetClinicId(firestore: Firestore, kinfolkId: string, clinicId: string): Promise<void> {
  const found = await findHouseholdData(firestore, kinfolkId);
  const ref = found?.ref ?? firestore.doc(`household_data/${kinfolkId}`);
  const familyRef = firestore.doc(`families/${kinfolkId}`);
  await firestore.runTransaction(async (tx: Transaction) => {
    const [hdSnap, famSnap] = [await tx.get(ref), await tx.get(familyRef)];
    const stamp = { primaryVetClinicId: clinicId, updatedAt: FieldValue.serverTimestamp() };
    if (hdSnap.exists) tx.set(ref, stamp, { merge: true });
    else tx.set(ref, { ...stamp, kinfolkId, createdAt: FieldValue.serverTimestamp() });
    const rows = (famSnap.data() ?? {})['customFields'];
    if (Array.isArray(rows) && rows.some((r) => typeof r === 'object' && r !== null && (r as Data)['key'] === LEGACY_VET_ROW_KEY)) {
      tx.set(
        familyRef,
        { customFields: rows.filter((r) => !(typeof r === 'object' && r !== null && (r as Data)['key'] === LEGACY_VET_ROW_KEY)) },
        { merge: true },
      );
    }
  });
}
