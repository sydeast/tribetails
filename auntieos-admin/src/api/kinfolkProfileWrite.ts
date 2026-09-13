import { doc, serverTimestamp } from 'firebase/firestore';
import { updateDoc } from '../lib/firestoreWrite';
import { db } from '../lib/firebase';
import { getAuthState } from '../lib/auth';

/**
 * The write half of the otherwise read-only `api/kinfolkProfile.ts` (the
 * account.ts / accountWrite.ts, kinTales.ts / kinTalesWrite.ts split).
 *
 * TRANSPORT, confirmed before a line was written here: there is no
 * `updateKinfolk` / `saveKinfolk` callable. `firestore.rules:153-161` reads
 * `match /kinfolk/{kinfolkId} { allow write: if isAuntie() || ... }`, so an
 * admin edits this document DIRECTLY from the client SDK, the same
 * rules-backed direct write `createKinfolk` and `updateKinfolkTags` in
 * api/directoryWrite.ts already rely on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY WRITE IN THIS FILE IS A FIELD-LEVEL MERGE (`updateDoc`), NEVER A
 * WHOLE-OBJECT `setDoc`. This is the load-bearing decision of the module.
 *
 * Both Kotlin admin clients save a household by overwriting the WHOLE document
 * with their in-memory model:
 *
 *   AuntieRepository.kt:296       `.set(kinfolk.copy(updatedAt = serverTimestamp()))`
 *   FirestoreInterop.wasmJs.kt:410  `jsSetDoc` of the serialized whole object
 *
 * A `kinfolk` document carries fields NEITHER model knows about, so that
 * overwrite destroys them:
 *
 *   uid              the portal-auth linkage, written by
 *                    functions `admin/setKinfolkClaim.ts:63`. Absent from the
 *                    wasm model entirely (FirestoreClient.kt:2341-2412), so a
 *                    web-admin save unlinks the Kinfolk from their MyTribe login.
 *   myTribeLinkedAt  same writer (`setKinfolkClaim.ts:65`), present in NO Kotlin
 *                    model at all, so BOTH clients drop it.
 *   archivedAt /     written by the archive helpers below and by
 *   archivedReason / AuntieRepository.kt:312-323. Absent from the wasm model, so
 *   archivedBy       a wasm save erases the archive audit trail.
 *   displayName,     backend-only, written by triggers/familyProvision.ts:38-46
 *   businessName,    and never modelled on any client.
 *   isTestData,
 *   householdMemberCount
 *
 * The same hazard `api/kinTalesWrite.ts` documents in its own header, on a
 * document with far more at stake. `updateDoc` is inherently a field-level
 * merge, so a field this module does not name is a field it cannot touch.
 *
 * TWO FIELDS ARE OMITTED FROM THE PATCH ON PURPOSE, and it is not an oversight:
 * `preferredContactMethod` and `bestTimeToContact`. EditKinfolkScreen.kt:329-331
 * removed their editors but kept ROUND-TRIPPING them through save. That is
 * actively unsafe here, because `firestore.rules:147-151`
 * (`onlyAllowedKinfolkFields`) lets a KINFOLK edit exactly those two from the
 * MyTribe portal. Writing back the value this form happened to read at load
 * would clobber a Kinfolk's own portal edit made in between. Not naming them at
 * all is strictly safer than round-tripping them, so this port does not.
 *
 * `tags` is likewise absent: it belongs to `updateKinfolkTags` (directoryWrite.ts)
 * and the profile screen's tag section. `profilePictureUrl` is absent because the
 * photo control is not ported yet (see the KinfolkEdit screen header) AND because
 * functions `admin/setMediaProfilePhoto.ts:98` writes it server-side; a form that
 * does not edit it must not send it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Exactly the fields this editor owns. Every one is required rather than
 * optional: the form always holds a full loaded household, so a partial patch
 * here would mean a field silently went missing between load and save, and an
 * optional key is how that goes unnoticed. Nothing outside this interface is
 * ever sent.
 */
export interface KinfolkEditPatch {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  status: string;
  joinDate: string;
  secondaryPhone: string;
  secondaryEmail: string;
  serviceAddress: string;
  gateCode: string;
  parkingInstructions: string;
  entryNotes: string;
  wifiName: string;
  wifiPassword: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  // NO VET FIELDS. The household vet lives on `household_data`, catalog-linked
  // by clinic id (operator ruling 2026-08-01, page-specs 04 item 3). This
  // patch used to carry all eight `vetClinic*` / `emergencyVetClinic*` keys,
  // which is what made the kinfolk doc a second writable copy of a fact the
  // household record already owned. The kin profile READS the vet now; nothing
  // here writes it. See `api/householdData.ts`.
}

