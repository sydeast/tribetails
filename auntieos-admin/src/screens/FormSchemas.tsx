import { useCallback, useEffect, useState } from 'react';
import {
  listFormSchemas,
  deleteFormSchema,
  type FormSchemaSummary,
} from '../api/formSchemas';
import { type Async } from '../lib/async';
import { formSchemaUpdatedLabel } from '../lib/formSchemaFormat';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import './FormSchemas.css';

/**
 * Descending by updatedAt, blanks/nulls last, mirrors FormSchemaListScreen.kt's
 * default sort (`compareBy<isBlank>.thenByDescending`), which is the only sort
 * order the wasm screen actually ships: its column-header sort UI (HeaderCell)
 * was retired when the sortable table became a card list (see the #10/#17
 * comment in the Kotlin source) but the sortCol/sortAsc state, defaulted to
 * UpdatedAt/desc, was never removed, so this fixed order IS the shipped
 * behavior, not a simplification of it.
 *
 * COMPARING THE RAW STRING IS CORRECT HERE, and that is a checked claim rather
 * than an assumption, because the sibling defect in PR #241 was exactly this
 * shape: `invoices.date` / `payments.date` hold free text ("February 17,
 * 2026"), so a byte compare ordered them alphabetically by month name. This
 * field is not that. `formSchemas.updatedAt` is written ONLY by the
 * `saveFormSchema` callable as `FieldValue.serverTimestamp()`
 * (mytribe/functions/src/admin/saveFormSchema.ts:214) and is handed to this
 * client only after `listFormSchemas`'s `toIsoOrNull` has run
 * `.toDate().toISOString()` over it (listFormSchemas.ts:69), so every non-null
 * value is a fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ` UTC instant, for which
 * lexicographic order and chronological order are the same order. See
 * `lib/formSchemaFormat.ts` for the full write-path audit, including why the
 * `isAuntie()` direct-write grant in firestore.rules:770 does not put free
 * text in this field in practice.
 */
export function sortByUpdatedAtDesc(rows: FormSchemaSummary[]): FormSchemaSummary[] {
  return [...rows].sort((a, b) => {
    const aBlank = !a.updatedAt;
    const bBlank = !b.updatedAt;
    if (aBlank && bBlank) return 0;
    if (aBlank !== bBlank) return aBlank ? 1 : -1;
    return (b.updatedAt as string).localeCompare(a.updatedAt as string);
  });
}

/** Client-side filter by name or id, case-insensitive. Mirrors AuntieSearchField's use in the reference. */
export function filterSchemas(rows: FormSchemaSummary[], query: string): FormSchemaSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
  );
}

/**
 * The non-blank parts of a row's meta line, joined the way the reference
 * renders them: `v4  ·  08-02 10:15  ·  by e2e-admin`.
 *
 * The middle part is `formSchemaUpdatedLabel`, NOT `row.updatedAt`. This line
 * used to interpolate the raw field, so the operator read
 * `2026-08-02T10:15:00.000Z` off the row, in UTC, milliseconds and all. It went
 * unnoticed because the screen's golden photographed a failed-callable error
 * panel until PR #251 put real rows in the picture.
 *
 * `formSchemaUpdatedLabel` never returns blank, so unlike the version and
 * `updatedBy` parts the timestamp part is never dropped: a schema with no
 * `updatedAt` says `date unknown` out loud rather than leaving a gap the
 * operator has to interpret.
 */
