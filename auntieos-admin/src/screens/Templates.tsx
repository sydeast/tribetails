import { useCallback, useEffect, useState } from 'react';
import { listTemplatesPage, listTemplateCategories, type TemplateSummary } from '../api/templates';
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
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { TemplateEditor } from './TemplateEditor';
import { TemplateAssignments } from './TemplateAssignments';
import { CategoryBindingDialog } from './CategoryBindingDialog';
import './Templates.css';

/**
 * I8: the bank list loads a page at a time (server-side limit + doc-id cursor)
 * with a "Load more" control, instead of fetching the entire `emailTemplates`
 * collection up front. 50 is generous for a first screen and small enough that
 * a large bank is not one blocking read. The stat strip + category chip counts
 * derive from what is LOADED so far (they grow as pages load) rather than
 * claiming a full-collection total the paged read never fetched.
 */
const TEMPLATE_PAGE_SIZE = 50;

/**
 * Admin Template Bank, ported from `TemplateBankScreen.kt#TemplateBankBody`
 * (list) plus `TemplateEditorOverlay` (create/edit), now that the editor
 * exists: see TemplateEditor.tsx.
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
 *  - The editor is an OVERLAY, not a route: this screen owns opening it
 *    (a row click, or the header's "New template" action), the same way the
 *    wasm's `TemplateEditorOverlay` sits on top of `TemplateBankScreen`
 *    rather than being a separate destination. `listTemplates` already
 *    returns every field the editor needs (see `api/templates.ts`'s
 *    `TemplateSummary`), so opening the editor for an existing row is a
 *    local lookup in the already-loaded list, never a second fetch.
 *
 * NOT ported here, separate not-yet-built surfaces:
 *  - The read-only single-template viewer: `TemplateViewOverlay`.
 *  - Drag-and-drop category (re)assignment: `TemplateCategoryDrag.kt`.
 *  - Template *assignment* to notification catalog keys: a wholly separate
 *    screen (`TemplateAssignmentScreen.kt` / `assignTemplate`,
 *    `listTemplateBindings`, `listCatalogKeys`), not this bank list at all.
 *
 * Deleting a template lives in the editor itself (TemplateEditor.tsx's
 * "Delete" action, edit mode only), via `deleteTemplate`. This screen's part
 * of that flow is `handleDeleted` below: reload-after-write, the same
 * convention `handleSaved` already uses, so a deleted row disappears because
 * the server no longer has it, not because of an optimistic local splice.
 */
export interface TemplatesProps {
  /**
   * Row-activation override. Defaults to opening the built-in Template
   * Editor overlay, pre-filled from that row, when omitted: the router
   * mounts this screen PROPLESS in production (see `router.tsx`), so this
   * default is what actually runs for every operator. A caller (a test, or a
   * future route that wants different behavior) can still override it.
   */
  onSelect?: (templateId: string) => void;
  /**
   * "New template" override. Defaults to opening the editor overlay in
   * create mode (a blank template) when omitted, for the same PROPLESS
   * reason as `onSelect` above.
   */
  onNew?: () => void;
}

const ALL_FILTER = null;

