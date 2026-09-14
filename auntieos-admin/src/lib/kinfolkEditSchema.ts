import { z } from 'zod';
import { isIsoDate } from './joinDate';

/**
 * Validation for the Kinfolk (household) editor.
 *
 * Written as a real Zod schema rather than hand-rolled `if` chains, following
 * `lib/kinTaleDraftSchema.ts`: the rules are executable, and `validateKinfolkEdit`
 * returns a field-keyed map so the screen can put each message beside the input
 * it belongs to instead of stacking them in one banner.
 *
 * Like the KinTale draft, a household is NOT saved through a callable; it is
 * written straight to `kinfolk/{id}` (see `api/kinfolkProfileWrite.ts` for the
 * confirmed transport). There is therefore no backend Zod contract to mirror,
 * which is exactly why these rules have to be enforced on the client rather than
 * merely described in a comment.
 *
 * DELIBERATELY NOT ENFORCED HERE: the Voice Bible's no-dashes rule that
 * `kinTaleDraftSchema` applies. That rule governs copy Auntie SPEAKS (a headline,
 * a recap body). These fields are household FACTS, a street address, a gate code,
 * a clinic name, and a real address can legitimately carry punctuation that
 * Auntie's prose would not. Rejecting a household's actual address on a style
 * rule would be a validator lying about the data.
 */

// ── phone / email, ported from android util/FieldValidators.kt ───────────────
//
// Ported verbatim rather than re-derived, because that file's own header says it
// "mirrors the AuntieOS web FieldValidators so both surfaces agree on what a
// valid phone/email is". A third, subtly different definition on this surface
// would mean an operator could save a number on web that Android then flags.

/** Permissive RFC-ish shape. The server stays the authoritative verifier. */
const EMAIL_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+\-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

/** Digits plus the common separators only. Letters are rejected outright. */
const PHONE_ALLOWED_CHARS = /^[+0-9()\-. ]+$/;

const EMAIL_MAX = 254;

export function isValidEmail(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed.length > EMAIL_MAX) return false;
  return EMAIL_RE.test(trimmed);
}

/**
 * US rule: exactly 10 digits, or 11 with a leading `1` country code. A 9 digit
 * number is rejected, which is the specific case the Kotlin source calls out.
 */
export function isValidPhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (!PHONE_ALLOWED_CHARS.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/** Optional field: blank is allowed, a non-blank value must be a valid phone. */
export function phoneOkOrBlank(raw: string): boolean {
  return raw.trim() === '' || isValidPhone(raw);
}

/** Optional field: blank is allowed, a non-blank value must be a valid email. */
export function emailOkOrBlank(raw: string): boolean {
  return raw.trim() === '' || isValidEmail(raw);
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * The statuses the picker offers.
 *
 * `archived` is deliberately NOT one of them, which is a considered divergence
 * from `EditKinfolkScreen.kt:267`, where the segmented control lists all four.
 * Picking "archived" there flips `status` alone and leaves `archivedAt` /
 * `archivedReason` / `archivedBy` unwritten, so the record reads as archived
 * while carrying no record of when, why, or by whom. Archiving is a distinct
 * act with its own metadata, so on this surface it is a distinct control (the
 * archive dialog), and the picker cannot produce a half-archived household.
 */
export const KINFOLK_STATUS_OPTIONS = ['active', 'prospect', 'inactive'] as const;

export type KinfolkPickableStatus = (typeof KINFOLK_STATUS_OPTIONS)[number];

/** The stored value an archived household carries. Reachable only via the archive action. */
export const KINFOLK_ARCHIVED_STATUS = 'archived';

// ── schema ──────────────────────────────────────────────────────────────────

/**
 * `status` accepts `archived` even though the picker will not emit it: an
 * already-archived household still has to LOAD into this form so the operator
 * can read it and unarchive it. Rejecting the value it was saved with would make
 * an archived household uneditable.
 */
export const kinfolkEditSchema = z.object({
  firstName: z.string().refine((v) => v.trim() !== '', { message: "First name can't be blank." }),
  lastName: z.string().refine((v) => v.trim() !== '', { message: "Last name can't be blank." }),
  phoneNumber: z
    .string()
    .refine((v) => isValidPhone(v), { message: 'Enter a 10 digit phone number, or 11 starting with 1.' }),
  email: z.string().refine((v) => emailOkOrBlank(v), { message: "That email address doesn't look right." }),
  status: z.enum([...KINFOLK_STATUS_OPTIONS, KINFOLK_ARCHIVED_STATUS]),

  /**
   * One calendar day, or blank. The field is an `<input type="date">`, so those
   * are the only two values it can emit, and this rule says so rather than
   * trusting the control.
   *
   * The `status` note above applies in reverse here, so read them together. An
   * archived household must LOAD with the value it was saved with, because the
   * form is how it gets unarchived. A legacy join date must NOT, because the
   * picker cannot render `07/24/2026` and an operator would be left with an
   * error on a field they never touched, unable to save the phone number they
   * came in to fix. `joinDateForEdit` therefore coerces or clears the value as
   * the form loads, and names the stored string beside the field, so this rule
   * only ever sees something the operator can actually see and change.
   */
  joinDate: z
    .string()
    .refine((v) => v.trim() === '' || isIsoDate(v.trim()), { message: 'Pick a join date from the calendar.' }),

  secondaryPhone: z
    .string()
    .refine((v) => phoneOkOrBlank(v), { message: 'Leave this blank, or enter a 10 digit phone number.' }),
  secondaryEmail: z
    .string()
    .refine((v) => emailOkOrBlank(v), { message: "That email address doesn't look right." }),

  /**
   * Required, matching `EditKinfolkScreen.kt:335` ("Service address is required")
   * and its save gate at :609. Auntie cannot be routed to a visit without one.
   */
  serviceAddress: z.string().refine((v) => v.trim() !== '', { message: 'A service address is required.' }),
  gateCode: z.string(),
  parkingInstructions: z.string(),
  entryNotes: z.string(),
  wifiName: z.string(),
  wifiPassword: z.string(),

  // NO EMERGENCY CONTACT FIELDS (#829). Emergency Contacts moved to their own
  // two-slot editor (`components/EmergencyContactsEditor.tsx`), validated by
  // `validateEmergencyContactDrafts` in `api/emergencyContacts.ts`, not by this
  // schema: they are saved through a separate callable, not this form's patch.

  // NO VET FIELDS. The household vet moved to `household_data`, catalog-linked
  // by clinic id (operator ruling 2026-08-01, page-specs 04 item 3). This
  // schema used to carry all eight, because this screen used to author them,
  // which is exactly what made the kinfolk doc a second writable copy.
});

export type KinfolkEditInput = z.infer<typeof kinfolkEditSchema>;

/** Field name to its first message. An empty object means the form is clean. */
export type KinfolkEditErrors = Partial<Record<keyof KinfolkEditInput, string>>;

/**
 * Validate for inline display. Returns a field-keyed map rather than throwing,
 * because the editor shows each error beside its own input and a thrown ZodError
 * would have to be caught and flattened by every caller anyway.
 */
export function validateKinfolkEdit(input: KinfolkEditInput): KinfolkEditErrors {
  const result = kinfolkEditSchema.safeParse(input);
  if (result.success) return {};

  const errors: KinfolkEditErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    // First message per field wins: stacking messages under one input is noise,
    // and the operator fixes them one at a time regardless.
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as keyof KinfolkEditInput] = issue.message;
    }
  }
  return errors;
}
