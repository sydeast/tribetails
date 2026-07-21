import { z } from 'zod';

/**
 * Validation for the KinTale composer.
 *
 * The convention in this repo has been to hand-mirror the backend's Zod rules in
 * plain TypeScript and keep them in step by comment. That works until the two
 * drift silently, which is the failure mode `FormSchemaEditor` already documents.
 * This is the first schema written as a real schema on the client, so the rules
 * are executable rather than aspirational.
 *
 * Scope note: a KinTale draft is NOT saved through a callable, it is written
 * straight to `kin_care_reports` by `saveKinTaleDraft`. There is therefore no
 * backend Zod contract to mirror here; these rules ARE the contract, which is
 * exactly why they need to be enforced rather than described.
 */

/**
 * Long enough to be a real headline, short enough to survive the tale list
 * without truncation. The generator is told 2 to 6 words, so a generated title
 * lands well inside this.
 */
const TITLE_MAX = 120;

/**
 * The one hard rule Auntie's voice enforces mechanically (Voice Bible section 11):
 * no em dashes, no en dashes, ever. The backend strips them from generated copy;
 * an operator typing one by hand should be told, not silently rewritten, because
 * rewriting someone's punctuation under them is worse than asking.
 */
const NO_DASHES = /[—–]/;

export const kinTaleDraftSchema = z.object({
  title: z
    .string()
    .trim()
    .max(TITLE_MAX, `Keep the headline under ${TITLE_MAX} characters.`)
    .refine((v) => !NO_DASHES.test(v), {
      message: 'Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.',
    }),
  bodyCopy: z.string().refine((v) => !NO_DASHES.test(v), {
    message: 'Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.',
  }),
  /**
   * Required to SEND, not to save. A draft with no session could never be sent,
   * because the send transition has to reach the parent session doc to bump its
   * counters. Saving a sessionless draft still has to work, so this is validated
   * at the send boundary rather than on every keystroke.
   */
  sessionId: z.string(),
});

export type KinTaleDraftInput = z.infer<typeof kinTaleDraftSchema>;

/** Field name to its first message. Empty object means the draft is clean. */
export type KinTaleDraftErrors = Partial<Record<keyof KinTaleDraftInput, string>>;

/**
 * Validate for inline display. Returns a field-keyed map rather than throwing,
 * because the composer shows errors beside the field the operator is in, and a
 * thrown ZodError at that boundary would have to be caught and flattened by
 * every caller anyway.
 */
export function validateKinTaleDraft(input: KinTaleDraftInput): KinTaleDraftErrors {
  const result = kinTaleDraftSchema.safeParse(input);
  if (result.success) return {};

  const errors: KinTaleDraftErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    // First message per field wins: stacking three messages under one input is
    // noise, and the operator fixes them one at a time regardless.
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as keyof KinTaleDraftInput] = issue.message;
    }
  }
  return errors;
}

/**
 * The extra rule that only applies at send time. Kept separate from the schema
 * so a half-finished draft is never blocked from SAVING.
 */
export function kinTaleSendBlocker(input: KinTaleDraftInput): string | null {
  if (input.sessionId.trim() === '') {
    return 'This tale is not linked to an Auntie Time visit, so it cannot be sent. Save it as a draft.';
  }
  return null;
}
