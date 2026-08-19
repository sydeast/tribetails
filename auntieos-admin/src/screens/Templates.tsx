import { useCallback, useEffect, useRef, useState } from 'react';
import { listTemplatesPage, listTemplateCategories, type TemplateSummary } from '../api/templates';
import {
  categoryCount,
  categoryMatchesFilter,
  filterTemplates,
  isUntagged,
  templateEmptyMessage,
  previewTags,
  templateCategoryDisplay,
  templateRowTitle,
  templateSubjectPreview,
} from '../lib/templateFormat';
import { type Async, asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { EntityCardGrid } from '../components/EntityCardGrid';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { TemplateEditor } from './TemplateEditor';
import { TemplateAssignments } from './TemplateAssignments';
import { TemplateImport } from './TemplateImport';
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
  // 'import' joined the pair under issue #468: the seed script is no longer an
  // operator step, so loading the repo's notification templates has to be a
  // screen. Same sibling-view treatment as assignments, not a route.
  const [view, setView] = useState<'bank' | 'assignments' | 'import'>('bank');

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

  // The mock draws a "Ctrl K" kbd hint inside the search box (l.228) and lists
  // the shortcut as its own SUGGESTION (l.31). The hint ships WITH the binding,
  // never on its own: a key legend that does nothing is the same dead
  // affordance as the "Click New" the mock's empty state used to promise.
  //
  // Ctrl and Cmd both, because this admin is driven from a Mac and a browser
  // Ctrl-K there is a different key from the one the operator will reach for.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const input = searchRef.current;
      // No box on screen (first page in flight, or the load failed) means there
      // is nothing to focus, so the key is left to the browser rather than
      // swallowed in exchange for nothing.
      if (input === null) return;
      event.preventDefault();
      input.focus();
      // Select rather than append: the shortcut is how an operator starts a
      // NEW search, and typing over the old query is what that expects.
      input.select();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

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
  if (view === 'import') {
    return (
      <TemplateImport
        onClose={() => setView('bank')}
        onImported={(message) => {
          setNotice(message);
          setView('bank');
          load();
        }}
      />
    );
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
            <GhostButton label="Import from repo" onClick={() => setView('import')} />
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
        /* "card", not "row": this list has been an `EntityCardGrid` since the
           list-shape rule landed, and the instruction has to name the control
           the operator can actually click. */
        subtitle="Click a card to open it. Filter by category, or search by title or key."
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
                    ref={searchRef}
                    type="search"
                    className="templates__search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search templates by title or key…"
                    aria-label="Search templates by title or key"
                  />
                  {/* The mock's `.kbd` span, and it is honest: the binding is
                      wired in the effect above. aria-hidden because the label
                      on the input already names the box for a screen reader,
                      and this legend is a mouse/keyboard affordance. */}
                  <kbd className="templates__search-kbd" aria-hidden="true">
                    Ctrl K
                  </kbd>
                </div>

                {visible.length === 0 ? (
                  <EmptyHint>
                    {/*
                      Three facts, three sentences: an empty bank, an empty
                      category, and a search that matched nothing. The last one
                      also names the bound, because this list is paged and the
                      search only ever sees `rows` (see templateEmptyMessage).
                    */}
                    {templateEmptyMessage({
                      loaded: rows.length,
                      category: filter,
                      query,
                      hasMore: nextCursor !== null,
                    })}
                  </EmptyHint>
                ) : (
                  <EntityCardGrid label="Templates" minCardWidth="310px">
                    {visible.map((tpl) => (
                      <TemplateCard key={tpl.templateId} tpl={tpl} onSelect={handleSelect} />
                    ))}
                  </EntityCardGrid>
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

interface TemplateCardProps {
  tpl: TemplateSummary;
  /**
   * Always a real handler now that the editor exists (Templates.tsx supplies
   * its internal `openEditorFor` default whenever a caller does not override
   * `onSelect`): unlike the pre-editor placeholder, there is no unwired case
   * left to render statically. See TemplatesProps.onSelect.
   */
  onSelect: (templateId: string) => void;
}

/**
 * One template, as a card in the shared `EntityCardGrid`.
 *
 * This was a full-width stacked row until the list-shape rule landed. The
 * mock has drawn a card grid since 2026-05-27
 * (`ui-ideas/auntieos-template-bank-2026-05-27.html`: `.grid` l.108, `.tcard`
 * ll.110-116), and page-spec `24-template-bank.md` talks about nothing but
 * cards ("Per-card category pill", "Card tap → readable view", "drag a
 * template card onto a category bucket"). The row was the accident.
 *
 * The FIELDS are unchanged, and so is every behavior: activating the card
 * still opens the editor overlay. The mock's card footer carries an "Edit"
 * ghost button next to a card-tap read-only viewer; neither is built on this
 * console (`TemplateViewOverlay` is named as not-yet-ported in the screen doc
 * above), so this card grows neither, rather than growing a button that does
 * what tapping the card already does.
 */
function TemplateCard({ tpl, onSelect }: TemplateCardProps) {
  const category = templateCategoryDisplay(tpl.category);
  const tags = previewTags(tpl.tags, 4);
  const description = tpl.description?.trim() ?? '';
  const subject = templateSubjectPreview(tpl);

  // The mock clamps the subject to one line and the description to two
  // (ll.125, 127). Nothing is unreachable behind the clamp: the full string is
  // in the `title` attribute, and opening the card puts it in the editor.
  const body = (
    <>
      <span className="templates__card-name">{templateRowTitle(tpl)}</span>

      <span className="templates__card-meta">
        {category ? <span className="templates__chip templates__chip--category">{category}</span> : null}
        <code className="templates__card-id">{tpl.templateId}</code>
      </span>

      <span className="templates__card-subject" title={subject}>
        {subject}
      </span>

      {description !== '' ? (
        <span className="templates__card-description" title={description}>
          {description}
        </span>
      ) : null}

      {tags.length > 0 ? (
        <span className="templates__card-tags">
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
    <li className="templates__card">
      <button type="button" className="templates__card-main" onClick={() => onSelect(tpl.templateId)}>
        {body}
      </button>
    </li>
  );
}
