import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listTemplateBindings,
  listCatalogKeys,
  assignTemplate,
  unassignTemplate,
  bindableKeys,
  BINDING_AUDIENCES,
  type TemplateBinding,
  type CatalogKeyRow,
} from '../api/templateBindings';
import { listTemplates, type TemplateSummary } from '../api/templates';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import './TemplateAssignments.css';

interface TemplateAssignmentsProps {
  /** Returns to the Template Bank list (this is a sibling view of Templates, not a route). */
  onClose: () => void;
}

/** The option text for one catalog key: the key, what it is, and its state. */
function keyOptionLabel(row: CatalogKeyRow): string {
  const tail = row.bound ? 'bound' : 'no binding, uses the catalog default';
  return `${row.key} · ${row.label} (${tail})`;
}

/**
 * Template ASSIGNMENT manager (AO-56), ported from `TemplateAssignmentScreen.kt`:
 * the surface Templates.tsx's own doc comment named as "a wholly separate
 * screen ... not this bank list at all". Binds a notification catalog key to an
 * email template so dispatch knows which template to send.
 *
 * Reads `listTemplateBindings` (the current bindings), `listTemplates` (the
 * bank, for the picker and for showing each binding's template TITLE, not just
 * its id), and `listCatalogKeys` (every key that can be bound). Writes via
 * `assignTemplate` (upsert a binding) and `unassignTemplate` (remove one).
 * Unassign is the half AO-56 was missing: without it a bound template can never
 * be deleted, because `deleteTemplate` refuses while a binding still points at it.
 *
 * The catalog key is picked, never typed (issues #382/#383). It was a free-text
 * box because `listCatalogKeys` returned only the keys already bound, so there
 * was no list to pick from; a misspelling wrote a binding that dispatch would
 * never read and reported success. The picker is the visible half of that fix;
 * the callable now refuses an unreal key outright, and this screen repeats its
 * words when it does.
 *
 * Fail-loud throughout: every write names its callable on rejection, buttons
 * disable while a call is in flight, and Unassign is confirm-gated (it changes
 * what real notifications dispatch sends).
 */
