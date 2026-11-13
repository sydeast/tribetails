/**
 * #1962: the "last saved" stamp every writer of the Settings documents puts on
 * its write (`business_settings/business_settings` and
 * `business_settings/email_frame`).
 *
 * WHO IS THE UID, NEVER A LABEL. The screens resolve it to the staff member's
 * name when they read it (`listStaff` answers by uid), so the name shown is the
 * person's current one and a stamp never prints as an id or a sign-in email.
 * The main save used to stamp the sign-in email, and the roster cannot answer
 * for that when the staff record holds no email of its own, which is the case
 * the 2026-11-10 walk found. Tag removal, the logo confirm and the email frame
 * stamped the uid, so the same line read as an email after one save and as an
 * id after another.
 *
 * Pure, with no imports: four callables load it, and anything heavier would
 * land on their cold starts (`test/coldStartImportGraph.test.ts`).
 */
export interface SavedByStamp {
  /** ISO 8601, the form both documents have always held. */
  updatedAt: string;
  /** The signed-in caller's uid. */
  updatedBy: string;
}

export function savedByStamp(uid: string, now: Date = new Date()): SavedByStamp {
  return { updatedAt: now.toISOString(), updatedBy: uid };
}
