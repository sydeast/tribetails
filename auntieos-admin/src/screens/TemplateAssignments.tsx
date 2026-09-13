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
import { LoadingRow } from '../components/LoadingRow';
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
 * Whether a binding is actually steering this key right now.
 *
 * Read off the server's own answer rather than recomputed here: `resolveTemplateId`
 * falls back to the default when a binding is missing OR inactive, and
 * `resolvedTemplateId` already reflects that. Comparing it with `defaultTemplateId`
 * is the whole test, and it keeps the resolution rule in one place, on the server.
 */
function isOverridden(row: CatalogKeyRow): boolean {
  return row.resolvedTemplateId !== row.defaultTemplateId;
}

/** Where the template this key sends came from, in words. */
function routingSource(row: CatalogKeyRow): string {
  if (isOverridden(row)) return 'override, assigned by an admin';
  if (row.bound) return 'binding is paused, so the name-matched default applies';
  return 'default, matched by name';
}

/**
 * Template ASSIGNMENT manager (AO-56), ported from `TemplateAssignmentScreen.kt`:
 * the surface Templates.tsx's own doc comment named as "a wholly separate
 * screen ... not this bank list at all".
 *
 * WHAT THIS SCREEN IS ACTUALLY SHOWING, because the old version got it wrong in a
 * way that was technically true (issue #384). It used to list the
 * `notificationTemplateBindings` collection under the heading "Current bindings",
 * and on the 2026-08-17 walk that collection was empty, so the screen said the
 * business had no template routing at all. The operator knew better: "current
 * bindings being empty is false as some templates are already being sent out."
 *
 * They were right, and the callable was too. Routing happens by NAME.
 * `lib/sendFromTemplate.ts` looks for `notificationTemplateBindings/{catalogKey}`
 * and, finding nothing, falls through to `emailTemplates/{catalogKey}`. All 44
 * catalog rows have `templates.email === key`, so every send today takes that
 * fallback. Bindings are an OVERRIDE layer on top of a system that already works,
 * and an empty override layer is not an empty routing table.
 *
 * So the second panel is the routing table, not the collection: every catalog key,
 * the template that renders it right now, and which of the two put it there. A key
 * whose default template document does not exist is called out loudly, because
 * that key throws `email template missing` on its next send.
 *
 * Two limits the screen states rather than implies:
 *  - An override applies to EMAIL only. `senders/smsChannel.ts` and
 *    `senders/pushChannel.ts` read the template ids frozen in the catalog and never
 *    call `resolveTemplateId`.
 *  - The binding's `audience` field is written and read back, and no sender consults
 *    it. The control is kept because the stored value is the operator's, but it is
 *    labelled for what it is.
 *
 * Reads `listCatalogKeys` (the routing table), `listTemplateBindings` (the override
 * layer, for the editor's audience/trigger/active state) and `listTemplates` (the
 * bank, for titles). Writes via `assignTemplate` and `unassignTemplate`.
 *
 * The catalog key is picked, never typed (issues #382/#383): a misspelling used to
 * write a binding dispatch would never read and report success.
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

  // templateId -> title, so a row renders "Booking confirmed", not "tmpl_x".
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    if (templates.status === 'ready') {
      for (const t of templates.data) map.set(t.templateId, t.title || t.templateId);
    }
    return map;
  }, [templates]);

  const bindingByKey = useMemo(() => {
    const map = new Map<string, TemplateBinding>();
    if (bindings.status === 'ready') {
      for (const b of bindings.data) map.set(b.catalogKey, b);
    }
    return map;
  }, [bindings]);

  const templateOptions = templates.status === 'ready' ? templates.data : [];
  const catalogRows = catalog.status === 'ready' ? catalog.data : [];
  // Only real keys are offered for a NEW binding. A legacy key still appears
  // when you open the binding that already uses it, so nothing goes invisible.
  const keyOptions = useMemo(() => bindableKeys(catalogRows), [catalogRows]);
  const editingRow = catalogRows.find((r) => r.key === editingKey) ?? null;
  const overrideCount = catalogRows.filter(isOverridden).length;

  /**
   * Whether the template this key resolves to is actually missing.
   *
   * For a name-matched default the server already checked (`hasDefaultTemplate`).
   * For an override the check is against the loaded bank, so it is only made when
   * the bank loaded: an unavailable `listTemplates` must not paint every override
   * as broken.
   */
  function resolvedTemplateMissing(row: CatalogKeyRow): boolean {
    if (!isOverridden(row)) return !row.hasDefaultTemplate;
    return templates.status === 'ready' && !titleById.has(row.resolvedTemplateId);
  }

  const brokenCount = catalogRows.filter(resolvedTemplateMissing).length;

  function resetForm() {
    setEditingKey(null);
    setCatalogKey('');
    setTemplateId('');
    setAudience('');
  }

  /**
   * Open the editor on one catalog key. An unbound key has no binding doc yet, so
   * the form opens seeded with the template it resolves to today: saving then
   * writes the first override for that key rather than starting from blank.
   */
  function startChange(row: CatalogKeyRow) {
    setActionError(null);
    setNotice(null);
    const existing = bindingByKey.get(row.key);
    setEditingKey(row.key);
    setCatalogKey(row.key);
    setTemplateId(existing?.templateId ?? row.resolvedTemplateId);
    // Re-send the current audience so a re-assign doesn't null it (assignTemplate
    // merges `audience ?? null`); '' means the binding had none.
    setAudience(existing?.audience ?? '');
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
      setNotice(
        res.removed
          ? `Removed the override on ${key}. It goes back to the template named after the key.`
          : `${key} had no override to remove.`,
      );
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
        accentTail="Routing"
        subtitle="Every catalog key already sends a template. A binding is an override on top of that."
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
        title={editingKey ? `Override: ${editingKey}` : 'Override a catalog key'}
        subtitle={
          editingKey
            ? 'Pick the template this catalog key should send instead of its name-matched default.'
            : 'Pick a catalog key, then the template it should send instead of its name-matched default.'
        }
      >
        {templates.status === 'error' && (
          <p className="tassign__templates-error" role="alert">
            Template list unavailable, so the picker is empty: {templates.message}
          </p>
        )}
        {/* The routing table below owns this failure's message and its retry, so
            this says only what it costs HERE and does not repeat the detail. */}
        {catalog.status === 'error' && (
          <p className="tassign__templates-error" role="alert">
            Catalog keys did not load, so there is nothing to pick from. The routing table below
            carries the error and a retry.
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
            <span className="tassign__label">Audience (stored, unused)</span>
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
              label={saving ? 'Saving…' : editingKey ? 'Save override' : 'Save'}
              onClick={() => void handleAssign()}
              disabled={!canAssign}
              busy={saving}
            />
          </div>
        </div>
        <p className="tassign__hint">
          An override changes the EMAIL template only. SMS and push read the template ids frozen
          in the catalog and never look at a binding. Audience is written to the binding and no
          sender reads it, so it records intent and changes nothing.
        </p>
      </DenPanel>

      <DenPanel
        title="What each key sends today"
        subtitle="Every catalog key, the template that renders it right now, and where that choice came from."
      >
        {/* The table itself comes from listCatalogKeys, so a bindings failure does
            not make it wrong. It does cost the audience line and the editor's
            starting state, and staying quiet about that would be the same kind of
            true-but-misleading this screen exists to stop. */}
        {bindings.status === 'error' && (
          <p className="tassign__templates-error" role="alert">
            {bindings.message}. Each key's resolved template below is still correct, but the
            audience recorded on an override is not shown and the editor opens without it.
          </p>
        )}
        <AsyncRegion
          state={catalog}
          what="the routing table"
          isEmpty={(rows) => rows.length === 0}
          loading={<LoadingRow label="Loading the routing table…" className="tassign__hint" />}
          empty={
            <EmptyHint>
              listCatalogKeys returned no keys. The catalog is compiled into the backend, so this
              should not be possible; treat it as a broken deploy rather than an empty setup.
            </EmptyHint>
          }
        >
          {(rows) => (
            <>
              <p className="tassign__hint">
                {rows.length} keys route today. {overrideCount} of them through an override, the
                rest by name.
                {brokenCount > 0 &&
                  ` ${brokenCount === 1 ? '1 key resolves' : `${brokenCount} keys resolve`} to a template document that does not exist and will throw on the next send.`}
              </p>
              <ul className="tassign__list">
                {rows.map((row) => {
                  const binding = bindingByKey.get(row.key);
                  const missing = resolvedTemplateMissing(row);
                  return (
                    <li key={row.key} className="tassign__row">
                      <div className="tassign__row-main">
                        <code className="tassign__row-key">{row.key}</code>
                        <span className="tassign__row-template">
                          sends {titleById.get(row.resolvedTemplateId) ?? row.resolvedTemplateId}
                        </span>
                        <span className="tassign__row-meta">
                          <span
                            className={
                              isOverridden(row)
                                ? 'tassign__badge tassign__badge--on'
                                : 'tassign__badge tassign__badge--off'
                            }
                          >
                            {routingSource(row)}
                          </span>
                          {binding?.audience ? ` · audience: ${binding.audience}` : ''}
                        </span>
                        {missing && (
                          <span className="tassign__row-broken" role="alert">
                            No emailTemplates/{row.resolvedTemplateId} document. This key throws
                            "email template missing" on its next send.
                          </span>
                        )}
                      </div>

                      {pendingUnassign === row.key ? (
                        <div className="tassign__confirm">
                          <span className="tassign__confirm-copy">
                            Drop this override and go back to the name-matched default?
                          </span>
                          <GhostButton
                            label="Cancel"
                            onClick={() => setPendingUnassign(null)}
                            disabled={unassigning}
                          />
                          <PrimaryButton
                            label={unassigning ? 'Removing…' : 'Remove override'}
                            onClick={() => void confirmUnassign(row.key)}
                            disabled={unassigning}
                            busy={unassigning}
                          />
                        </div>
                      ) : (
                        <div className="tassign__row-actions">
                          <GhostButton
                            label={row.bound ? 'Change override' : 'Override'}
                            onClick={() => startChange(row)}
                          />
                          {/* Only a key with a binding doc has anything to remove. */}
                          {row.bound && (
                            <GhostButton
                              label="Remove override"
                              onClick={() => {
                                setActionError(null);
                                setNotice(null);
                                setPendingUnassign(row.key);
                              }}
                            />
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}
