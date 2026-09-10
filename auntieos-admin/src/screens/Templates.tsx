import { useCallback, useEffect, useRef, useState } from 'react';
import { listTemplatesPage, listTemplateCategories, type TemplateSummary } from '../api/templates';
import {
  categoryCount,
  categoryMatchesFilter,
  filterTemplates,
  templateEmptyMessage,
  TEMPLATE_BANK_EMPTY_COPY,
  previewTags,
  templateCategoryDisplay,
  templateRowTitle,
  templateSubjectPreview,
} from '../lib/templateFormat';
import { type Async } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
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
 * a large bank is not one blocking read. The category chip counts derive from
 * what is LOADED so far (they grow as pages load) rather than claiming a
 * full-collection total the paged read never fetched.
 */
const TEMPLATE_PAGE_SIZE = 50;

/**
 * Admin Template Bank. The PAGE FRAME is the 2026-05-27 mock
 * (`ui-ideas/auntieos-template-bank-2026-05-27.html`), per issue #716: a
 * heading with one primary action, one controls row (category chips left,
 * search right), and the card grid directly under it. What the list itself
 * shows is still ported from `TemplateBankScreen.kt#TemplateBankBody` plus
 * `TemplateEditorOverlay` (create/edit), now that the editor exists: see
 * TemplateEditor.tsx.
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
 *  - There is NO stat strip. `TemplateBankBody` draws three `StatCard`s
 *    (Templates / Categories / Untagged) and this port copied them; the mock
 *    draws none, and #716 settled that the mock owns the page frame. The
 *    counts the strip carried are still on screen: the "All" chip counts the
 *    loaded templates, and the other chips count their own category.
 *  - Manage assignments, Import from repo and New binding live behind the
 *    heading's overflow menu. The mock draws one header action, and these
 *    three are real flows the operator uses, so they move rather than go.
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

function DotsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

interface OverflowItem {
  label: string;
  onSelect: () => void;
}

/**
 * The heading's secondary actions, behind one trigger.
 *
 * The mock draws a single "＋ New template" action on this header
 * (`ui-ideas/auntieos-template-bank-2026-05-27.html` l.212), and #716 is the
 * operator saying the live four-button row is not that. Manage assignments,
 * Import from repo and New binding are all real flows an operator uses, so
 * they move behind this menu instead of being deleted.
 *
 * Written here rather than in `components/`: this is the first menu in the
 * admin, and one caller is not yet a shared component. `GhostButton` is not
 * reused for the trigger because its shell forwards no `aria-haspopup` /
 * `aria-expanded`, and a menu trigger that announces neither is a menu a
 * screen reader cannot see coming.
 */
function HeaderOverflowMenu({ items }: { items: readonly OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A pointer press anywhere else on the page dismisses the menu, the way every
  // other menu the operator uses behaves. Scoped to the wrapper, so a press on
  // the trigger or on an item is left to their own handlers.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Focus lands on the first item when the menu opens, so the keyboard path is
  // the same one the mouse takes.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  return (
    <div
      className="templates__overflow"
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className="auntie-btn auntie-btn--ghost templates__overflow-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="auntie-btn__label">More actions</span>
        <DotsGlyph />
      </button>

      {open && (
        <div className="templates__overflow-menu" role="menu" aria-label="More actions" ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="templates__overflow-item"
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
            <HeaderOverflowMenu
              items={[
                { label: 'Manage assignments', onSelect: () => setView('assignments') },
                { label: 'Import from repo', onSelect: () => setView('import') },
                { label: 'New binding', onSelect: () => setBindingOpen(true) },
              ]}
            />
            <PrimaryButton label="New template" onClick={handleNew} leading={<PlusGlyph />} />
          </>
        }
      />

      {notice && (
        <Banner tone="success" title="Done" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {/* No panel and no second title: the mock puts the controls row and the
          grid straight on the page under the heading (#716). */}
      <AsyncRegion
        state={templates}
        what="templates"
        isEmpty={(rows) => rows.length === 0}
        loading={<p className="templates__hint">Loading templates…</p>}
        empty={<EmptyHint>{TEMPLATE_BANK_EMPTY_COPY}</EmptyHint>}
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

              {/* One row, chips left and search right, the way the mock draws
                  its `.controls` (#716). */}
              <div className="templates__controls">
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
              </div>

              {visible.length === 0 ? (
                <EmptyHint>
                  {/*
                    An empty category gets the mock's own copy. A search that
                    matched nothing does not: the mock draws no search box
                    result state, and this list is paged, so the message has to
                    say what was actually searched (see templateEmptyMessage).
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

              {/* Not in the mock, which draws a fixed six-card sample: this is
                  the I8 paging control, and the bank is read a page at a time. */}
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
 * #716 settles the footer. This card used to end at the description and tags,
 * on the reasoning that the mock's "Edit" ghost button sits next to a card-tap
 * read-only viewer this console has not built, so a footer button would only
 * repeat the card tap. The operator marked the missing footer anyway: the mock
 * draws the button, "Edit" is the word for what opening this card does, and a
 * card whose only affordance is the whole card reads as decoration. So the
 * footer button ships, and both it and the card body open the editor. When
 * `TemplateViewOverlay` is ported, the card tap becomes the viewer and this
 * button keeps going straight to the editor.
 *
 * Category pill, description and tags render only when the loaded template
 * carries them. The 50 imported templates carry none of the three, so those
 * cards draw title, key and subject until the DATA has them (an importer job,
 * not a rendering one).
 */
function TemplateCard({ tpl, onSelect }: TemplateCardProps) {
  const category = templateCategoryDisplay(tpl.category);
  const tags = previewTags(tpl.tags, 4);
  const description = tpl.description?.trim() ?? '';
  const subject = templateSubjectPreview(tpl);
  // The prefix labels a real subject. `templateSubjectPreview` also answers
  // "No subject set", and "Subject: No subject set" labels a sentence that is
  // already about the missing subject.
  const hasSubject = tpl.subject.trim() !== '';

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
        {hasSubject ? <span className="templates__card-subject-label">Subject:</span> : null}{' '}
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
      {/* Two sibling controls, never a button inside a button: the card body
          fills the card and stays the click target, and the footer button is
          its own control with its own accessible name. */}
      <button type="button" className="templates__card-main" onClick={() => onSelect(tpl.templateId)}>
        {body}
      </button>
      <div className="templates__card-foot">
        <GhostButton label="Edit" onClick={() => onSelect(tpl.templateId)} />
      </div>
    </li>
  );
}
