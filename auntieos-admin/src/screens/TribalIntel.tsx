import { useState } from 'react';
import { TRIBAL_INTEL_QUERY, type TribalIntelEntry } from '../api/tribalIntel';
import { KINFOLK_QUERY, KIN_QUERY, type Kin, type Kinfolk } from '../api/directory';
import { deleteTrainingDocument } from '../api/tribalIntelWrite';
import {
  TRIBAL_INTEL_DELETE_CAVEAT,
  TRIBAL_INTEL_QUEUED_MESSAGE,
  attachmentCountLabel,
  distinctCommTypes,
  dropEmptyTribalIntel,
  filterByCommType,
  filterTribalIntel,
  isTribalIntelTitleFallback,
  reconcileState,
  reconcileStateInfo,
  relatedToLabel,
  tribalIntelTitle,
  tribalIntelWhen,
} from '../lib/tribalIntelFormat';
import { useCollection } from '../lib/firestore';
import { asyncScalar } from '../lib/async';
import { str } from '../lib/coerce';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Dialog } from '../components/Dialog';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { TribalIntelForm, messageOf } from '../components/TribalIntelForm';
import './TribalIntel.css';

/**
 * Admin Tribal Intel list ("The Den · Tribal Intel", nav slug `tribal-intel`,
 * `NavEntry.dest` `trainingDocs` per `lib/nav.ts`). Streams the flat
 * `training_documents` collection through the bounded, server-ordered
 * listener (TRIBAL_INTEL_QUERY: uploadedAt desc, capped 200, the one time
 * field every writer of this collection stamps: see that spec for the
 * writer-by-writer evidence), then
 * classifies every row's `reconcileStatus` through the enumerated
 * `reconcileState` (never by negation: see `lib/tribalIntelFormat.ts` for
 * the AO-12-style rationale) for the reconcile-status chip, and offers a
 * free-text search plus a dynamic comm.-type filter over the same
 * already-streamed page (the FormSchemas.tsx / KinTales.tsx conventions
 * combined, since this collection genuinely needs both).
 *
 * FULL CRUD, all of it server-bound. `firestore.rules` keeps
 * `training_documents` at `allow write: if false`, so create, edit, and delete
 * all route through the deployed admin callables via `api/tribalIntelWrite.ts`.
 * The create/edit panel is `components/TribalIntelForm.tsx`; delete is a
 * confirm dialog that states the caveat the server's own handler documents.
 *
 * NEITHER WRITE MAKES A CLAIM THE BACKEND DOES NOT HONOR. A save queues the
 * entry for the NEXT nightly reconcile pass and says so; a delete removes the
 * source note only, and says that already-folded dossier and 411 text is not
 * unmerged.
 */
