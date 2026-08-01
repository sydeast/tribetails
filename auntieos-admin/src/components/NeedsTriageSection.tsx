import { useState } from 'react';
import {
  listOrphanReports,
  assignKinfolkToOrphanReport,
  markOrphanReportAsDuplicate,
  archiveOrphanReportAsBadData,
  type OrphanReportEntry,
} from '../api/kinTaleTriage';
import { matchesKinfolk, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { type KinTaleEntry } from '../api/kinTales';
import { sentViaLabel, bodyPreview } from '../lib/kinTaleFormat';
import { useOneShot } from '../lib/useOneShot';
import { type Async } from '../lib/async';
import { useToast } from './Toast';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './NeedsTriageSection.css';

/**
 * B2: "Needs triage" — the orphan-migration section KinTale Logs was missing
 * entirely on web (Android has carried it since M5; see `KinTaleLogsScreen.kt`
 * on that platform and `api/kinTaleTriage.ts`'s file header for the gap this
 * closes). An orphan is completed care work with no session to bill it
 * against, imported by the May 17 pre-cutover `visit_logs` migration with no
 * `kinfolkId`. Without this section an operator at a desk had no way to see
 * one, let alone act on it.
 *
 * Self-contained: fetches its own orphan list (`listOrphanReports`, a
 * one-shot read, not a live stream, matching Android's own
 * `loadKinCareReports()` reload-on-mutation pattern rather than an
 * `onSnapshot`), and owns its three triage dialogs. The parent screen hands
 * in the two directories it already has open rather than this section
 * opening duplicate listeners: the household roster (for Assign) and the
 * already-loaded non-orphan reports (for "mark duplicate of").
 *
 * A TRIAGED ORPHAN IS REMOVED LOCALLY THE MOMENT THE SERVER CONFIRMS THE
 * WRITE, never re-fetched and never assumed. `removedIds` only ever gains an
 * id inside a `.then` after `triageOrphanReport` has actually resolved, the
 * same "only set after Firestore acknowledged the write" discipline
 * `HouseholdData.tsx`'s own `saved` state documents.
 */

interface NeedsTriageSectionProps {
  /** The household roster, already open by the parent screen (`KinTales.tsx`'s own `households`), for the Assign dialog's search. */
  kinfolk: Async<Kinfolk[]>;
  /**
   * Non-orphan reports the parent has already loaded, offered as "mark
   * duplicate of" candidates. Scoped to what is loaded, exactly like the
   * search box beside the main list; the dialog says so.
   */
  candidateReports: KinTaleEntry[];
}

type TriageSheet =
  | { kind: 'assign'; report: OrphanReportEntry }
  | { kind: 'duplicate'; report: OrphanReportEntry }
  | { kind: 'archive'; report: OrphanReportEntry };

export function NeedsTriageSection({ kinfolk, candidateReports }: NeedsTriageSectionProps) {
  const loaded = useOneShot(() => listOrphanReports(), 'orphaned KinTales');
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const [activeSheet, setActiveSheet] = useState<TriageSheet | null>(null);
  const { showToast } = useToast();

  const state: Async<OrphanReportEntry[]> =
    loaded.status === 'ready'
      ? { status: 'ready', data: loaded.data.filter((r) => !removedIds.has(r._id)) }
      : loaded;

  // Quiet while loading (the parent's own list has its own loading treatment,
  // and a section that may turn out empty should not flash a skeleton first)
  // and quiet when proven empty (nothing needs triage). A FAILED read is the
  // one state that must never be silent: fail loud, per the repo's error
  // philosophy, rather than an operator believing there is simply nothing to
  // triage when the read never actually landed.
  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <Banner tone="error" title="Couldn't load orphaned KinTales" trailing={state.retry && <GhostButton label="Retry" onClick={state.retry} />}>
        {state.message}
      </Banner>
    );
  }
  if (state.data.length === 0) return null;

  const orphanIds = new Set(state.data.map((r) => r._id));

  function onTriaged(reportId: string, message: string) {
    setRemovedIds((prev) => new Set(prev).add(reportId));
    setActiveSheet(null);
    showToast(message);
  }

  return (
    <section className="needs-triage">
      <Banner
        tone="warning"
        title="Needs triage"
        pillLabel={`${String(state.data.length)} orphan${state.data.length === 1 ? '' : 's'}`}
      >
        Pre-cutover visit logs migrated without a Kinfolk link. Assign, mark duplicate, or archive
        each before it counts as a real KinTale.
      </Banner>

      <ul className="needs-triage__list">
        {state.data.map((report) => (
          <li key={report._id} className="needs-triage__row">
            <div className="needs-triage__row-meta">
              <span className="needs-triage__row-id">{report._id}</span>
              <span className="needs-triage__row-dot" aria-hidden="true">
                ·
              </span>
              <span className="needs-triage__row-via">{sentViaLabel(report.sentVia)}</span>
            </div>
            <p className="needs-triage__row-body">{bodyPreview(report.bodyCopy)}</p>
            <div className="needs-triage__row-actions">
              <PrimaryButton label="Assign" onClick={() => setActiveSheet({ kind: 'assign', report })} />
              <GhostButton
                label="Mark duplicate"
                onClick={() => setActiveSheet({ kind: 'duplicate', report })}
              />
              <GhostButton label="Archive" onClick={() => setActiveSheet({ kind: 'archive', report })} />
            </div>
          </li>
        ))}
      </ul>

      {activeSheet?.kind === 'assign' && (
        <AssignOrphanDialog
          report={activeSheet.report}
          kinfolk={kinfolk}
          onClose={() => setActiveSheet(null)}
          onAssigned={(name) =>
            onTriaged(activeSheet.report._id, `Assigned ${activeSheet.report._id} to ${name}.`)
          }
        />
      )}
      {activeSheet?.kind === 'duplicate' && (
        <MarkDuplicateDialog
          report={activeSheet.report}
          candidates={candidateReports.filter((r) => !orphanIds.has(r._id))}
          onClose={() => setActiveSheet(null)}
          onMarked={(canonicalId) =>
            onTriaged(
              activeSheet.report._id,
              `Marked ${activeSheet.report._id} as a duplicate of ${canonicalId}.`,
            )
          }
        />
      )}
      {activeSheet?.kind === 'archive' && (
        <ArchiveOrphanDialog
          report={activeSheet.report}
          onClose={() => setActiveSheet(null)}
          onArchived={() => onTriaged(activeSheet.report._id, `Archived ${activeSheet.report._id}.`)}
        />
      )}
    </section>
  );
}