type EditorState = { mode: 'create' } | { mode: 'edit'; template: TemplateSummary };

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function Templates({ onSelect, onNew }: TemplatesProps) {
  const [templates, setTemplates] = useState<Async<TemplateSummary[]>>({ status: 'loading' });
  const [categories, setCategories] = useState<Async<string[]>>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string | null>(ALL_FILTER);
  const [editor, setEditor] = useState<EditorState | null>(null);
  // I8 paging: the cursor for the NEXT page (null = list exhausted) and the
  // in-flight / failed state for "Load more".
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // I9 New Binding dialog + its success notice.
  const [bindingOpen, setBindingOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The assignment manager is a sibling VIEW of this screen, not a route (the
  // Communicate.tsx compose/personalize pattern): swap the whole tree rather
  // than grow an if/else through the JSX. Ports TemplateAssignmentScreen.kt,
  // the "wholly separate screen" this file's doc comment named as not-yet-built.
  const [view, setView] = useState<'bank' | 'assignments'>('bank');

  // Hoisted so a failed load can hand AsyncRegion a real retry, same shape as
  // FormSchemas.tsx's load(). Only the TEMPLATES load drives AsyncRegion;
  // categories is secondary chrome (see loadCategories below), matching the
  // wasm's own `reload()`: "Category list is secondary chrome: a failure here
  // must not blank the template list, but it is surfaced."
  const load = useCallback(() => {
    let live = true;
    setTemplates({ status: 'loading' });
    setLoadMoreError(null);
    listTemplatesPage({ limit: TEMPLATE_PAGE_SIZE })
      .then((page) => {
        if (!live) return;
        setTemplates({ status: 'ready', data: page.templates });
        setNextCursor(page.nextCursor);
      })
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

  // Append the next page. Fail-loud into its own inline error (never blanks the
  // rows already shown, and never claims success). Guarded so a double-click or
  // a click with no cursor is a no-op.
  const loadMore = useCallback(() => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    listTemplatesPage({ limit: TEMPLATE_PAGE_SIZE, startAfter: nextCursor })
      .then((page) => {
        setTemplates((prev) =>
          prev.status === 'ready' ? { status: 'ready', data: [...prev.data, ...page.templates] } : prev,
        );
        setNextCursor(page.nextCursor);
        setLoadingMore(false);
      })
      .catch((err: unknown) => {
        setLoadingMore(false);
        setLoadMoreError(
          `listTemplates failed: ${err instanceof Error ? err.message : 'Load more failed'}`,
        );
      });
  }, [nextCursor, loadingMore]);

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

  // Opens the editor pre-filled from an already-loaded row. A stale/missing id
  // (the list hasn't loaded yet, or the row vanished in a reload race) is a
  // silent no-op rather than a crash or a blank editor: there is nothing
  // honest to pre-fill, and this is a row-activation handler, not a route, so
  // there is no error state to hand it either.
  const openEditorFor = useCallback(
    (templateId: string) => {
      if (templates.status !== 'ready') return;
      const row = templates.data.find((t) => t.templateId === templateId);
      if (!row) return;
      setEditor({ mode: 'edit', template: row });
    },
    [templates],
  );

  const handleSelect = onSelect ?? openEditorFor;
  const handleNew = onNew ?? (() => setEditor({ mode: 'create' }));

  // Reload after a save so the row reflects exactly what the server has,
  // rather than optimistically patching local state: the same
  // reload-over-optimistic-splice convention FormSchemas.tsx's confirmDelete()
  // uses for its own write.
  function handleSaved() {
    setEditor(null);
    load();
  }

  // Mirrors handleSaved above: reload after a successful delete rather than
  // optimistically splicing the row out, the same convention
  // FormSchemas.tsx's confirmDelete() uses for its own write.
  function handleDeleted() {
    setEditor(null);
    load();
  }

  // I9: after a successful bulk bind, reload both the bank (a template's
  // category changed) and the category list (a brand-new category may exist),
  // and confirm what happened. Same reload-after-write convention as handleSaved.
  function handleBound({ category, assigned }: { category: string; assigned: number }) {
    setBindingOpen(false);
    setNotice(`Added ${assigned} template${assigned === 1 ? '' : 's'} to ${category}.`);
    load();
    loadCategories();
  }

  const templateCount = asyncScalar(templates, (data) => data.length);
  const categoryCountStat = asyncScalar(categories, (data) => data.length);
  const untaggedCount = asyncScalar(templates, (data) => data.filter(isUntagged).length);

  const categoryList = categories.status === 'ready' ? categories.data : [];

  // Roving-tabindex keyboard nav for the category tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks. Tab 0 is the static "All" chip, tabs 1..N mirror
  // categoryList (both computed off `categories`, already resolved here, not
  // inside AsyncRegion's `templates` render prop).
  const { getTabProps } = useRovingTabs({
    count: 1 + categoryList.length,
    activeIndex: filter === ALL_FILTER ? 0 : 1 + categoryList.indexOf(filter),
  });

  if (view === 'assignments') {
    return <TemplateAssignments onClose={() => setView('bank')} />;
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Template"
        accentTail="Bank."
        subtitle="Browse the email templates SendGrid delivers."
        trailing={
          <>
            <GhostButton label="Manage assignments" onClick={() => setView('assignments')} />
            <GhostButton label="New binding" onClick={() => setBindingOpen(true)} />
            <PrimaryButton label="New template" onClick={handleNew} leading={<PlusGlyph />} />
          </>
        }
      />

      {notice && (
        <Banner tone="success" title="Done" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      <div className="templates__summary">
        <StatCard label="Templates" value={templateCount} trend="loaded" tone="orange" feature />
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
                    {...getTabProps(0)}
                  >
                    All <span className="templates__tab-count">{rows.length}</span>
                  </button>
                  {categoryList.map((cat, index) => (
                    <button
                      key={cat}
                      type="button"
                      role="tab"
                      aria-selected={filter === cat}
                      className={filter === cat ? 'templates__tab templates__tab--active' : 'templates__tab'}
                      onClick={() => setFilter(cat)}
                      {...getTabProps(index + 1)}
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
                      <TemplateRow key={tpl.templateId} tpl={tpl} onSelect={handleSelect} />
                    ))}
                  </ul>
                )}

                {loadMoreError && (
                  <p className="templates__categories-error" role="alert">
                    {loadMoreError}
                  </p>
                )}

                <div className="templates__list-actions">
                  {nextCursor !== null && (
                    <GhostButton
                      label={loadingMore ? 'Loading…' : 'Load more'}
                      onClick={loadMore}
                      disabled={loadingMore}
                    />
                  )}
                  <GhostButton label="Reload" onClick={load} />
                </div>
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {editor ? (
        <TemplateEditor
          template={editor.mode === 'edit' ? editor.template : null}
          categories={categoryList}
          onClose={() => setEditor(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      ) : null}

      {bindingOpen ? (
        <CategoryBindingDialog
          categories={categoryList}
          onClose={() => setBindingOpen(false)}
          onBound={handleBound}
        />
      ) : null}
    </div>
  );
}

interface TemplateRowProps {
  tpl: TemplateSummary;
  /**
   * Always a real handler now that the editor exists (Templates.tsx supplies
   * its internal `openEditorFor` default whenever a caller does not override
   * `onSelect`): unlike the pre-editor placeholder, there is no unwired case
   * left to render statically. See TemplatesProps.onSelect.
   */
  onSelect: (templateId: string) => void;
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

  return (
    <li className="templates__row">
      <button type="button" className="templates__row-main" onClick={() => onSelect(tpl.templateId)}>
        {body}
      </button>
    </li>
  );
}
