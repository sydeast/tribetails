import { useCallback, useEffect, useState } from 'react';
import { listTemplates, listTemplateCategories, type TemplateSummary } from '../api/templates';
import {
  categoryCount,
  categoryMatchesFilter,
  filterTemplates,
  isUntagged,
  previewTags,
  templateCategoryDisplay,
  templateRowTitle,
  templateSubjectPreview,
} from '../lib/templateFormat';
import { type Async, asyncScalar } from '../lib/async';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton } from '../components/Buttons';
import './Templates.css';

/**
 * Admin Template Bank list ("The Den · Admin", ported from
 * `TemplateBankScreen.kt#TemplateBankBody`). LIST ONLY, per the port brief:
 *
 *  - Reads via TWO one-shot admin callables, `listTemplates` (the
 *    `emailTemplates` collection) and `listCategories` (the hybrid managed ∪
 *    distinct category list): see `api/templates.ts` for why this is a
 *    one-shot load rather than a `useCollection` stream (the source doc has
 *    no order/timestamp field the admin read exposes).
 *  - Filter chips are "All" plus every real category name from
 *    `listCategories`, each with a live count: ported from
 *    `TemplateBankBody`'s `filterOptions` FlowRow, using `useState` tabs
 *    (the `Invoices.tsx`/`KinTales.tsx` `FILTERS`/`FilterKey` convention)
 *    rather than Compose chips.
 *  - The stat strip (Templates / Categories / Untagged) matches
 *    `TemplateBankBody`'s three `StatCard`s exactly, including the
 *    "Untagged" card counting blank TAGS, not a blank category (see
 *    `lib/templateFormat.ts#isUntagged`'s doc comment).
 *
 * NOT ported here, all separate not-yet-built surfaces:
 *  - The template editor (create/edit subject, body, HTML, description,
 *    category): `TemplateEditorOverlay` in the wasm.
 *  - The read-only single-template viewer: `TemplateViewOverlay`.
 *  - "New template" (create): the wasm's header `PrimaryButton`.
 *  - Drag-and-drop category (re)assignment: `TemplateCategoryDrag.kt`.
 *  - Template *assignment* to notification catalog keys: a wholly separate
 *    screen (`TemplateAssignmentScreen.kt` / `assignTemplate`,
 *    `listTemplateBindings`, `listCatalogKeys`), not this bank list at all.
 *
 * `onSelect` is this screen's only hook into that later work: see the
 * DEAD-CONTROL doc comment on `TemplatesProps` below.
 */
export interface TemplatesProps {
  /**
   * Placeholder: the single-template viewer/editor is not built yet. The
   * router mounts this screen PROPLESS, so `onSelect` is undefined in
   * production: a live `<button>` wired to `onSelect?.(id)` would then be a
   * focusable, hand-cursor control that silently no-ops (the dead-control
   * anti-pattern). Per the `KinTales.tsx`/`Invoices.tsx` convention, a row
   * renders a STATIC, non-interactive element when `onSelect` is absent, and
   * a real `<button>` only once a detail/editor route wires it: touching
   * only the router later, not this file.
   */
  onSelect?: (templateId: string) => void;
}

const ALL_FILTER = null;