// ── Assign ───────────────────────────────────────────────────────────────

interface AssignOrphanDialogProps {
  report: OrphanReportEntry;
  kinfolk: Async<Kinfolk[]>;
  onClose: () => void;
  onAssigned: (kinfolkName: string) => void;
}

function AssignOrphanDialog({ report, kinfolk, onClose, onAssigned }: AssignOrphanDialogProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roster = kinfolk.status === 'ready' ? kinfolk.data : [];
  const options = roster.filter((k) => k.status !== 'archived' && matchesKinfolk(k, query));
  const selected = options.find((k) => k._id === selectedId) ?? roster.find((k) => k._id === selectedId);

  async function handleAssign() {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    const name = kinfolkDisplayName(selected);
    try {
      await assignKinfolkToOrphanReport(report._id, selected._id, name);
      setSaving(false);
      onAssigned(name);
    } catch (err) {
      setSaving(false);
      setError(
        `assignKinfolkToOrphanReport failed: ${err instanceof Error ? err.message : 'Assign failed'}`,
      );
    }
  }

  return (
    <Dialog
      title={`Assign kinfolk to ${report._id}`}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Assigning…' : 'Assign'}
            onClick={() => void handleAssign()}
            disabled={saving || selectedId === ''}
            busy={saving}
          />
        </>
      }
    >
      <label className="needs-triage__field-label" htmlFor="assign-orphan-search">
        Search kinfolk
      </label>
      <input
        id="assign-orphan-search"
        type="text"
        className="needs-triage__input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, phone, or email"
        disabled={saving}
      />

      {kinfolk.status === 'error' && (
        <Banner tone="error" title="Kinfolk directory unavailable">
          {kinfolk.message}
        </Banner>
      )}
      {kinfolk.status !== 'error' && options.length === 0 && (
        <p className="needs-triage__hint">No matching kinfolk.</p>
      )}

      <ul className="needs-triage__options">
        {options.map((k) => (
          <li key={k._id}>
            <button
              type="button"
              className={
                selectedId === k._id
                  ? 'needs-triage__option needs-triage__option--selected'
                  : 'needs-triage__option'
              }
              onClick={() => setSelectedId(k._id)}
              disabled={saving}
              aria-pressed={selectedId === k._id}
            >
              {kinfolkDisplayName(k)}
            </button>
          </li>
        ))}
      </ul>

      {error !== null && (
        <Banner tone="error" title="Assign failed">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

// ── Mark duplicate ───────────────────────────────────────────────────────

interface MarkDuplicateDialogProps {
  report: OrphanReportEntry;
  /** Already excludes every other current orphan; the parent passes only genuine, previously-triaged candidates. */
  candidates: KinTaleEntry[];
  onClose: () => void;
  onMarked: (canonicalReportId: string) => void;
}

function matchesCandidate(entry: KinTaleEntry, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (n === '') return true;
  return (
    (entry.kinfolkName ?? '').toLowerCase().includes(n) ||
    (entry.title ?? '').toLowerCase().includes(n) ||
    (entry.bodyCopy ?? '').toLowerCase().includes(n) ||
    entry._id.toLowerCase().includes(n)
  );
}

function MarkDuplicateDialog({ report, candidates, onClose, onMarked }: MarkDuplicateDialogProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = candidates.filter((c) => matchesCandidate(c, query));

  async function handleMark() {
    if (selectedId === '' || saving) return;
    setSaving(true);
    setError(null);
    try {
      await markOrphanReportAsDuplicate(report._id, selectedId);
      setSaving(false);
      onMarked(selectedId);
    } catch (err) {
      setSaving(false);
      setError(
        `markOrphanReportAsDuplicate failed: ${err instanceof Error ? err.message : 'Mark duplicate failed'}`,
      );
    }
  }

  return (
    <Dialog
      title={`Mark ${report._id} as duplicate`}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Marking…' : 'Mark duplicate'}
            onClick={() => void handleMark()}
            disabled={saving || selectedId === ''}
            busy={saving}
          />
        </>
      }
    >
      <p className="needs-triage__hint">
        Pick the existing KinTale this orphan duplicates. Scoped to the KinTales already loaded on
        this screen, same as the search box above the list.
      </p>
      <label className="needs-triage__field-label" htmlFor="duplicate-orphan-search">
        Search by kinfolk, title, body, or report id
      </label>
      <input
        id="duplicate-orphan-search"
        type="text"
        className="needs-triage__input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={saving}
      />

      {filtered.length === 0 ? (
        <p className="needs-triage__hint">No matching reports.</p>
      ) : (
        <ul className="needs-triage__options">
          {filtered.map((c) => (
            <li key={c._id}>
              <button
                type="button"
                className={
                  selectedId === c._id
                    ? 'needs-triage__option needs-triage__option--selected'
                    : 'needs-triage__option'
                }
                onClick={() => setSelectedId(c._id)}
                disabled={saving}
                aria-pressed={selectedId === c._id}
              >
                <span className="needs-triage__option-title">
                  {c._id} - {(c.kinfolkName ?? '').trim() === '' ? 'Unnamed Kinfolk' : c.kinfolkName}
                </span>
                <span className="needs-triage__option-sub">{bodyPreview(c.bodyCopy ?? '')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <Banner tone="error" title="Mark duplicate failed">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

// ── Archive ──────────────────────────────────────────────────────────────

interface ArchiveOrphanDialogProps {
  report: OrphanReportEntry;
  onClose: () => void;
  onArchived: () => void;
}

const ARCHIVE_REASON_MIN = 5;

function ArchiveOrphanDialog({ report, onClose, onArchived }: ArchiveOrphanDialogProps) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const valid = trimmed.length >= ARCHIVE_REASON_MIN;

  async function handleArchive() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await archiveOrphanReportAsBadData(report._id, trimmed);
      setSaving(false);
      onArchived();
    } catch (err) {
      setSaving(false);
      setError(
        `archiveOrphanReportAsBadData failed: ${err instanceof Error ? err.message : 'Archive failed'}`,
      );
    }
  }

  return (
    <Dialog
      title={`Archive ${report._id} as bad data`}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Archiving…' : 'Archive'}
            onClick={() => void handleArchive()}
            disabled={saving || !valid}
            busy={saving}
          />
        </>
      }
    >
      <p className="needs-triage__hint">
        Soft-archive: the report stays in Firestore for audit but is hidden from the active buckets.
        The reason is recorded in the activity log.
      </p>
      <label className="needs-triage__field-label" htmlFor="archive-orphan-reason">
        {`Archive reason (at least ${String(ARCHIVE_REASON_MIN)} characters)`}
      </label>
      <textarea
        id="archive-orphan-reason"
        className="needs-triage__textarea"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        disabled={saving}
        aria-invalid={reason !== '' && !valid}
      />
      {reason !== '' && !valid && (
        <p className="needs-triage__error" role="alert">
          {`Reason must be at least ${String(ARCHIVE_REASON_MIN)} characters.`}
        </p>
      )}

      {error !== null && (
        <Banner tone="error" title="Archive failed">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}
