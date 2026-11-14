/**
 * Pet fields that belong to staff alone (#1335).
 *
 * They live on the flat AuntieOS `kin/{docId}` doc, which only staff can read
 * (#1344). They must NEVER be written onto `families/{fid}/kin/{kinId}`: any
 * active household member can read that document with the client SDK, and a
 * Firestore rule gates a document, never a field. Same class as dossiers and
 * 411s, which kinfolk never see.
 *
 * #1908, owner ruling 2026-11-11: routine, training commands, food brand and
 * vaccinations (with "Stays as") are no longer staff-only. The household fills
 * them in the portal too, so they moved to `HOUSEHOLD_SHARED_FIELDS` in
 * `triggers/kinMirror.ts`. Medication / health notes became ONE field with the
 * household's Medications (kin-meds ruling 2026-11-12): it reaches the family
 * doc as `medications`, so the admin's own key stays on this list and never
 * lands there under its flat name.
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
  'medicationHealthNotes',
  'tags',
];