export function TribalIntel() {
  const rows = useCollection<TribalIntelEntry>(TRIBAL_INTEL_QUERY);
  // The target picker's rosters. Streamed here rather than inside the form so
  // opening the panel is instant instead of showing an empty household list
  // while a fresh listener warms up.
  const kinfolkRows = useCollection<Kinfolk>(KINFOLK_QUERY);
  const kinRows = useCollection<Kin>(KIN_QUERY);

  const [query, setQuery] = useState('');
  const [commTypeFilter, setCommTypeFilter] = useState<string | null>(null);

  // null = panel closed. 'new' = create. Otherwise the entry being edited.
  const [editing, setEditing] = useState<TribalIntelEntry | 'new' | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TribalIntelEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);

  // Junk rows are dropped ONCE, here, so the stat strip and the list can never
  // describe different sets. See `dropEmptyTribalIntel` for what counts as junk
  // and why an attachment-only entry is not.
  const totalCount = asyncScalar(rows, (data) => dropEmptyTribalIntel(data).length);
  const commTypeCount = asyncScalar(rows, (data) => distinctCommTypes(dropEmptyTribalIntel(data)).length);
  const withContentCount = asyncScalar(
    rows,
    (data) => dropEmptyTribalIntel(data).filter((d) => str(d.content).trim() !== '').length,
  );

  // Same derivation as commTypeCount above, kept as the actual array (not
  // just its length) so the roving-tabindex hook below has a real tab count
  // to call unconditionally at the top level, per the Rules of Hooks: the
  // tabs themselves render inside AsyncRegion's conditionally-invoked render
  // prop, where `rows.data` isn't in scope.
  const commTypesForTabs = rows.status === 'ready' ? distinctCommTypes(dropEmptyTribalIntel(rows.data)) : [];
  const { getTabProps } = useRovingTabs({
    count: commTypesForTabs.length > 0 ? commTypesForTabs.length + 1 : 0,
    activeIndex: commTypeFilter === null ? 0 : 1 + commTypesForTabs.indexOf(commTypeFilter),
  });

  const kinfolk = kinfolkRows.status === 'ready' ? kinfolkRows.data : [];
  const kin = kinRows.status === 'ready' ? kinRows.data : [];

  async function confirmDelete(doc: TribalIntelEntry) {
    setDeleting(true);
    setDeleteFailure(null);
    try {
      await deleteTrainingDocument(doc._id);
      setPendingDelete(null);
      // If the deleted entry was open in the editor, close it: editing a row
      // that no longer exists would fail on save with a bare "not-found".
      setEditing((cur) => (cur !== null && cur !== 'new' && cur._id === doc._id ? null : cur));
    } catch (err) {
      setDeleteFailure(messageOf(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Tribal Intel"
        title="Tribal"
        accentTail="Intel."
        subtitle="Guides and educational resources for care delivery, newest first."
        trailing={
          editing === null ? (
            <PrimaryButton
              label="Add intel"
              onClick={() => {
                setQueued(null);
                setDeleteFailure(null);
                setEditing('new');
              }}
            />
          ) : undefined
        }
      />

      {queued !== null && (
        <Banner tone="suggestion" title="Queued for reconcile" pillLabel="QUEUED" onDismiss={() => setQueued(null)}>
          {queued}
        </Banner>
      )}

      {deleteFailure !== null && pendingDelete === null && (
        <Banner tone="error" title="Could not delete" onDismiss={() => setDeleteFailure(null)}>
          {deleteFailure}
        </Banner>
      )}

      {editing !== null && (
        <TribalIntelForm
          editing={editing === 'new' ? null : editing}
          kinfolk={kinfolk}
          kin={kin}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setQueued(TRIBAL_INTEL_QUEUED_MESSAGE);
          }}
        />
      )}

      <div className="tribal-intel__summary">
        <StatCard label="Total" value={totalCount} trend="documents on file" tone="orange" feature />
        <StatCard label="Comm. types" value={commTypeCount} trend="distinct categories" tone="teal" />
        <StatCard label="With content" value={withContentCount} trend="have a body" tone="purple" />
      </div>

      <DenPanel title="Document library" subtitle="Search across titles, content, and comm. type.">
        <AsyncRegion
          state={rows}
          what="Tribal Intel"
          isEmpty={(data) => dropEmptyTribalIntel(data).length === 0}
          loading={<p className="tribal-intel__hint">Loading Tribal Intel…</p>}
          empty={
            <EmptyHint>No Tribal Intel yet. Training materials and guides will appear here once uploaded.</EmptyHint>
          }
        >
          {(data) => {
            const real = dropEmptyTribalIntel(data);
            const commTypes = distinctCommTypes(real);
            const searched = filterTribalIntel(real, query);
            const visible = filterByCommType(searched, commTypeFilter);

            return (
              <>
                <div className="tribal-intel__search">
                  <input
                    type="search"
                    className="tribal-intel__search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search documents…"
                    aria-label="Search Tribal Intel documents"
                  />
                </div>

                {/* Dynamic comm.-type tabs, live over the full streamed set (not just
                    the search-narrowed one): matches the wasm's own
                    `commTypeOptions` derivation, which reads `state.allDocs`. */}
                {commTypes.length > 0 && (
                  <div className="tribal-intel__tabs" role="tablist" aria-label="Filter by comm. type">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={commTypeFilter === null}
                      className={
                        commTypeFilter === null
                          ? 'tribal-intel__tab tribal-intel__tab--active'
                          : 'tribal-intel__tab'
                      }
                      onClick={() => setCommTypeFilter(null)}
                      {...getTabProps(0)}
                    >
                      All
                    </button>
                    {commTypes.map((ct, index) => (
                      <button
                        key={ct}
                        type="button"
                        role="tab"
                        aria-selected={commTypeFilter === ct}
                        className={
                          commTypeFilter === ct
                            ? 'tribal-intel__tab tribal-intel__tab--active'
                            : 'tribal-intel__tab'
                        }
                        onClick={() => setCommTypeFilter((cur) => (cur === ct ? null : ct))}
                        {...getTabProps(index + 1)}
                      >
                        {ct}
                      </button>
                    ))}
                  </div>
                )}

                {visible.length === 0 ? (
                  <EmptyHint>
                    {query.trim() !== ''
                      ? `No documents match “${query}”.`
                      : 'Nothing matches this filter.'}
                  </EmptyHint>
                ) : (
                  <ul className="tribal-intel__list">
                    {visible.map((doc) => (
                      <TribalIntelRow
                        key={doc._id}
                        doc={doc}
                        onEdit={() => {
                          setQueued(null);
                          setDeleteFailure(null);
                          setEditing(doc);
                        }}
                        onDelete={() => {
                          setDeleteFailure(null);
                          setPendingDelete(doc);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {pendingDelete !== null && (
        <Dialog
          title="Delete this Tribal Intel entry?"
          onClose={() => {
            if (!deleting) setPendingDelete(null);
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              />
              <PrimaryButton
                label="Delete entry"
                onClick={() => void confirmDelete(pendingDelete)}
                disabled={deleting}
                busy={deleting}
              />
            </>
          }
        >
          {/* The caveat the server's own handler documents, shown BEFORE the
              operator can commit. Deleting the note does not walk back a fold
              the reconcile pipeline already made. */}
          <p className="tribal-intel__confirm">{TRIBAL_INTEL_DELETE_CAVEAT}</p>
          {deleteFailure !== null && (
            <Banner tone="error" title="Could not delete">
              {deleteFailure}
            </Banner>
          )}
        </Dialog>
      )}
    </div>
  );
}

interface TribalIntelRowProps {
  doc: TribalIntelEntry;
  onEdit: () => void;
  onDelete: () => void;
}

function TribalIntelRow({ doc, onEdit, onDelete }: TribalIntelRowProps) {
  // Defensive reads: useCollection casts raw doc.data() with no normalization,
  // so a legacy training_documents doc missing a field must not throw and blank
  // the screen. Default every field this row touches.
  const content = doc.content ?? '';
  const notes = doc.notes ?? '';
  const commType = doc.communicationType ?? '';
  const attachments = doc.attachments ?? [];
  const title = tribalIntelTitle(doc.title ?? '');
  const blankTitle = isTribalIntelTitleFallback(doc.title ?? '');
  const when = tribalIntelWhen(doc.uploadedAt ?? '');
  const related = relatedToLabel(doc.kinfolkRef ?? '');
  const attachmentLabel = attachmentCountLabel(attachments.length);
  const reconcileNotes = doc.reconcileNotes ?? '';
  const state = reconcileState(doc.reconcileStatus ?? '');
  const info = reconcileStateInfo(state);
  // Matches the wasm's own `if (doc.reconcileStatus.isNotBlank())`: a
  // never-queued ("none") doc shows no chip at all, rather than a "NONE"
  // pill on every legacy row.
  const showReconcileChip = state !== 'none';

  const body = (
    <>
      <span className="tribal-intel__row-head">
        <span
          className={
            blankTitle ? 'tribal-intel__row-title tribal-intel__row-title--blank' : 'tribal-intel__row-title'
          }
        >
          {title}
        </span>
        {commType.trim() !== '' && (
          <span className="tribal-intel__chip tribal-intel__chip--comm">{commType}</span>
        )}
        <span className="tribal-intel__row-when">{when}</span>
      </span>

      {content.trim() !== '' && <p className="tribal-intel__row-content">{content}</p>}

      {notes.trim() !== '' && <p className="tribal-intel__row-notes">Notes: {notes}</p>}

      <span className="tribal-intel__row-meta">
        {related !== null && <span className="tribal-intel__row-related">Related to: {related}</span>}
        {attachmentLabel !== null && <span className="tribal-intel__row-pip">{attachmentLabel}</span>}
        {showReconcileChip && (
          <span className={`tribal-intel__chip tribal-intel__chip--${info.cssClass}`}>{info.chipLabel}</span>
        )}
      </span>

      {showReconcileChip && reconcileNotes.trim() !== '' && (
        <p className="tribal-intel__row-reconcile-notes">{reconcileNotes}</p>
      )}
    </>
  );

  // The row body stays static text; Edit and Delete are the only controls in
  // it. Wrapping the whole card in a button and then nesting two more buttons
  // inside it is invalid, and a card that both navigates and holds a
  // destructive control is how accidental deletes happen.
  return (
    <li className="tribal-intel__row">
      <div className="tribal-intel__row-main tribal-intel__row-main--static">{body}</div>
      <div className="tribal-intel__row-actions">
        <GhostButton label="Edit" onClick={onEdit} />
        <GhostButton label="Delete" onClick={onDelete} />
      </div>
    </li>
  );
}
