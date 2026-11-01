/**
 * Pet fields that belong to staff alone (#1335).
 *
 * They live on the flat AuntieOS `kin/{docId}` doc, which only staff can read
 * (#1344). They must NEVER be written onto `families/{fid}/kin/{kinId}`: any
 * active household member can read that document with the client SDK, and a
 * Firestore rule gates a document, never a field. Same class as dossiers and
 * 411s, which kinfolk never see.
 *
 * The flat -> family mirror (`triggers/onFlatKinWrite.ts`) strips every key in
 * this list from its payload, and `scripts/stripFamilyKinStaffFields.ts`
 * deletes them from family docs written before the mirror was narrowed.
 *
 * Kept under `lib/` rather than `triggers/` because the backfill imports it,
 * and the `mytribeScriptsEmulator` CI filter watches `functions/src/lib/**`.
 */
export const STAFF_ONLY_KIN_FIELDS: readonly string[] = [
  'officeNotes',
  'reactive',
  'routine',
  'trainingCommands',
  'feedingBrand',
  'vaccinations',
  'medicationHealthNotes',
  'tags',
];