/**
 * The patch keys, as data.
 *
 * Exported so the write below can build the payload by walking THIS list rather
 * than spreading the caller's object, and so a test can assert the exact key set
 * that reaches Firestore. Spreading `{ ...patch }` would forward any extra
 * property a caller happened to attach (an `_id` off a loaded profile, say)
 * straight onto the document. Walking a fixed list cannot.
 */
export const KINFOLK_EDIT_FIELDS = [
  'firstName',
  'lastName',
  'phoneNumber',
  'email',
  'status',
  'joinDate',
  'secondaryPhone',
  'secondaryEmail',
  'serviceAddress',
  'gateCode',
  'parkingInstructions',
  'entryNotes',
  'wifiName',
  'wifiPassword',
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
] as const satisfies readonly (keyof KinfolkEditPatch)[];

/** Trimmed on the way out, matching `createKinfolk`'s treatment of the same fields. */
const TRIMMED: ReadonlySet<keyof KinfolkEditPatch> = new Set<keyof KinfolkEditPatch>([
  'firstName',
  'lastName',
  'phoneNumber',
  'email',
  'secondaryPhone',
  'secondaryEmail',
  'serviceAddress',
  'emergencyContactName',
  'emergencyContactPhone',
]);

/**
 * Save the operator's edits to `kinfolk/{id}`.
 *
 * A merge over the named fields only (see the file header). `updatedAt` is
 * re-stamped with `serverTimestamp()`, not round-tripped: AuntieRepository.kt:288
 * makes the same point in its own comment, that writing back the value it read
 * would freeze the timestamp and lie about when the record last changed. It also
 * matches the Firestore Timestamp type `updateKinfolkTags` already writes, so the
 * field does not drift between a string and a Timestamp depending on which
 * control last touched the household.
 *
 * Free-text notes (parking, entry notes, addresses) are NOT trimmed: an operator
 * who laid out entry instructions across lines meant those lines.
 *
 * Fail-loud: a rejected write propagates to the caller unchanged.
 */
export async function updateKinfolkProfile(kinfolkId: string, patch: KinfolkEditPatch): Promise<void> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('updateKinfolkProfile requires a kinfolk id');

  const fields: Record<string, string> = {};
  for (const key of KINFOLK_EDIT_FIELDS) {
    const value = patch[key];
    fields[key] = TRIMMED.has(key) ? value.trim() : value;
  }

  await updateDoc(doc(db, 'kinfolk', id), { ...fields, updatedAt: serverTimestamp() });
}

/**
 * Archive a household: reversible, and it records WHY.
 *
 * Ports `AuntieRepository.kt:312-323` field for field, including its
 * `archivedBy` default of "admin" when no signed-in uid is available. Four keys,
 * so an archived record always carries when, why, and by whom, which is exactly
 * what the status picker cannot express (see `KINFOLK_STATUS_OPTIONS`).
 *
 * `archivedAt` is a client ISO instant, not `serverTimestamp()`, because the
 * Kotlin source writes `java.time.Instant.now().toString()`
 * (AuntieRepository.kt:1085). Matching it keeps one type on the field across
 * platforms; "fixing" it here unilaterally would be the type drift the
 * `updatedAt` comment above warns about, in the other direction.
 *
 * The reason is optional (the source's dialog labels it "Reason (optional)"), so
 * a blank reason writes a blank string rather than being refused.
 */
export async function archiveKinfolk(kinfolkId: string, reason: string): Promise<void> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('archiveKinfolk requires a kinfolk id');

  const auth = getAuthState();
  const archivedBy = (auth.status === 'signedIn' ? auth.user.uid : '') || 'admin';

  await updateDoc(doc(db, 'kinfolk', id), {
    status: 'archived',
    archivedAt: new Date().toISOString(),
    archivedReason: reason.trim(),
    archivedBy,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Restore an archived household. Ports `AuntieRepository.kt:361-372`: back to
 * `active`, and the three archive fields cleared to "" rather than deleted, so
 * the shape of the document stays stable for the readers that expect them.
 */
export async function unarchiveKinfolk(kinfolkId: string): Promise<void> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('unarchiveKinfolk requires a kinfolk id');

  await updateDoc(doc(db, 'kinfolk', id), {
    status: 'active',
    archivedAt: '',
    archivedReason: '',
    archivedBy: '',
    updatedAt: serverTimestamp(),
  });
}
