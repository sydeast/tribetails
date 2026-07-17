import { call } from '../lib/fns';

/**
 * The write half of the formSchemas admin surface. formSchemas.ts owns
 * listFormSchemas + deleteFormSchema (already shipped); this module owns the
 * two callables the editor needs, getFormSchema (fetch a full doc) and
 * saveFormSchema (create OR update, one callable does both, see below).
 * Kept in a separate file per the fan-out spec rather than folded into
 * formSchemas.ts, so the read-only list screen's module keeps its narrow,
 * already-reviewed surface.
 *
 * Both callables and every field below are confirmed against the live backend:
 *   MyTribe/functions/src/portal/getFormSchema.ts   (FormSchemaDto, `{ schemaId }`)
 *   MyTribe/functions/src/admin/saveFormSchema.ts   (SchemaInputSchema, `{ schema }`)
 * There is no separate createFormSchema/updateFormSchema, saveFormSchema does
 * both: it upserts formSchemas/{id} in a transaction and reports back whether
 * the write was a create (server decides from doc existence, not the client).
 */

/**
 * The 9 field types saveFormSchema's Zod contract accepts (FIELD_TYPES in
 * saveFormSchema.ts). A const tuple, not a plain string[], so a <select> can
 * iterate it while TypeScript still narrows FormField.type to the union below.
 */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'select',
  'multiselect',
  'date',
  'number',
  'checkbox',
  'phone',
  'email',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * 1C placement: which entity a schema attaches to (NONE = global/standalone,
 * e.g. tribeProfile). Mirrors the backend's APPLIES_TO enum exactly.
 */
export const APPLIES_TO = ['NONE', 'KINFOLK', 'KIN', 'HOUSEHOLD', 'SESSION', 'BOOKING', 'KINTALE'] as const;

/**
 * One editable input on a form, field-for-field with the backend's FieldSchema
 * (saveFormSchema.ts) / FieldDto (getFormSchema.ts). `type` is safe to narrow
 * to FieldType here (not `string`, unlike appliesTo below): getFormSchema's
 * parseFieldType defends the read side and only ever returns one of the 9
 * known values, defaulting an unrecognised stored value to 'text'.
 */
export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helperText: string | null;
  placeholder: string | null;
  options: string[] | null;
  defaultValue: string | null;
  group: string | null;
}

/** One section of fields. Mirrors the backend's SectionSchema / SectionDto. */
export interface FormSection {
  title: string;
  description: string | null;
  fields: FormField[];
}

/**
 * Full schema document, field-for-field with getFormSchema's FormSchemaDto /
 * saveFormSchema's SchemaInputSchema.
 *
 * `appliesTo` is kept as `string`, not narrowed to an enum, matching
 * FormSchemaSummary's own choice in formSchemas.ts: getFormSchema's read path
 * does not validate the stored value against APPLIES_TO (only defaults an
 * EMPTY one to 'NONE'), so a hand-edited Firestore doc could carry a stray
 * value. Narrowing the type here would silently misrepresent what the server
 * can actually hand back.
 */
export interface FormSchemaDetail {
  id: string;
  name: string;
  description: string | null;
  appliesTo: string;
  version: number;
  sections: FormSection[];
}

export interface SaveFormSchemaResult {
  id: string;
  version: number;
}

/**
 * getFormSchema: fetches one formSchemas/{id} in full (sections + every
 * field). Matches the backend's Zod contract, `{ schemaId }`, not `{ id }`
 * (deleteFormSchema uses `id`; get does not, per
 * MyTribe/functions/src/portal/getFormSchema.ts). The handler returns the DTO
 * directly, not wrapped in an envelope, so no unwrapping step here.
 * Throws (via lib/fns.call) on `not-found` / auth errors; the editor surfaces
 * the message fail-loud rather than swallowing it.
 */
export async function getFormSchema(id: string): Promise<FormSchemaDetail> {
  return call<{ schemaId: string }, FormSchemaDetail>('getFormSchema', { schemaId: id });
}

/**
 * saveFormSchema: creates formSchemas/{schema.id} if it does not exist, else
 * updates it. One callable, no separate create/update pair, per
 * MyTribe/functions/src/admin/saveFormSchema.ts: the server decides create vs.
 * update from whether the doc already exists (inside a transaction, so two
 * concurrent saves cannot silently clobber each other's version) and always
 * returns the server-computed `version`, never the value the client sent (the
 * request's `version` field is accepted by the Zod schema but ignored on
 * write). Callers should adopt the returned version into local state.
 */
export async function saveFormSchema(schema: FormSchemaDetail): Promise<SaveFormSchemaResult> {
  const res = await call<{ schema: FormSchemaDetail }, { ok: true; id: string; version: number }>(
    'saveFormSchema',
    { schema },
  );
  return { id: res.id, version: res.version };
}