export function TemplateAssignments({ onClose }: TemplateAssignmentsProps) {
  const [bindings, setBindings] = useState<Async<TemplateBinding[]>>({ status: 'loading' });
  const [templates, setTemplates] = useState<Async<TemplateSummary[]>>({ status: 'loading' });
  const [catalog, setCatalog] = useState<Async<CatalogKeyRow[]>>({ status: 'loading' });

  // The assign/change form. `editingKey` null = assigning a brand-new key
  // (catalogKey pickable); non-null = changing an existing binding (locked).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [catalogKey, setCatalogKey] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [audience, setAudience] = useState('');
  const [saving, setSaving] = useState(false);

  const [pendingUnassign, setPendingUnassign] = useState<string | null>(null);
  const [unassigning, setUnassigning] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadBindings = useCallback(() => {
    let live = true;
    setBindings({ status: 'loading' });
    listTemplateBindings()
      .then((data) => live && setBindings({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setBindings({
            status: 'error',
            message: `listTemplateBindings failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: loadBindings,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  const loadTemplates = useCallback(() => {
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
            retry: loadTemplates,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  const loadCatalog = useCallback(() => {
    let live = true;
    setCatalog({ status: 'loading' });
    listCatalogKeys()
      .then((data) => live && setCatalog({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setCatalog({
            status: 'error',
            message: `listCatalogKeys failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: loadCatalog,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => loadBindings(), [loadBindings]);
  useEffect(() => loadTemplates(), [loadTemplates]);
  useEffect(() => loadCatalog(), [loadCatalog]);

  // templateId -> title, so a binding renders "Booking confirmed", not "tmpl_x".
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    if (templates.status === 'ready') {
      for (const t of templates.data) map.set(t.templateId, t.title || t.templateId);
    }
    return map;
  }, [templates]);

  const templateOptions = templates.status === 'ready' ? templates.data : [];
  const catalogRows = catalog.status === 'ready' ? catalog.data : [];
  // Only real keys are offered for a NEW binding. A legacy key still appears
  // when you open the binding that already uses it, so nothing goes invisible.
  const keyOptions = useMemo(() => bindableKeys(catalogRows), [catalogRows]);
  const editingRow = catalogRows.find((r) => r.key === editingKey) ?? null;
  const unboundCount = keyOptions.filter((r) => !r.bound).length;

  function resetForm() {
    setEditingKey(null);
    setCatalogKey('');
    setTemplateId('');
    setAudience('');
  }

  function startChange(binding: TemplateBinding) {
    setActionError(null);
    setNotice(null);
    setEditingKey(binding.catalogKey);
    setCatalogKey(binding.catalogKey);
    setTemplateId(binding.templateId);
    // Re-send the current audience so a re-assign doesn't null it (assignTemplate
    // merges `audience ?? null`); '' means the binding had none.
    setAudience(binding.audience ?? '');
  }

  const canAssign = catalogKey !== '' && templateId !== '' && !saving;

  async function handleAssign() {
    if (!canAssign) return;
    setSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      await assignTemplate({
        catalogKey,
        templateId,
        ...(audience !== '' && { audience }),
      });
      setSaving(false);
      setNotice(`Assigned ${titleById.get(templateId) ?? templateId} to ${catalogKey}.`);
      resetForm();
      loadBindings();
      // The catalog rows carry bound/resolves-to state, which this write changed.
      loadCatalog();
    } catch (err) {
      setSaving(false);
      // assignTemplate rejects an unreal catalog key with invalid-argument and a
      // sentence that names it. Show that sentence rather than burying it behind
      // a generic failure line: it is the one message that tells the operator
      // what to do next.
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : 'Assign failed';
      setActionError(
        code === 'functions/invalid-argument'
          ? `assignTemplate refused this catalog key: ${message}`
          : `assignTemplate failed: ${message}`,
      );
    }
  }

  async function confirmUnassign(key: string) {
    if (unassigning) return;
    setUnassigning(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await unassignTemplate(key);
      setUnassigning(false);
      setPendingUnassign(null);
      setNotice(res.removed ? `Unassigned ${key}.` : `${key} was already unassigned.`);
      // If the form was editing the key just removed, drop back to a blank assign.
      if (editingKey === key) resetForm();
      loadBindings();
      loadCatalog();
    } catch (err) {
      setUnassigning(false);
      setActionError(`unassignTemplate failed: ${err instanceof Error ? err.message : 'Unassign failed'}`);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Template"
        accentTail="Assignments"
        subtitle="Bind a notification catalog key to the email template dispatch sends for it."
        trailing={<GhostButton label="Back to Template Bank" onClick={onClose} />}
      />

      {notice && (
        <Banner tone="success" title="Done" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}
      {actionError && (
        <Banner tone="error" title="Action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Banner>
      )}

      <DenPanel
        title={editingKey ? `Change binding: ${editingKey}` : 'Assign a template'}
        subtitle={
          editingKey
            ? 'Pick the template this catalog key should dispatch.'
            : 'Pick the catalog key, then the template dispatch should send for it.'
        }
      >
        {templates.status === 'error' && (
          <p className="tassign__templates-error" role="alert">
            Template list unavailable, so the picker is empty: {templates.message}
          </p>
        )}
        {catalog.status === 'error' && (
          <p className="tassign__templates-error" role="alert">
            Catalog keys unavailable, so there is nothing to pick from: {catalog.message}
          </p>
        )}
        <div className="tassign__form">
          <label className="tassign__field">
            <span className="tassign__label">Catalog key</span>
            <select
              className="tassign__input"
              value={catalogKey}
              onChange={(e) => setCatalogKey(e.target.value)}
              disabled={editingKey !== null || saving}
            >
              <option value="">Choose a catalog key…</option>
              {/* The key being edited may predate the catalog. Keep it visible
                  rather than showing a blank picker over a real binding. */}
              {editingKey !== null && editingRow === null && (
                <option value={editingKey}>{editingKey} (not in the catalog)</option>
              )}
              {editingRow !== null && editingRow.source === 'legacy' && (
                <option value={editingRow.key}>{editingRow.key} (not in the catalog)</option>
              )}
              {keyOptions.map((row) => (
                <option key={row.key} value={row.key}>
                  {keyOptionLabel(row)}
                </option>
              ))}
            </select>
          </label>

          <label className="tassign__field">
            <span className="tassign__label">Template</span>
            <select
              className="tassign__input"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={saving}
            >
              <option value="">Choose a template…</option>
              {/* Preserve a stored templateId that is no longer in the bank rather
                  than silently dropping it from the select. */}
              {templateId !== '' && !titleById.has(templateId) && (
                <option value={templateId}>{templateId} (missing from bank)</option>
              )}
              {templateOptions.map((t) => (
                <option key={t.templateId} value={t.templateId}>
                  {t.title || t.templateId}
                </option>
              ))}
            </select>
          </label>

          <label className="tassign__field">
            <span className="tassign__label">Audience (optional)</span>
            <select
              className="tassign__input"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              disabled={saving}
            >
              <option value="">(none)</option>
              {BINDING_AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <div className="tassign__form-actions">
            {editingKey && <GhostButton label="Cancel" onClick={resetForm} disabled={saving} />}
            <PrimaryButton
              label={saving ? 'Assigning…' : editingKey ? 'Update binding' : 'Assign'}
              onClick={() => void handleAssign()}
              disabled={!canAssign}
              busy={saving}
            />
          </div>
        </div>
        {catalog.status === 'ready' && (
          <p className="tassign__hint">
            {keyOptions.length} catalog keys, {unboundCount} with no binding yet. An unbound key
            still sends: dispatch falls back to the template named after the key.
          </p>
        )}
      </DenPanel>

      <DenPanel title="Current bindings" subtitle="Every catalog key that dispatch currently maps to a template.">
        <AsyncRegion
          state={bindings}
          what="bindings"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="tassign__hint">Loading bindings…</p>}
          empty={<EmptyHint>No catalog keys are bound yet. Assign one above.</EmptyHint>}
        >
          {(rows) => (
            <ul className="tassign__list">
              {rows.map((b) => (
                <li key={b.catalogKey} className="tassign__row">
                  <div className="tassign__row-main">
                    <code className="tassign__row-key">{b.catalogKey}</code>
                    <span className="tassign__row-template">
                      {titleById.get(b.templateId) ?? b.templateId ?? '(no template)'}
                    </span>
                    <span className="tassign__row-meta">
                      {b.audience ? `audience: ${b.audience}` : 'no audience'}
                      {' · '}
                      <span
                        className={
                          b.active ? 'tassign__badge tassign__badge--on' : 'tassign__badge tassign__badge--off'
                        }
                      >
                        {b.active ? 'active' : 'inactive'}
                      </span>
                    </span>
                  </div>

                  {pendingUnassign === b.catalogKey ? (
                    <div className="tassign__confirm">
                      <span className="tassign__confirm-copy">Unassign this key?</span>
                      <GhostButton
                        label="Cancel"
                        onClick={() => setPendingUnassign(null)}
                        disabled={unassigning}
                      />
                      <PrimaryButton
                        label={unassigning ? 'Unassigning…' : 'Unassign'}
                        onClick={() => void confirmUnassign(b.catalogKey)}
                        disabled={unassigning}
                        busy={unassigning}
                      />
                    </div>
                  ) : (
                    <div className="tassign__row-actions">
                      <GhostButton label="Change" onClick={() => startChange(b)} />
                      <GhostButton
                        label="Unassign"
                        onClick={() => {
                          setActionError(null);
                          setNotice(null);
                          setPendingUnassign(b.catalogKey);
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}
