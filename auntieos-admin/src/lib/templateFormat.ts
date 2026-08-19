import type { TemplateSummary, TemplateSection } from '../api/templates';

/**
 * Pure Template Bank list classification + display helpers, kept out of the
 * screen so the mapping logic has direct vitest coverage (the
 * sessionFormat.ts / invoiceFormat.ts / kinTaleFormat.ts convention).
 *
 * Ported from the inline logic in `TemplateBankScreen.kt#TemplateBankBody`
 * (`templateBankSearchFilter`, the `filterOptions` category-chip counting,
 * `TemplateCard`'s subject/tag fallbacks, and the "Untagged" stat): the wasm
 * keeps this logic inline in the composable rather than in a model/service
 * file, so there is no existing Kotlin helper module to port 1:1; this file
 * is the equivalent the React port introduces, same role `kinTaleFormat.ts`
 * plays for KinTales.
 *
 * EXTENDED for the Template Editor (create/edit): the second half of this
 * file, below the "editor form" marker, has no wasm counterpart to port from
 * (`TemplateEditorOverlay` keeps its own validation inline in Kotlin, same as
 * the list logic above did before this file existed). These are new, but kept
 * in this module rather than a separate one so every template-shaped pure
 * function lives in one place, matching the existing convention here.
 */

// ── row title / subject / tags ──────────────────────────────────────────────

/**
 * Row display title. The backend already falls back `title` to the doc id
 * when blank (`listTemplatesHandler`: `title: data.title ?? d.id`), so this is
 * a defensive second line of the SAME fallback, matching the
 * `row.name || row.id` convention `FormSchemas.tsx#metaLine`'s row rendering
 * uses for its own server-guaranteed field: cheap insurance, not a sign the
 * guarantee is doubted.
 */
export function templateRowTitle(tpl: Pick<TemplateSummary, 'title' | 'templateId'>): string {
  return tpl.title.trim() !== '' ? tpl.title : tpl.templateId;
}

/** "No subject set" fallback, ported verbatim from `TemplateCard`'s `tpl.subject.ifBlank { "No subject set" }`. */
export function templateSubjectPreview(tpl: Pick<TemplateSummary, 'subject'>): string {
  return tpl.subject.trim() !== '' ? tpl.subject : 'No subject set';
}

/** First `max` tags for a row's chip strip, ported from `TemplateCard`'s `tpl.tags.take(4)`. */
export function previewTags(tags: string[], max = 4): string[] {
  return tags.slice(0, max);
}

/**
 * True when a template carries no tags at all. Backs the wasm's "Untagged"
 * stat card (`templates.count { it.tags.isEmpty() }`): this counts blank
 * TAGS, not a blank CATEGORY; the two facets are independent on this
 * collection, and the wasm's own label ("Untagged" / "no tags yet") is about
 * tags specifically, not the category classification below.
 */
export function isUntagged(tpl: Pick<TemplateSummary, 'tags'>): boolean {
  return tpl.tags.length === 0;
}

// ── search filter ───────────────────────────────────────────────────────────

/**
 * Client-side filter by title or templateId, case-insensitive. Ported
 * verbatim from `templateBankSearchFilter` in `TemplateBankScreen.kt`: a
 * blank query is a no-op, otherwise keeps rows whose title OR templateId
 * contains the query. Subject/body/description are NOT searched: the source
 * doesn't search them either, and this port does not extend the search scope
 * beyond what the wasm ships.
 */
export function filterTemplates(rows: TemplateSummary[], query: string): TemplateSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.title.toLowerCase().includes(q) || r.templateId.toLowerCase().includes(q),
  );
}

/**
 * What to say when the bank list has nothing to render, given WHY.
 *
 * The screen used to collapse three different facts into two strings ("No
 * templates yet." / "Nothing matches this filter."), and the second one was
 * dishonest twice over. It did not say whether the category chip or the
 * search box did the excluding, and it never admitted that the search only
 * ever sees the rows already loaded: `listTemplates` is paged
 * (TEMPLATE_PAGE_SIZE, doc-id cursor), so a template sitting on page two
 * matches nothing here no matter what the operator types, and "Nothing
 * matches" reads as "no such template exists".
 *
 * Hence the two forms. With the cursor closed (`hasMore: false`) the search
 * really did cover the whole collection and says "all N". With it open the
 * message names the bound and points at the Load more control that lifts it.
 *
 * `loaded` is the number of templates the screen has read so far (every page
 * appended), NOT the number the category chip left behind: the denominator
 * has to describe what was searched, not what survived.
 */
