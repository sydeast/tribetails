import type { Timestamp } from 'firebase/firestore';
import { formatWhenFull, type FsTime } from './time';

/**
 * Pure Form Schemas ("The Den · Admin", nav slug `form-schemas`) display
 * helpers, kept out of the screen so the formatting logic has direct vitest
 * coverage (the tribalIntelFormat.ts / settingsFormat.ts / kinTaleFormat.ts
 * convention).
 *
 * ── WHAT `formSchemas/{id}.updatedAt` ACTUALLY HOLDS ───────────────────────
 * Confirmed end-to-end, because the answer decides both the formatting below
 * AND whether FormSchemas.tsx's `sortSchemas` string compare is sound:
 *
 *  - THE ONLY WRITER is the `saveFormSchema` callable
 *    (`mytribe/functions/src/admin/saveFormSchema.ts:214`), which stamps
 *    `updatedAt: FieldValue.serverTimestamp()`. A real Firestore Timestamp,
 *    set by the server, never by a client clock.
 *  - THE READER normalises it: `listFormSchemas`'s `toIsoOrNull`
 *    (`mytribe/functions/src/admin/listFormSchemas.ts:69`) calls
 *    `.toDate().toISOString()` on anything Timestamp-shaped, so what reaches
 *    this client is a fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ` UTC instant.
 *  - NOTHING ELSE WRITES THE FIELD. `firestore.rules:770` does allow a direct
 *    `isAuntie()` client write to `formSchemas/{schemaId}`, and `toIsoOrNull`
 *    passes a stored STRING through verbatim rather than re-parsing it, so a
 *    hand-edited doc COULD carry free text. No code path in this repo does it:
 *    the Android repository saves through the callable
 *    (`AuntieRepository.kt:2540`), so does the React editor
 *    (`api/formSchemasWrite.ts`), and the seed scripts
 *    (`mytribe/scripts/seedDemoKinfolk.ts#buildFormSchemas`) omit `updatedAt`
 *    entirely, which lands on the `null` branch, not a free-text one.
 *
 * So the live input classes are exactly two: a full ISO instant, or null. That
 * is why the `updatedAt` column of `sortSchemas` in FormSchemas.tsx is left
 * comparing raw strings. Over fixed-width ISO instants, byte order IS
 * chronological order. It is NOT the invoice/payment `date` situation (PR
 * #241), where the stored value is genuinely free text like "February 17,
 * 2026" and a string compare ordered rows by their first letter. The third
 * class below (unparseable text) is handled anyway, because the rules permit
 * it even though no writer emits it, and an operator staring at a bad row
 * deserves to see the bad value.
 */

/**
 * Wraps a `formSchemas.updatedAt` ISO string as a fake Firestore `Timestamp`
 * so it can flow through `lib/time.ts`'s LOCAL `formatWhen` unchanged. `null`
 * for a blank/absent/unparseable value: the same "degrade honestly, never
 * fabricate a date" contract `tribalIntelFormat.ts#tribalIntelTimeOf` and
 * `kinTaleFormat.ts#kinTaleTimeOf` use.
 *
 * Takes `string | null` rather than `string`, because unlike those two
 * collections this callable really does send `null` for a schema saved before
 * the field existed (see `FormSchemaSummary` in `api/formSchemas.ts`).
 */
export function formSchemaTimeOf(iso: string | null): FsTime {
  const trimmed = (iso ?? '').trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/**
 * The Updated column's cell text: LOCAL `YYYY-MM-DD HH:mm`, with the year
 * (`lib/time.ts`'s `formatWhenFull`), because the table has its own "Updated"
 * header to say what the column is, unlike the retired single-line meta
 * string that needed `formatWhen`'s bare `MM-DD HH:mm` to stay short.
 *
 * Three input classes, three honest outputs, never `Invalid Date` and never
 * `NaN`:
 *  - a real instant  -> `2026-08-02 05:15`, in the OPERATOR'S zone (AO-18:
 *    local getters, never a `toISOString()` slice, so a schema saved at
 *    5:15am in Chicago does not read as 10:15).
 *  - null / blank    -> `null`. The caller renders the shared blank
 *    placeholder ("-") and sorts the row last, matching the mock's blank-row
 *    treatment. Not "never updated": a null here means the field is ABSENT,
 *    which is a schema older than the field, not proof that nobody ever saved
 *    it.
 *  - anything else   -> the raw trimmed text, verbatim. Fail-loud, the same
 *    contract `accountFormat.ts#authDateLabel` and `bookingFormat.ts#bookingWhen`
 *    hold: a value this function cannot read is a value the operator needs to
 *    SEE in order to report it, not one to launder into a placeholder.
 */
export function formSchemaUpdatedFull(updatedAt: string | null): string | null {
  const raw = (updatedAt ?? '').trim();
  if (raw === '') return null;
  const when = formSchemaTimeOf(raw);
  return when ? formatWhenFull(when) : raw;
}
