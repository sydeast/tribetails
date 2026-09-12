import { useCallback, useEffect, useState } from 'react';
import {
  listFormSchemas,
  deleteFormSchema,
  type FormSchemaSummary,
} from '../api/formSchemas';
import { listBusinessAdmins } from '../api/businessAdmins';
import { type Async } from '../lib/async';
import { formSchemaUpdatedFull } from '../lib/formSchemaFormat';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { IconTile } from '../components/IconTile';
import { BRAND_GRADIENTS } from '../components/Avatar';
import './FormSchemas.css';

export type SortColumn = 'name' | 'version' | 'updatedAt' | 'updatedBy';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

/** The mock's shipped default: Updated, descending. */
export const DEFAULT_SORT: SortState = { column: 'updatedAt', direction: 'desc' };

/**
 * A value that reads as a Firebase Auth uid, long and opaque, rather than a
 * human label such as a seed script name ("seed_phase14_schemas"). Only used
 * to decide whether an UNRESOLVED `updatedBy` is worth shortening; shortening
 * a value that was already a readable label would make it harder to read, not
 * easier.
 */
function looksLikeUid(value: string): boolean {
  return /^[A-Za-z0-9]{16,}$/.test(value);
}

/**
 * What the Updated by column shows for one row's raw `updatedBy`.
 *
 * `emailByUid` comes from `listBusinessAdmins` (`api/businessAdmins.ts`), the
 * one cheap admin-roster lookup this admin already has (built for the
 * notification gate, issue #450). A uid the roster knows resolves to that
 * admin's email, matching the mock's "auntie@tribetails.example" column.
 *
 * A uid the roster does NOT know, such as a seed script's author string, is
 * not necessarily wrong, staff turns over and seed data predates the roster,
 * so it is shown rather than hidden: shortened when it looks like a uid
 * (nobody scans a 28-character random string), verbatim otherwise. Returns
 * `null` for a blank `updatedBy`, so the caller can render the shared blank
 * placeholder ("-") and sort the row last.
 */
export function resolveUpdatedBy(
  updatedBy: string | null,
  emailByUid: ReadonlyMap<string, string>,
): string | null {
  const trimmed = (updatedBy ?? '').trim();
  if (trimmed === '') return null;
  const email = emailByUid.get(trimmed);
  if (email) return email;
  return looksLikeUid(trimmed) ? `${trimmed.slice(0, 8)}…` : trimmed;
}

/**
 * Orders rows for one of the table's four sortable columns, blanks last in
 * BOTH directions (an ascending sort still puts the row with nothing to show
 * at the bottom, never at the top where "-" would read as the smallest
 * value), a deterministic `id` tie-break so equal rows never reorder between
 * renders, mirrors the Android sibling's `formSchemaSort` (same column enum,
 * same blank-last rule, same default).
 *
 * `updatedAt` compares the raw ISO string rather than a formatted label: see
 * `lib/formSchemaFormat.ts` for the full write-path audit establishing that,
 * for this field, byte order over the stored instant IS chronological order.
 * `updatedBy` compares the DISPLAYED label (an admin's resolved email, or the
 * raw/shortened uid), not the raw uid, so the on-screen order matches what
 * the operator is looking at.
 */
