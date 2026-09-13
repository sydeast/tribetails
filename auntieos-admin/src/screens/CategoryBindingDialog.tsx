import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { listTemplates, type TemplateSummary } from '../api/templates';
import { assignTemplatesToCategory } from '../api/templatesWrite';
import { filterTemplates, templateCategoryDisplay, templateRowTitle } from '../lib/templateFormat';
import { type Async } from '../lib/async';
import { Dialog } from '../components/Dialog';
import { LoadingRow } from '../components/LoadingRow';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import { AsyncRegion } from '../components/AsyncRegion';
import { EmptyHint } from '../components/DenScreenKit';
import './CategoryBindingDialog.css';

export interface CategoryBindingDialogProps {
  /** Known category names, for the datalist suggestions. Typing a new name creates it. */
  categories: string[];
  onClose: () => void;
  /** Called once the batch bind resolves; the caller reloads the bank + categories. */
  onBound: (result: { category: string; assigned: number }) => void;
}

/**
 * I9 "New Binding": bind MANY templates to ONE category in a single action,
 * creating the category inline. "Binding a template to a category" is the
 * template's own `category` field; today it is set one template at a time (the
 * editor's category input, or the Compose drag-drop). This dialog does the bulk
 * case: pick or type a category, tick the templates, bind them all via
 * `assignTemplatesToCategory`.
 *
 * Loads its OWN full template list (not the bank's paged view): the whole point
 * of this action is to choose across every template, so completeness matters
 * more here than the bank list's lazy paging. Fail-loud throughout: the load,
 * and the bind, each surface their callable name on failure; the primary action
 * disables while a call is in flight and while nothing is selected.
 */
export function CategoryBindingDialog({ categories, onClose, onBound }: CategoryBindingDialogProps) {
  const [templates, setTemplates] = useState<Async<TemplateSummary[]>>({ status: 'loading' });
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categoryListId = useId();

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

  useEffect(() => load(), [load]);

  const requestClose = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  const allRows = templates.status === 'ready' ? templates.data : [];
  const visibleRows = useMemo(() => filterTemplates(allRows, query), [allRows, query]);

  function toggle(templateId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });
  }

  // Select-all acts on the CURRENTLY VISIBLE (filtered) rows only, so it never
  // silently ticks templates the operator cannot see. If every visible row is
  // already selected, the control clears them instead.
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.templateId));
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of visibleRows) next.delete(r.templateId);
      } else {
        for (const r of visibleRows) next.add(r.templateId);
      }
      return next;
    });
  }

  const trimmedCategory = category.trim();
  const canBind = trimmedCategory !== '' && selected.size > 0 && !saving;

  async function handleBind() {
    if (!canBind) return;
    setSaving(true);
    setError(null);
    try {
      const res = await assignTemplatesToCategory({
        category: trimmedCategory,
        templateIds: Array.from(selected),
      });
      setSaving(false);
      onBound({ category: res.category, assigned: res.assigned });
    } catch (err) {
      setSaving(false);
      setError(
        `assignTemplatesToCategory failed: ${err instanceof Error ? err.message : 'Bind failed'}`,
      );
    }
  }

  return (
    <Dialog
      title="New binding"
      onClose={requestClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={requestClose} disabled={saving} />
          <PrimaryButton
            label={
              saving
                ? 'Binding…'
                : selected.size > 0
                  ? `Add ${selected.size} to category`
                  : 'Add to category'
            }
            onClick={() => void handleBind()}
            disabled={!canBind}
            busy={saving}
          />
        </>
      }
    >
      {error ? (
        <Banner tone="error" title="Couldn&rsquo;t bind" className="cbind__error">
          {error}
        </Banner>
      ) : null}

      <p className="cbind__intro">
        Add one or more templates to a category. Type a new category name to create it.
      </p>

      <fieldset className="cbind__fields" disabled={saving}>
        <legend className="cbind__sr-legend">New binding</legend>

        <div className="cbind__field">
          <label className="cbind__label" htmlFor="cbind-category">
            Category
          </label>
          <input
            id="cbind-category"
            type="text"
            className="cbind__input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Booking"
            maxLength={60}
            autoFocus
            {...(categories.length > 0 ? { list: categoryListId } : {})}
          />
          {categories.length > 0 ? (
            <datalist id={categoryListId}>
              {categories.map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          ) : null}
        </div>

        <div className="cbind__field">
          <div className="cbind__templates-head">
            <span className="cbind__label">Templates</span>
            {visibleRows.length > 0 ? (
              <GhostButton
                label={allVisibleSelected ? 'Clear shown' : 'Select shown'}
                onClick={toggleAllVisible}
              />
            ) : null}
          </div>

          <input
            type="search"
            className="cbind__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates by title or key…"
            aria-label="Search templates by title or key"
          />

          <AsyncRegion
            state={templates}
            what="templates"
            isEmpty={(rows) => rows.length === 0}
            loading={<LoadingRow label="Loading templates…" className="cbind__hint" />}
            empty={<EmptyHint>No templates to bind yet.</EmptyHint>}
          >
            {() =>
              visibleRows.length === 0 ? (
                <EmptyHint>Nothing matches this search.</EmptyHint>
              ) : (
                <ul className="cbind__list">
                  {visibleRows.map((tpl) => {
                    const current = templateCategoryDisplay(tpl.category);
                    return (
                      <li key={tpl.templateId} className="cbind__row">
                        <label className="cbind__check">
                          <input
                            type="checkbox"
                            checked={selected.has(tpl.templateId)}
                            onChange={() => toggle(tpl.templateId)}
                          />
                          <span className="cbind__row-main">
                            <span className="cbind__row-title">{templateRowTitle(tpl)}</span>
                            <code className="cbind__row-id">{tpl.templateId}</code>
                          </span>
                        </label>
                        {current ? <span className="cbind__row-current">in {current}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </AsyncRegion>
        </div>
      </fieldset>
    </Dialog>
  );
}
