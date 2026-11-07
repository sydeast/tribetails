import { emailOkOrBlank, phoneOkOrBlank } from './kinfolkEditSchema';

/** What each Add / Edit secondary kinfolk field has to say. Absent key = fine. */
export interface SecondaryKinfolkFieldErrors {
  name?: string;
  phone?: string;
  email?: string;
}

export const SECONDARY_NAME_REQUIRED = 'A secondary kinfolk needs a name.';
export const SECONDARY_PHONE_INVALID = 'Enter a 10-digit phone number, or leave it blank.';
export const SECONDARY_EMAIL_INVALID = 'Enter an email like name@example.com, or leave it blank.';

/**
 * The checks the server makes on a secondary kinfolk, made before the save
 * (#1593). The walk typed a bad phone and a bad email and waited about four
 * seconds for the server to say no; this says it at the field, at once. The
 * server keeps its own checks: this only spares the round trip.
 */
export function secondaryKinfolkFieldErrors(draft: {
  name: string;
  phone: string;
  email: string;
}): SecondaryKinfolkFieldErrors {
  const out: SecondaryKinfolkFieldErrors = {};
  if (draft.name.trim() === '') out.name = SECONDARY_NAME_REQUIRED;
  if (!phoneOkOrBlank(draft.phone)) out.phone = SECONDARY_PHONE_INVALID;
  if (!emailOkOrBlank(draft.email)) out.email = SECONDARY_EMAIL_INVALID;
  return out;
}