export function metaLine(row: FormSchemaSummary): string {
  return [
    `v${row.version}`,
    formSchemaUpdatedLabel(row.updatedAt),
    row.updatedBy ? `by ${row.updatedBy}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('  ·  ');
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}

interface FormSchemasProps {
  /** Opens the editor screen (`FormSchemaEditor.tsx`) wired by `routes/FormSchemasView.tsx`. Called with a schema id on row-select. */
  onSelect?: (id: string) => void;
  /** Opens the editor screen (`FormSchemaEditor.tsx`) in create-new mode. Called with no arguments to start a new schema. */
  onNew?: () => void;
}

/**
 * Admin Form Schemas list. Loads once via the one-shot listFormSchemas callable
 * (not a stream, formSchemas has no live-authoring collaborator to watch for),
 * matching the wasm FormSchemaListScreen, which the review named the GOLD
 * STANDARD for fail-loud error handling in the admin: it names the failing
 * callable, offers Retry, and refuses to render a false empty list while the
 * load is failing. AsyncRegion is that behavior expressed as a shared component;
 * this screen prefixes its error message with the callable name to match the
 * reference's "listFormSchemas failed: $msg" / "deleteFormSchema failed: $msg"
 * wording, since AsyncRegion itself does not know which callable is loading.
 *
 * This component renders the list. The editor screen (`FormSchemaEditor.tsx`)
 * is mounted in a modal by the router (`routes/FormSchemasView.tsx`), which
 * wires the `onSelect` and `onNew` handlers. See the props doc above.
 */
export function FormSchemas({ onSelect, onNew }: FormSchemasProps) {
  const [schemas, setSchemas] = useState<Async<FormSchemaSummary[]>>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<FormSchemaSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Hoisted so a failed load can hand AsyncRegion a real retry, same shape as
  // FeatureFlags.tsx's load().
  const load = useCallback(() => {
    let live = true;
    setSchemas({ status: 'loading' });
    listFormSchemas()
      .then((data) => live && setSchemas({ status: 'ready', data: sortByUpdatedAtDesc(data) }))
      .catch(
        (err: unknown) =>
          live &&
          setSchemas({
            status: 'error',
            message: `listFormSchemas failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Escape cancels the delete confirm, same as clicking Cancel, but never while
  // a delete is actually in flight (mirrors the reference's onDismiss guard).
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) setPendingDelete(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete, deleting]);

  // Deletes via deleteFormSchema, then reloads (matches confirmDelete() in the
  // reference: it reloads on success rather than optimistically splicing the
  // row, so a schema that reappears server-side, a stale delete, a race, 
  // does not silently vanish from the operator's view). A failure surfaces
  // through the SAME error state the initial load uses, which is why
  // AsyncRegion's "unavailable while the load is failing" message applies here
  // too: the reference does the same thing (a delete failure replaces the list
  // panel with the same loadError banner a load failure would show).
  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      await deleteFormSchema(target.id);
      setDeleting(false);
      setPendingDelete(null);
      load();
    } catch (err) {
      setDeleting(false);
      setPendingDelete(null);
      setSchemas({
        status: 'error',
        message: `deleteFormSchema failed: ${err instanceof Error ? err.message : 'Delete failed'}`,
        retry: load,
      });
    }
  }

  const shownCount = schemas.status === 'ready' ? filterSchemas(schemas.data, query).length : 0;
  const countLabel = shownCount > 0 ? `${shownCount} schemas` : null; // hide the chip on empty (wasm parity)

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Form"
        accentTail="Schemas"
        subtitle="Author the dynamic forms kinfolk fill out."
        trailing={
          <PrimaryButton label="New schema" {...(onNew ? { onClick: () => onNew() } : {})} leading={<PlusGlyph />} />
        }
      />

      <DenPanel
        title="All schemas"
        subtitle="Click a row to open it in the editor. The editor owns create, edit, save, and delete."
        {...(countLabel ? { trailing: <span className="schemas__count">{countLabel}</span> } : {})}
      >
        <AsyncRegion
          state={schemas}
          what="schemas"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="schemas__hint">Loading schemas…</p>}
          empty={<p className="schemas__hint">No schemas yet. Click New schema to create one.</p>}
        >
          {(rows) => {
            const visible = filterSchemas(rows, query);
            return (
              <>
                <div className="schemas__search">
                  <input
                    type="search"
                    className="schemas__search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter schemas by name or id…"
                    aria-label="Filter schemas by name or id"
                  />
                </div>

                {visible.length === 0 ? (
                  <p className="schemas__hint">No schemas match &ldquo;{query}&rdquo;.</p>
                ) : (
                  <ul className="schemas__list">
                    {visible.map((row) => {
                      const rowBody = (
                        <>
                          <span className="schemas__row-name">{row.name || row.id}</span>
                          <code className="schemas__row-id">{row.id}</code>
                          <span className="schemas__row-meta">{metaLine(row)}</span>
                        </>
                      );
                      // Static <div> when unwired: a handler-less <button> still
                      // carries the implicit button role and is a focusable dead
                      // control. Real <button> only once onSelect wires it.
                      return (
                      <li key={row.id} className="schemas__row">
                        {onSelect ? (
                          <button type="button" className="schemas__row-main" onClick={() => onSelect(row.id)}>
                            {rowBody}
                          </button>
                        ) : (
                          <div className="schemas__row-main schemas__row-main--static">{rowBody}</div>
                        )}
                        <IconButton
                          icon={<TrashGlyph />}
                          label={`Delete ${row.name || row.id}`}
                          onClick={() => setPendingDelete(row)}
                          destructive
                          revealOnHover
                          size={32}
                        />
                      </li>
                      );
                    })}
                  </ul>
                )}

                <GhostButton label="Reload" onClick={load} className="schemas__reload" />
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {pendingDelete && (
        <Dialog
          title="Delete this form schema?"
          onClose={() => {
            if (!deleting) setPendingDelete(null);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setPendingDelete(null)} disabled={deleting} />
              <PrimaryButton
                label={deleting ? 'Deleting…' : 'Delete schema'}
                onClick={() => void confirmDelete()}
                disabled={deleting}
                busy={deleting}
                leading={<TrashGlyph />}
              />
            </>
          }
        >
          <p className="schemas__dialog-hint">
            {pendingDelete.name || pendingDelete.id} (v{pendingDelete.version}). This cannot be undone.
          </p>
          <code className="schemas__dialog-id">Schema id: {pendingDelete.id}</code>
        </Dialog>
      )}
    </div>
  );
}
