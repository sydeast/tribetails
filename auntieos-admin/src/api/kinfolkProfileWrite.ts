import { doc, serverTimestamp } from 'firebase/firestore';
import { updateDoc } from '../lib/firestoreWrite';
import { db } from '../lib/firebase';
import { call } from '../lib/fns';

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
 *   archivedAt /     written only by the `setKinfolkArchived` callable (#2161),
 *   archivedReason / which the archive helpers below call. Absent from the wasm
 *   archivedBy       model, so a wasm whole-document save would erase them.
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
  // NO EMERGENCY CONTACT FIELDS (#829). They are written only by the
  // `saveEmergencyContacts` callable, which validates them against the household.
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
export async function updateKinfolkProfile(kinfolkId: string, patch: Partial<KinfolkEditPatch>): Promise<boolean> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('updateKinfolkProfile requires a kinfolk id');

  // #829 review item 5: only the fields the caller passes are written, walked
  // off the fixed key list so nothing riding along on the object can leak in.
  // Nothing to write means no write at all, not even the stamp: `updatedAt`
  // says when the record last changed.
  const fields: Record<string, string> = {};
  for (const key of KINFOLK_EDIT_FIELDS) {
    const value = patch[key];
    if (typeof value !== 'string') continue;
    fields[key] = TRIMMED.has(key) ? value.trim() : value;
  }
  if (Object.keys(fields).length === 0) return false;

  await updateDoc(doc(db, 'kinfolk', id), { ...fields, updatedAt: serverTimestamp() });
  return true;
}

/**
 * #829 review item 5: what the edit form actually changed, against the stored
 * record it loaded. The same comparison the write uses (identity and contact
 * fields trimmed, free-text notes as typed), so stray whitespace on file is not
 * an edit, and the unsaved indicator and the write can never disagree. Android
 * (`DirectoryFieldChanges.kt`) and desktop (`kinfolkChanges`) diff the same way.
 */
export function changedKinfolkEditFields(
  stored: Pick<KinfolkEditPatch, (typeof KINFOLK_EDIT_FIELDS)[number]>,
  edited: KinfolkEditPatch,
): Partial<KinfolkEditPatch> {
  const out: Partial<KinfolkEditPatch> = {};
  for (const key of KINFOLK_EDIT_FIELDS) {
    const norm = (v: string | undefined) => {
      const s = typeof v === 'string' ? v : '';
      return TRIMMED.has(key) ? s.trim() : s;
    };
    if (norm(stored[key]) !== norm(edited[key])) out[key] = edited[key];
  }
  return out;
}

/** What the `setKinfolkArchived` callable answers (`mytribe/functions/src/admin/kinfolkArchive.ts`). */
export interface SetKinfolkArchivedResult {
  ok: true;
  archived: boolean;
  /** The status now on `kinfolk/{id}`. */
  status: string;
  /** False when the household was already in the asked-for state. */
  changed: boolean;
}

/**
 * #2161: what an archive or restore refused by the server says. The callable
 * refuses everyone but the owner, and its own text is not for the operator.
 */
export const KINFOLK_ARCHIVE_OWNER_ONLY = 'Only the owner can archive or restore a Kinfolk household.';

function isPermissionDenied(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code === 'permission-denied' || code.endsWith('/permission-denied'));
}

async function setKinfolkArchived(id: string, archived: boolean, reason?: string): Promise<SetKinfolkArchivedResult> {
  const payload = archived ? { kinfolkId: id, archived, reason: (reason ?? '').trim() } : { kinfolkId: id, archived };
  try {
    return await call<typeof payload, SetKinfolkArchivedResult>('setKinfolkArchived', payload);
  } catch (err) {
    if (isPermissionDenied(err)) throw new Error(KINFOLK_ARCHIVE_OWNER_ONLY);
    throw err;
  }
}

/**
 * Archive a household: reversible, and it records WHY.
 *
 * #2161: through the owner-only `setKinfolkArchived` callable, never a direct
 * write. The server sets `status`, `archivedAt`, `archivedReason` and
 * `archivedBy`, and writes the `ARCHIVE_KINFOLK` Activity Log line, so this
 * writes none of its own. The rules refuse a direct change to those fields.
 *
 * The reason is optional (the dialog labels it "Reason (optional)"), so a blank
 * reason is sent as a blank string rather than being refused.
 */
export async function archiveKinfolk(kinfolkId: string, reason: string): Promise<SetKinfolkArchivedResult> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('archiveKinfolk requires a kinfolk id');
  return setKinfolkArchived(id, true, reason);
}

/**
 * Restore an archived household, the archive fields cleared. #2161: through
 * the same owner-only callable, which writes the `RESTORE_KINFOLK` Activity
 * Log line. #1958: the household goes back to the status it held before the
 * archive (active, prospect or inactive), which the answer's `status` names;
 * one archived before that status was kept goes back to `active`.
 */
export async function unarchiveKinfolk(kinfolkId: string): Promise<SetKinfolkArchivedResult> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('unarchiveKinfolk requires a kinfolk id');
  return setKinfolkArchived(id, false);
}

/**
 * #1958: the confirmation a restore shows, naming the status the household
 * came back as. Active keeps the words it always had.
 */
export function kinfolkRestoredMessage(name: string, status: string): string {
  const s = status.trim().toLowerCase();
  if (s === 'prospect') return `${name} is restored as a Prospect.`;
  if (s === 'inactive') return `${name} is restored as Inactive.`;
  return `${name} is active again.`;
}
