import { call } from '../lib/fns';

/**
 * One `formSchemas/{id}` summary row, as returned by listFormSchemas. Mirrors
 * the backend's FormSchemaSummary (MyTribe/functions/src/admin/listFormSchemas.ts)
 * field-for-field, including the two fields the server can genuinely send back
 * `null` for (a schema that was written before updatedAt/updatedBy existed).
 */
export interface FormSchemaSummary {
  id: string;
  name: string;
  /** NONE | KINFOLK | KIN | HOUSEHOLD | SESSION | BOOKING | KINTALE (1C placement). */
  appliesTo: string;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * listFormSchemas (admin) -> { schemas }. Lightweight summaries of every
 * formSchemas/{id} doc; full bodies are fetched per-schema by the editor (not
 * this screen — see FormSchemas.tsx for the onSelect placeholder).
 *
 * The backend already returns a stable name-then-id sort, so this module does
 * not re-sort; the wasm reference (FormSchemaListScreen.kt) re-sorts client-side
 * by updatedAt desc for the operator's "what changed recently" workflow, which
 * the screen replicates over whatever order arrives here.
 */
export async function listFormSchemas(): Promise<FormSchemaSummary[]> {
  const res = await call<Record<string, never>, { schemas: FormSchemaSummary[] }>(
    'listFormSchemas',
    {},
  );
  return res.schemas ?? [];
}

/**
 * deleteFormSchema (admin): permanently deletes formSchemas/{id}. Matches the
 * backend's Zod contract exactly — `{ id }`, not `{ schemaId }` (getFormSchema
 * uses schemaId; delete does not, per MyTribe/functions/src/admin/deleteFormSchema.ts).
 * Throws (via lib/fns.call) on `not-found` / `invalid-argument` / auth errors;
 * the screen surfaces the message fail-loud rather than swallowing it.
 */
export async function deleteFormSchema(id: string): Promise<void> {
  await call<{ id: string }, { ok: true }>('deleteFormSchema', { id });
}
