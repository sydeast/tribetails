/**
 * The text rules `saveFormSchema` enforces, ported so the editor refuses on
 * screen exactly what the server would refuse on save (#2074).
 *
 * Source of truth: `mytribe/functions/src/admin/saveFormSchema.ts`
 * (`PLAINTEXT_RE`, `MULTILINE_PLAINTEXT_RE`, `FORM_SCHEMA_LIMITS`). The
 * sentences are the server's too (`describeFormSchemaIssue`), so a refusal
 * reads the same whether the editor or the server caught it. The functions
 * test, this module's test and both Kotlin validator tests share the same
 * accept and refuse strings.
 *
 * Before this the editor checked only that the id, name, title, key and label
 * were present and the two identifiers had the right shape. A label holding
 * `<b>x</b>`, an option with `&`, or a 330-character label passed every
 * on-screen check and was refused on save with "Something in this form was not
 * accepted", with no step or field marked.
 */

export const FORM_SCHEMA_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  description: 2000,
  sections: 50,
  sectionTitle: 200,
  sectionDescription: 2000,
  fields: 200,
  key: 80,
  label: 200,
  helperText: 500,
  placeholder: 200,
  options: 100,
  option: 200,
  defaultValue: 2000,
  group: 80,
});

const MARKUP_RE = /[<>&]/;
// eslint-disable-next-line no-control-regex -- the server refuses these, so the editor does
const HIDDEN_RE = /[\x00-\x1F\x7F]/;
// eslint-disable-next-line no-control-regex -- descriptions may hold tab, line feed and carriage return
const HIDDEN_MULTILINE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/**
 * Why `value` cannot be saved as `thing`, or null. `max` is the server's
 * limit for it; `multiline` is true only for the two description boxes,
 * which may hold line breaks and tabs. Emptiness is the caller's check, since
 * only some inputs are required.
 *
 * `group` is the one free-text input the server does not hold to the
 * plain-text rule (it is an internal grouping name), so it passes
 * `plain: false` and is checked for length only.
 */
export function textProblem(
  thing: string,
  value: string | null | undefined,
  max: number,
  opts: { multiline?: boolean; plain?: boolean } = {},
): string | null {
  const v = value ?? '';
  if (v.length > max) return `${thing} is ${v.length} characters long. The limit is ${max}.`;
  if (opts.plain === false) return null;
  if (MARKUP_RE.test(v)) return `${thing} cannot contain <, > or &.`;
  if ((opts.multiline ? HIDDEN_MULTILINE_RE : HIDDEN_RE).test(v)) {
    return `${thing} cannot contain a tab, a line break or another hidden character.`;
  }
  return null;
}

/** One refused input, as `saveFormSchema` reports it in `details.validationErrors`. */
export interface FormSchemaRefusal {
  text: string;
  sectionIndex: number | null;
  fieldIndex: number | null;
}

/**
 * The server's field-level refusals out of a failed save, or [] when the
 * error is not one (a timeout, a permission refusal, a server that predates
 * #2074 and sends no `text`). Reads `details` the way `api/templateChannels.ts`
 * reads its own refusal: by the `reason` token, never by message text.
 */
export function formSchemaRefusals(err: unknown): FormSchemaRefusal[] {
  const details = (err as { details?: unknown } | null)?.details;
  if (typeof details !== 'object' || details === null) return [];
  const { reason, validationErrors } = details as { reason?: unknown; validationErrors?: unknown };
  if (reason !== 'form-schema-refused' || !Array.isArray(validationErrors)) return [];
  const out: FormSchemaRefusal[] = [];
  for (const raw of validationErrors) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as { text?: unknown; sectionIndex?: unknown; fieldIndex?: unknown };
    if (typeof e.text !== 'string' || e.text.trim() === '') continue;
    out.push({
      text: e.text,
      sectionIndex: typeof e.sectionIndex === 'number' ? e.sectionIndex : null,
      fieldIndex: typeof e.fieldIndex === 'number' ? e.fieldIndex : null,
    });
  }
  return out;
}