export function templateEmptyMessage({
  loaded,
  category,
  query,
  hasMore,
}: {
  loaded: number;
  /** The active category chip, or `null` for "All". */
  category: string | null;
  query: string;
  /** True while `nextCursor !== null`, i.e. the bank has unread pages. */
  hasMore: boolean;
}): string {
  if (loaded === 0) return 'No templates yet.';

  const where = category === null ? '' : ` in ${category}`;
  const plural = loaded === 1 ? '' : 's';
  const q = query.trim();

  if (q === '') {
    // A category with nothing in it. Bounded-honest only when pages remain.
    return hasMore
      ? `No templates${where} among the ${loaded} loaded so far. Load more to check the rest.`
      : `No templates${where}.`;
  }

  const scope = hasMore
    ? `Searched the ${loaded} template${plural} loaded so far, by title and key. Load more to search further.`
    : `Searched all ${loaded} template${plural}, by title and key.`;
  return `Nothing${where} matches "${q}". ${scope}`;
}

// ── category classification (positive enumeration, no negation) ────────────

/**
 * Every state this module returns for the `category` facet. `category` is a
 * free-text, operator-entered field with no enum on the source doc (unlike
 * `kin_care_reports.status`/`invoices.status`), so this is a two-member
 * classification rather than a closed set of literal server codes: but the
 * same AO-12 rule applies: a blank/null category gets its own honest bucket
 * (`'uncategorized'`) instead of a fabricated category name, and the test is
 * always POSITIVE ("category is present and non-blank"), never "not one of
 * the known categories".
 */
export type TemplateCategoryState = 'categorized' | 'uncategorized';

export function templateCategoryState(category: string | null): TemplateCategoryState {
  return category !== null && category.trim() !== '' ? 'categorized' : 'uncategorized';
}

/**
 * The category text to actually show on a row, or `null` when there is none
 * to show: mirrors `TemplateCard`'s
 * `tpl.category?.takeIf { it.isNotBlank() }?.let { cat -> AuntieChip(...) }`:
 * the chip is omitted entirely for an uncategorized row (the
 * `ServicePill`-only-when-non-blank convention `KinTales.tsx` uses for
 * `serviceType`), never rendered with a fabricated "Uncategorized" label the
 * source doesn't have.
 */
export function templateCategoryDisplay(category: string | null): string | null {
  return templateCategoryState(category) === 'categorized' ? (category as string).trim() : null;
}

/**
 * Does this template belong to filter chip `filterCategory` (a real category
 * name from `listTemplateCategories`, never blank)? Case-insensitive, and
 * ported from the Kotlin's own null-safe `tpl.category.equals(opt, ignoreCase
 * = true)`: Kotlin's `String?.equals(other: String?, ignoreCase)` extension
 * returns `false` whenever exactly one side is null, so an uncategorized
 * template never matches a specific category chip: it only ever shows under
 * "All". The screen short-circuits "All" before calling this (there is no
 * "All" case to handle here), matching the source, which also never calls
 * this comparison for its "All" chip.
 */
export function categoryMatchesFilter(category: string | null, filterCategory: string): boolean {
  if (templateCategoryState(category) === 'uncategorized') return false;
  return (category as string).trim().toLowerCase() === filterCategory.trim().toLowerCase();
}

/**
 * How many templates carry category `name`, ported from the wasm chip's
 * `templates.count { it.category.equals(opt, ignoreCase = true) }`.
 */
export function categoryCount(templates: TemplateSummary[], name: string): number {
  return templates.filter((t) => categoryMatchesFilter(t.category, name)).length;
}

// ── editor form (create/edit) ───────────────────────────────────────────────
//
// Everything below backs TemplateEditor.tsx. All of it is validation/payload
// shaping ONLY: no callable, no React, so it is unit-testable in isolation
// exactly like the list helpers above.