export function Templates({ onSelect }: TemplatesProps) {
  const [templates, setTemplates] = useState<Async<TemplateSummary[]>>({ status: 'loading' });
  const [categories, setCategories] = useState<Async<string[]>>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string | null>(ALL_FILTER);

  // Hoisted so a failed load can hand AsyncRegion a real retry, same shape as
  // FormSchemas.tsx's load(). Only the TEMPLATES load drives AsyncRegion;
  // categories is secondary chrome (see loadCategories below), matching the
  // wasm's own `reload()`: "Category list is secondary chrome: a failure here
  // must not blank the template list, but it is surfaced."
  const load = useCallback(() => {
    let live = true;
    setTemplates({ status: 'loading' });
    listTemplates()
      .then((data) => live && setTemplates({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setTemplates({
            status: 'error',
            message: `listTemplates failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  const loadCategories = useCallback(() => {
    let live = true;
    setCategories({ status: 'loading' });
    listTemplateCategories()
      .then((data) => live && setCategories({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setCategories({
            status: 'error',
            message: `listCategories failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: loadCategories,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);
  useEffect(() => loadCategories(), [loadCategories]);

  // If the active category chip disappears after a reload (deleted server-side),
  // fall back to All so the list never strands on an empty, tab-less filter.
  useEffect(() => {
    if (filter !== ALL_FILTER && categories.status === 'ready' && !categories.data.includes(filter)) {
      setFilter(ALL_FILTER);
    }
  }, [filter, categories]);

  const templateCount = asyncScalar(templates, (data) => data.length);
  const categoryCountStat = asyncScalar(categories, (data) => data.length);
  const untaggedCount = asyncScalar(templates, (data) => data.filter(isUntagged).length);

  const categoryList = categories.status === 'ready' ? categories.data : [];

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Template"
        accentTail="Bank."
        subtitle="Browse the email templates SendGrid delivers."
      />

      <div className="templates__summary">
        <StatCard label="Templates" value={templateCount} trend="in the bank" tone="orange" feature />
        <StatCard label="Categories" value={categoryCountStat} trend="in use" tone="purple" />
        <StatCard label="Untagged" value={untaggedCount} trend="no tags yet" tone="teal" />
      </div>

      <DenPanel
        title="Templates"
        subtitle="Click a row to open it. Filter by category, or search by title or key."
      >
        <AsyncRegion
          state={templates}
          what="templates"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="templates__hint">Loading templates…</p>}
          empty={<EmptyHint>No templates yet.</EmptyHint>}
        >
          {(rows) => {
            const byCategory =
              filter === ALL_FILTER ? rows : rows.filter((r) => categoryMatchesFilter(r.category, filter));
            const visible = filterTemplates(byCategory, query);

            return (
              <>
                {categories.status === 'error' && (
                  <p className="templates__categories-error" role="alert">
                    Categories unavailable: {categories.message}
                  </p>
                )}

                <div className="templates__tabs" role="tablist" aria-label="Filter templates by category">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter === ALL_FILTER}
                    className={
                      filter === ALL_FILTER ? 'templates__tab templates__tab--active' : 'templates__tab'
                    }
                    onClick={() => setFilter(ALL_FILTER)}
                  >
                    All <span className="templates__tab-count">{rows.length}</span>
                  </button>
                  {categoryList.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      role="tab"
                      aria-selected={filter === cat}
                      className={filter === cat ? 'templates__tab templates__tab--active' : 'templates__tab'}
                      onClick={() => setFilter(cat)}
                    >
                      {cat} <span className="templates__tab-count">{categoryCount(rows, cat)}</span>
                    </button>
                  ))}
                </div>

                <div className="templates__search">
                  <input
                    type="search"
                    className="templates__search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search templates by title or key…"
                    aria-label="Search templates by title or key"
                  />
                </div>

                {visible.length === 0 ? (
                  <EmptyHint>
                    {rows.length === 0 ? 'No templates yet.' : 'Nothing matches this filter.'}
                  </EmptyHint>
                ) : (
                  <ul className="templates__list">
                    {visible.map((tpl) => (
                      <TemplateRow key={tpl.templateId} tpl={tpl} onSelect={onSelect} />
                    ))}
                  </ul>
                )}

                <GhostButton label="Reload" onClick={load} className="templates__reload" />
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

interface TemplateRowProps {
  tpl: TemplateSummary;
  onSelect?: ((templateId: string) => void) | undefined;
}

function TemplateRow({ tpl, onSelect }: TemplateRowProps) {
  const category = templateCategoryDisplay(tpl.category);
  const tags = previewTags(tpl.tags, 4);
  const description = tpl.description?.trim() ?? '';

  const body = (
    <>
      <span className="templates__row-head">
        <span className="templates__row-name">{templateRowTitle(tpl)}</span>
        {category ? <span className="templates__chip templates__chip--category">{category}</span> : null}
      </span>

      <code className="templates__row-id">{tpl.templateId}</code>

      <span className="templates__row-subject">{templateSubjectPreview(tpl)}</span>

      {description !== '' ? <span className="templates__row-description">{description}</span> : null}

      {tags.length > 0 ? (
        <span className="templates__row-tags">
          {tags.map((tag) => (
            <span key={tag} className="templates__chip templates__chip--tag">
              {tag}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );

  // Static, non-interactive row unless a detail handler is wired (see
  // TemplatesProps.onSelect): a live no-op button is the dead-control
  // anti-pattern.
  return (
    <li className="templates__row">
      {onSelect ? (
        <button type="button" className="templates__row-main" onClick={() => onSelect(tpl.templateId)}>
          {body}
        </button>
      ) : (
        <div className="templates__row-main templates__row-main--static">{body}</div>
      )}
    </li>
  );
}