export function sortSchemas(
  rows: readonly FormSchemaSummary[],
  emailByUid: ReadonlyMap<string, string>,
  sort: SortState,
): FormSchemaSummary[] {
  const dir = sort.direction === 'asc' ? 1 : -1;

  // Non-null only when blank-ness differs; the tie-break falls through
  // otherwise. Blank always sorts after non-blank, regardless of direction,
  // so this result is NOT multiplied by `dir`.
  function blankLast(aBlank: boolean, bBlank: boolean): number | null {
    if (aBlank === bBlank) return null;
    return aBlank ? 1 : -1;
  }

  return [...rows].sort((a, b): number => {
    switch (sort.column) {
      case 'name': {
        const an = (a.name || a.id).toLowerCase();
        const bn = (b.name || b.id).toLowerCase();
        return (an.localeCompare(bn) || a.id.localeCompare(b.id)) * dir;
      }
      case 'version':
        return (a.version - b.version || a.id.localeCompare(b.id)) * dir;
      case 'updatedAt': {
        const aBlank = !a.updatedAt;
        const bBlank = !b.updatedAt;
        const blank = blankLast(aBlank, bBlank);
        if (blank !== null) return blank;
        return (
          ((a.updatedAt as string).localeCompare(b.updatedAt as string) ||
            a.id.localeCompare(b.id)) * dir
        );
      }
      case 'updatedBy': {
        const aLabel = resolveUpdatedBy(a.updatedBy, emailByUid);
        const bLabel = resolveUpdatedBy(b.updatedBy, emailByUid);
        const blank = blankLast(aLabel === null, bLabel === null);
        if (blank !== null) return blank;
        return (
          ((aLabel as string).toLowerCase().localeCompare((bLabel as string).toLowerCase()) ||
            a.id.localeCompare(b.id)) * dir
        );
      }
    }
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

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * The mock's `.hicon` glyph (Lucide ClipboardList), drawn here rather than
 * borrowed from `NavGlyphs`: the rail glyph carries `.nav-glyph`, whose own
 * colour rule would paint it dim inside the tile where the mock wants cream.
 */
function ClipboardGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4M12 16h4M8 11h.01M8 16h.01" />
    </svg>
  );
}
function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
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

function CaretGlyph() {
  return (
    <svg
      className="schemas__caret"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const COLUMN_LABEL: Record<SortColumn, string> = {
  name: 'Name',
  version: 'Version',
  updatedAt: 'Updated',
  updatedBy: 'Updated by',
};

interface SortHeaderProps {
  column: SortColumn;
  sort: SortState;
  onSort: (column: SortColumn) => void;
}

/**
 * One `<th>` of the sortable table, mirroring the mock's header cell: a
 * clickable label with a caret, the active column tinted, the caret flipped
 * when that column is ascending. Clicking the active column flips its
 * direction; clicking a different column selects it, ascending, the same
 * click semantics the mock's script comments describe.
 */
function SortHeader({ column, sort, onSort }: SortHeaderProps) {
  const active = sort.column === column;
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? sort.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return (
    <th scope="col" className={`schemas__th schemas__th--${column}`} aria-sort={ariaSort}>
      <button
        type="button"
        className="schemas__sort"
        {...(active ? { 'data-active': '', 'data-direction': sort.direction } : {})}
        onClick={() => onSort(column)}
      >
        {COLUMN_LABEL[column]}
        <CaretGlyph />
      </button>
    </th>
  );
}

interface FormSchemasProps {
  /** Opens the editor screen (`FormSchemaEditor.tsx`) wired by `routes/FormSchemasView.tsx`. Called with a schema id on row-select. */
  onSelect?: (id: string) => void;
  /** Opens the editor screen (`FormSchemaEditor.tsx`) in create-new mode. Called with no arguments to start a new schema. */
  onNew?: () => void;
}

/**
 * Admin Form Schemas list: the sortable four-column table (Name / Version /
 * Updated / Updated by) drawn in `ui-ideas/auntieos-formschema-list-2026-05-27.html`
 * and named as the intended shape in `docs/2026-05-31-den-redesign-design.md`
 * ("Form Schemas is NOT a card grid, deliberately"). Both design authorities
 * name a table because the four fields are a fixed, uniform, comparative set,
 * which a single flattened meta line cannot be sorted or scanned by.
 *
 * Loads once via the one-shot `listFormSchemas` callable (not a stream,
 * formSchemas has no live-authoring collaborator to watch for), matching the
 * wasm `FormSchemaListScreen`, which the 2026-07-15 review named the gold
 * standard for fail-loud error handling in the admin: it names the failing
 * callable, offers Retry, and refuses to render a false empty list while the
 * load is failing. `AsyncRegion` is that behavior expressed as a shared
 * component; this screen prefixes its error message with the callable name to
 * match the reference's "listFormSchemas failed: $msg" /
 * "deleteFormSchema failed: $msg" wording, since `AsyncRegion` itself does not
 * know which callable is loading.
 *
 * `listBusinessAdmins` resolves each row's `updatedBy` uid to an admin's email
 * (see `resolveUpdatedBy`). That roster load is independent of the schemas
 * load: a roster failure never blocks or empties the schemas list, it only
 * leaves `updatedBy` showing the raw/shortened uid.
 *
 * This component renders the list. The editor screen (`FormSchemaEditor.tsx`)
 * is mounted in a modal by the router (`routes/FormSchemasView.tsx`), which
 * wires the `onSelect` and `onNew` handlers. See the props doc above.
 */
export function FormSchemas({ onSelect, onNew }: FormSchemasProps) {
  const [schemas, setSchemas] = useState<Async<FormSchemaSummary[]>>({ status: 'loading' });
  const [emailByUid, setEmailByUid] = useState<ReadonlyMap<string, string>>(new Map());
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<FormSchemaSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Hoisted so a failed load can hand AsyncRegion a real retry, same shape as
  // FeatureFlags.tsx's load().
  const load = useCallback(() => {
    let live = true;
    setSchemas({ status: 'loading' });
    listFormSchemas()
      .then((data) => live && setSchemas({ status: 'ready', data }))
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

  // Independent of the schemas load: a roster it cannot fetch leaves
  // `updatedBy` showing the raw/shortened uid rather than costing the
  // operator the schemas list. Never chained into `load()`.
  useEffect(() => {
    let live = true;
    listBusinessAdmins()
      .then((roster) => {
        if (!live) return;
        const map = new Map<string, string>();
        for (const member of roster.members) {
          if (member.email) map.set(member.uid, member.email);
        }
        setEmailByUid(map);
      })
      .catch(() => {
        // Swallowed on purpose: see the function doc above.
      });
    return () => {
      live = false;
    };
  }, []);

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

  function handleSort(column: SortColumn) {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
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
        // The mock's `.hicon`: a 46px tile on the teal-to-purple brand
        // gradient with the clipboard glyph in cream. Decorative, so the
        // tile carries no label of its own.
        leading={<IconTile icon={<ClipboardGlyph />} size={46} background={BRAND_GRADIENTS[1]} />}
        trailing={
          <PrimaryButton label="New schema" {...(onNew ? { onClick: () => onNew() } : {})} leading={<PlusGlyph />} />
        }
      />

      <AsyncRegion
        state={schemas}
        what="schemas"
        isEmpty={(rows) => rows.length === 0}
        loading={<p className="schemas__state">Loading schemas…</p>}
        empty={<p className="schemas__state">No schemas yet. Click New schema to create one.</p>}
      >
        {(rows) => {
          const visible = filterSchemas(rows, query);
          const sorted = sortSchemas(visible, emailByUid, sort);
          return (
            <>
              <div className="schemas__controls">
                <label className="schemas__search">
                  <SearchGlyph />
                  <input
                    type="search"
                    className="schemas__search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter schemas by name or id…"
                    aria-label="Filter schemas by name or id"
                  />
                </label>
                {countLabel && <span className="schemas__count">{countLabel}</span>}
              </div>

              {sorted.length === 0 ? (
                <p className="schemas__state">No schemas match &ldquo;{query}&rdquo;.</p>
              ) : (
                <div className="schemas__table-wrap">
                  <table className="schemas__table">
                    <colgroup>
                      <col className="schemas__col-name" />
                      <col className="schemas__col-version" />
                      <col className="schemas__col-updated" />
                      <col className="schemas__col-by" />
                      <col className="schemas__col-actions" />
                    </colgroup>
                    <thead>
                      <tr>
                        <SortHeader column="name" sort={sort} onSort={handleSort} />
                        <SortHeader column="version" sort={sort} onSort={handleSort} />
                        <SortHeader column="updatedAt" sort={sort} onSort={handleSort} />
                        <SortHeader column="updatedBy" sort={sort} onSort={handleSort} />
                        <th scope="col" className="schemas__th schemas__th--actions" aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((row) => {
                        const updatedFull = formSchemaUpdatedFull(row.updatedAt);
                        const byLabel = resolveUpdatedBy(row.updatedBy, emailByUid);
                        const nameCell = (
                          <>
                            <span className="schemas__row-name">{row.name || row.id}</span>
                            <code className="schemas__row-id">{row.id}</code>
                          </>
                        );
                        return (
                          <tr
                            key={row.id}
                            className={onSelect ? 'schemas__row schemas__row--clickable' : 'schemas__row'}
                            {...(onSelect ? { onClick: () => onSelect(row.id) } : {})}
                          >
                            <td className="schemas__td schemas__td--name">
                              {onSelect ? (
                                <button type="button" className="schemas__row-main">
                                  {nameCell}
                                </button>
                              ) : (
                                <div className="schemas__row-main schemas__row-main--static">{nameCell}</div>
                              )}
                            </td>
                            <td className="schemas__td schemas__td--version">
                              {/* The mock's `.ver` is plain mono text, not a pill; the
                                  2026-09-10 table read a pill into it. */}
                              <span className="schemas__version">v{row.version}</span>
                            </td>
                            <td className="schemas__td schemas__td--updated">
                              {updatedFull ?? <span className="schemas__blank">-</span>}
                            </td>
                            <td className="schemas__td schemas__td--by">
                              {byLabel ?? <span className="schemas__blank">-</span>}
                            </td>
                            <td
                              className="schemas__td schemas__td--actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <IconButton
                                icon={<TrashGlyph />}
                                label={`Delete ${row.name || row.id}`}
                                onClick={() => setPendingDelete(row)}
                                destructive
                                revealOnHover
                                size={32}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="schemas__footer">
                <GhostButton label="Reload" onClick={load} />
              </div>
            </>
          );
        }}
      </AsyncRegion>

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
