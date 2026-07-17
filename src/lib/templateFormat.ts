import type { TemplateSummary } from '../api/templates';

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