/**
 * Matches the backend's own `templateId` regex EXACTLY
 * (`MyTribe/functions/src/admin/saveTemplate.ts`'s `Args.templateId`:
 * `z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/)`). Validating the
 * same pattern client-side turns a guaranteed `invalid-argument` round trip
 * into an inline message the operator sees before they ever click Save.
 */
export const TEMPLATE_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Mirrors the backend's own `.max(120)` on `templateId`, so the inline error can name the same limit the server enforces. */
export const TEMPLATE_ID_MAX_LENGTH = 120;

/**
 * The raw field values TemplateEditor.tsx holds in state, one `useState` slot
 * of untouched operator input each. `tagsInput` and `html` are plain strings
 * (a comma-separated line, and a possibly-empty textarea) rather than the
 * `string[]` / `string | null` shapes the save payload needs: that shaping
 * happens in `buildSaveTemplatePayload` below, kept separate from what the
 * form fields themselves look like.
 */
export interface TemplateFormFields {
  templateId: string;
  title: string;
  subject: string;
  body: string;
  html: string;
  description: string;
  category: string;
  tagsInput: string;
  /** I9: free-text guidance for the operator. Plain string; `''` when unset. */
  usageInstructions: string;
  /**
   * I9: the editable section rows. Held as-typed (a row can be half-filled while
   * the operator works); `buildSaveTemplatePayload` trims and drops any row whose
   * title is blank, the same way `parseTagsInput` drops blank tags.
   */
  sections: TemplateSection[];
}

/** A fresh, empty section row for the editor's "Add section" control. */
export function blankSection(): TemplateSection {
  return { title: '', description: '' };
}

/** An editor pre-filled from an existing row (edit mode). templateId is carried through but the editor renders it read-only. */
export function templateToFormFields(tpl: TemplateSummary): TemplateFormFields {
  return {
    templateId: tpl.templateId,
    title: tpl.title,
    subject: tpl.subject,
    body: tpl.body,
    html: tpl.html ?? '',
    description: tpl.description ?? '',
    category: tpl.category ?? '',
    tagsInput: formatTagsInput(tpl.tags),
    usageInstructions: tpl.usageInstructions ?? '',
    // Copy each row so editing form state never mutates the loaded template.
    sections: (tpl.sectionDefinitions ?? []).map((s) => ({ ...s })),
  };
}

/** A blank form for create mode. Every field starts empty; nothing is pre-filled from a prior edit. */
export function blankFormFields(): TemplateFormFields {
  return {
    templateId: '',
    title: '',
    subject: '',
    body: '',
    html: '',
    description: '',
    category: '',
    tagsInput: '',
    usageInstructions: '',
    sections: [],
  };
}

/**
 * Trims each section row and drops any whose title is blank (a titleless section
 * is meaningless and the backend rejects it). `description` may be empty. Mirrors
 * `parseTagsInput`'s drop-the-blanks behaviour for the structured-list case.
 */
export function parseSections(sections: TemplateSection[]): TemplateSection[] {
  return sections
    .map((s) => ({ title: s.title.trim(), description: s.description.trim() }))
    .filter((s) => s.title !== '');
}

/**
 * Splits the editor's single comma-separated tags line into the trimmed,
 * non-blank tag list the backend expects, dropping any run of blank entries a
 * trailing/doubled comma would otherwise produce (`"a, , b,"` -> `["a", "b"]`).
 */
export function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** The inverse of `parseTagsInput`, for pre-filling the editor from an existing row's `tags: string[]`. */
export function formatTagsInput(tags: string[]): string {
  return tags.join(', ');
}

/**
 * templateId field error, or `null` when it is valid. Only checked in CREATE
 * mode: the id is the Firestore doc path segment, so an edit never changes it
 * (see TemplateEditor.tsx), and re-validating an already-saved id on every
 * edit would risk rejecting a legacy id the backend already accepted under a
 * looser or since-changed rule.
 */
