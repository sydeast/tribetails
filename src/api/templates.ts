import { call } from '../lib/fns';

/**
 * One `emailTemplates/{templateId}` row, as returned by the `listTemplates`
 * admin callable. Mirrors the backend's response shape exactly
 * (MyTribe/functions/src/admin/listTemplates.ts#listTemplatesHandler), which
 * in turn mirrors the wasm's own `TemplateService.EmailTemplate` decode
 * (composeApp/.../data/TemplateService.kt#decodeTemplate) field-for-field.
 *
 * SOURCE CONFIRMED against the callable source, not assumed from the Kotlin
 * model alone:
 *  - `MyTribe/functions/src/admin/listTemplates.ts` reads
 *    `db().collection('emailTemplates').get()` (a plain, unfiltered read of a
 *    flat top-level collection) and maps every doc to exactly the eight
 *    fields below.
 *  - The backend's own `TemplateDoc` type carries an `updatedAtMs` field, but
 *    `listTemplatesHandler`'s RETURNED object does NOT include it: there is
 *    no update/order timestamp anywhere in this response. That absence is why
 *    this is a ONE-SHOT callable, never a `lib/firestore.ts#useCollection`
 *    stream: a live listener requires a real server-side sort field
 *    (`CollectionSpec.order`), and this collection's admin-facing read has
 *    none to give it. The wasm reference (`TemplateBankBody` in
 *    `TemplateBankScreen.kt`) does not re-sort the list either: it renders
 *    whatever order the callable returns: and this port matches that rather
 *    than inventing a sort key the source has no opinion about.
 *  - `TemplateService.kt#decodeTemplate` confirms the same eight fields
 *    client-side, including `title`'s fallback to `templateId` and the two
 *    genuinely-nullable fields (`html`, `description`).
 *
 * Only fields this LIST screen renders are modeled (the `directory.ts`
 * "subset type, not a blind mirror" convention): there are no other fields
 * on this doc to omit; the backend's own summary shape already is the full
 * template.
 */
export interface TemplateSummary {
  templateId: string;
  subject: string;
  body: string;
  html: string | null;
  title: string;
  description: string | null;
  tags: string[];
  /** Free-text, operator-entered. Null/blank means uncategorized: see `lib/templateFormat.ts#templateCategoryState`. */
  category: string | null;
}

/**
 * listTemplates (admin) -> { templates }. Every `emailTemplates` doc,
 * UNSORTED (see the doc comment above: the source has no order field and the
 * wasm reference does not re-sort either). No pagination/cap server-side: the
 * wasm reference has none, and this is a curated content library an operator
 * authors by hand, not an append-only activity log (unlike
 * `kin_care_reports`/`invoices`), so an unbounded read here is not the AO-29
 * pattern `useCollection`'s required `max` exists to close off.
 */
export async function listTemplates(): Promise<TemplateSummary[]> {
  const res = await call<Record<string, never>, { templates: TemplateSummary[] }>(
    'listTemplates',
    {},
  );
  return res.templates ?? [];
}

/**
 * listCategories (admin) -> { categories }. The server-deduped, sorted union
 * of the managed `template_categories` collection and every distinct
 * `category` value already present on an `emailTemplates` doc
 * (`listCategoriesHandler`'s own doc comment calls this the "hybrid category
 * source", Decision 2026-06-03). Powers this screen's filter chips.
 *
 * This list screen does not WRITE to either collection: category
 * *assignment* is the wasm editor's drag-drop (`TemplateCategoryDrag.kt`,
 * `assignCategory`/`saveTemplate`), which is out of scope for a list-only
 * port (see Templates.tsx's doc comment).
 */
export async function listTemplateCategories(): Promise<string[]> {
  const res = await call<Record<string, never>, { categories: string[]; schemaVersion: number }>(
    'listCategories',
    {},
  );
  return res.categories ?? [];
}
