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
/**
 * One authored section of a template, as guidance for the operator. I9 added
 * `sectionDefinitions` to the template model; the shape is `{ title, description }`
 * because the template doc has no richer sub-structure to mirror and this fits a
 * "the parts of this template, described" list. The backend guarantees `title`
 * is non-empty on any persisted section and defaults `description` to `''`.
 */
export interface TemplateSection {
  title: string;
  description: string;
}

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
  /**
   * I9 operator-authoring metadata. The backend always returns these (defaulted:
   * `''` / `[]`) so a pre-existing doc without them still decodes; older docs
   * simply carry the defaults.
   */
  usageInstructions: string;
  sectionDefinitions: TemplateSection[];
}

/**
 * listTemplates (admin) -> the WHOLE `emailTemplates` collection, ordered by
 * document id server-side (I8). Kept for the surfaces that genuinely need every
 * template at once: the assignment picker (TemplateAssignments) and the New
 * Binding category dialog, whose whole job is to choose across all templates.
 * The bank LIST view (Templates.tsx) uses `listTemplatesPage` instead, so the
 * default screen no longer fetches the entire collection up front.
 */
export async function listTemplates(): Promise<TemplateSummary[]> {
  const res = await call<Record<string, never>, { templates: TemplateSummary[] }>(
    'listTemplates',
    {},
  );
  return res.templates ?? [];
}

export interface TemplatesPage {
  templates: TemplateSummary[];
  /** The id to pass as `startAfter` for the next page, or null when exhausted. */
  nextCursor: string | null;
}

export interface ListTemplatesPageArgs {
  limit: number;
  /** Doc-id cursor from a previous page's `nextCursor`. Omit for the first page. */
  startAfter?: string;
}

/**
 * listTemplates (admin), paginated (I8). Same callable as `listTemplates`, but
 * with a server-side `limit` + doc-id `startAfter` cursor so the bank list loads
 * a page at a time instead of the entire collection. `nextCursor` is the doc id
 * to page forward from, or null once the list is exhausted. Backward compatible:
 * the backend returns the full collection (nextCursor null) when no `limit` is
 * passed, which is exactly what `listTemplates` above relies on.
 */
export async function listTemplatesPage(args: ListTemplatesPageArgs): Promise<TemplatesPage> {
  const res = await call<ListTemplatesPageArgs, { templates?: TemplateSummary[]; nextCursor?: string | null }>(
    'listTemplates',
    args,
  );
  return { templates: res.templates ?? [], nextCursor: res.nextCursor ?? null };
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