export function templateIdError(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed === '') return 'Template key is required.';
  if (trimmed.length > TEMPLATE_ID_MAX_LENGTH) {
    return `Template key must be ${TEMPLATE_ID_MAX_LENGTH} characters or fewer.`;
  }
  if (!TEMPLATE_ID_PATTERN.test(trimmed)) {
    return 'Template key may only use letters, numbers, underscore, period, and hyphen.';
  }
  return null;
}

/**
 * The single blocking error for the whole form, or `null` when it is ready to
 * submit. Checked in this order because a missing/malformed key is the most
 * likely mistake on a brand-new template and the operator should see that
 * before anything else. Only `templateId` (create-only), `subject`, and
 * `body` are required: `title`/`description`/`category`/`tags`/`html` are all
 * optional on the backend (`Args` schema), and the editor does not invent a
 * stricter rule than the server enforces.
 */
export function templateFormError(
  fields: Pick<TemplateFormFields, 'templateId' | 'subject' | 'body'>,
  opts: { isCreate: boolean },
): string | null {
  if (opts.isCreate) {
    const idError = templateIdError(fields.templateId);
    if (idError) return idError;
  }
  if (fields.subject.trim() === '') return 'Subject is required.';
  if (fields.body.trim() === '') return 'Body is required.';
  return null;
}

/**
 * The exact `saveTemplate` callable payload for these form fields. Mirrors
 * `saveTemplateHandler`'s `Args` shape field-for-field
 * (`MyTribe/functions/src/admin/saveTemplate.ts`):
 *
 *  - `title` / `description` / `category` are OPTIONAL strings on the
 *    backend, not nullable (`z.string().optional()`, no `.nullable()`). A
 *    blank field is omitted from the payload entirely (`undefined`), never
 *    sent as `null`: an explicit `null` for any of these three would fail the
 *    server's zod parse with `invalid-argument`. Omitting `title` also lets
 *    the backend's own `title: args.title ?? args.templateId` fallback apply,
 *    matching `templateRowTitle`'s read-side fallback above.
 *  - `html` is the one field the backend DOES accept `null` for
 *    (`z.string().max(50000).nullable().optional()`), matching
 *    `TemplateSummary.html: string | null`. A blank html field is sent as
 *    `null`, not omitted, so a save that clears existing HTML actually clears
 *    it rather than leaving the old value (`{ merge: true }` on the backend
 *    would otherwise keep a field that is left out of the payload).
 *  - `tags` is always sent, including an empty array for "no tags": the
 *    backend does `args.tags ?? []` either way, and sending `[]` explicitly is
 *    what lets a save actually CLEAR a template's existing tags.
 *
 * Caller is expected to have already checked `templateFormError` returns
 * `null` before calling this: it does not re-validate.
 */
export interface SaveTemplatePayload {
  templateId: string;
  subject: string;
  body: string;
  html: string | null;
  title?: string;
  description?: string;
  tags: string[];
  category?: string;
  /**
   * I9: always sent (a possibly-empty string / array), the same as `tags` above,
   * so a save can CLEAR them. The backend writes them only because the field is
   * present; an older client that omits them leaves any existing value intact
   * (see `saveTemplate.ts`).
   */
  usageInstructions: string;
  sectionDefinitions: TemplateSection[];
  /**
   * Issue #468: sent as `true` only from the New Template path, where it makes
   * the server refuse a key that already exists instead of upserting over it.
   * Omitted when editing, so an edit stays the upsert it has always been.
   */
  expectNew?: boolean;
}

export function buildSaveTemplatePayload(
  fields: TemplateFormFields,
  opts: { isCreate?: boolean } = {},
): SaveTemplatePayload {
  const title = fields.title.trim();
  const description = fields.description.trim();
  const category = fields.category.trim();
  const html = fields.html.trim();

  return {
    templateId: fields.templateId.trim(),
    subject: fields.subject.trim(),
    body: fields.body.trim(),
    html: html === '' ? null : html,
    ...(title !== '' ? { title } : {}),
    ...(description !== '' ? { description } : {}),
    ...(category !== '' ? { category } : {}),
    tags: parseTagsInput(fields.tagsInput),
    usageInstructions: fields.usageInstructions.trim(),
    sectionDefinitions: parseSections(fields.sections),
    ...(opts.isCreate ? { expectNew: true } : {}),
  };
}
