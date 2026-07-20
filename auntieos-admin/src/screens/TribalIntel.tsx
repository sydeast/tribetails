import { useState } from 'react';
import { TRIBAL_INTEL_QUERY, type TribalIntelEntry } from '../api/tribalIntel';
import {
  attachmentCountLabel,
  distinctCommTypes,
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
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import './TribalIntel.css';

interface TribalIntelProps {
  /**
   * Placeholder: the per-document detail/editor (the wasm's `AddDocumentForm`
   * create/edit panel, attachment upload, and delete confirm) is a separate,
   * not-yet-built surface: this port is LIST ONLY, per the fan-out brief.
   * Omitting this renders every row as a real, focusable STATIC element,
   * never a live `<button>` that silently no-ops (the dead-control
   * anti-pattern; see the `KinTales.tsx`/`Invoices.tsx` `onSelect`-is-optional
   * convention this mirrors). Wiring a real detail route later touches only
   * the router, not this file.
   */
  onSelect?: (docId: string) => void;
}

/**
 * Admin Tribal Intel list ("The Den · Tribal Intel", nav slug `tribal-intel`,
 * `NavEntry.dest` `trainingDocs` per `lib/nav.ts`). Streams the flat
 * `training_documents` collection through the bounded, server-ordered
 * listener (TRIBAL_INTEL_QUERY: createdAt desc, capped 200), then
 * classifies every row's `reconcileStatus` through the enumerated
 * `reconcileState` (never by negation: see `lib/tribalIntelFormat.ts` for
 * the AO-12-style rationale) for the reconcile-status chip, and offers a
 * free-text search plus a dynamic comm.-type filter over the same
 * already-streamed page (the FormSchemas.tsx / KinTales.tsx conventions
 * combined, since this collection genuinely needs both).
 *
 * List only: creating or editing a Tribal Intel entry (the wasm's
 * `AddDocumentForm`: free text + Cloudinary attachments + a Kinfolk/Kin
 * target picker, saved via the createTrainingDocument/updateTrainingDocument
 * admin callables) and the delete confirm are separate, not-yet-built
 * surfaces. `onSelect` is this screen's only hook into that later work.
 */
export function TribalIntel({ onSelect }: TribalIntelProps) {
  const rows = useCollection<TribalIntelEntry>(TRIBAL_INTEL_QUERY);
  const [query, setQuery] = useState('');
  const [commTypeFilter, setCommTypeFilter] = useState<string | null>(null);

  // Computed off the same streamed page the list itself renders (the
  // Invoices.tsx convention), never re-fetched, never a separate `?? 0`.
  const totalCount = asyncScalar(rows, (data) => data.length);
  const commTypeCount = asyncScalar(rows, (data) => distinctCommTypes(data).length);
  const withContentCount = asyncScalar(rows, (data) => data.filter((d) => d.content.trim() !== '').length);

  // Same derivation as commTypeCount above, kept as the actual array (not
  // just its length) so the roving-tabindex hook below has a real tab count
  // to call unconditionally at the top level, per the Rules of Hooks: the
  // tabs themselves render inside AsyncRegion's conditionally-invoked render
  // prop, where `rows.data` isn't in scope.
  const commTypesForTabs = rows.status === 'ready' ? distinctCommTypes(rows.data) : [];
  const { getTabProps } = useRovingTabs({
    count: commTypesForTabs.length > 0 ? commTypesForTabs.length + 1 : 0,
    activeIndex: commTypeFilter === null ? 0 : 1 + commTypesForTabs.indexOf(commTypeFilter),
  });

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Tribal Intel"
        title="Tribal"
        accentTail="Intel."
        subtitle="Guides and educational resources for care delivery, newest first."
      />

      <div className="tribal-intel__summary">
        <StatCard label="Total" value={totalCount} trend="documents on file" tone="orange" feature />
        <StatCard label="Comm. types" value={commTypeCount} trend="distinct categories" tone="teal" />
        <StatCard label="With content" value={withContentCount} trend="have a body" tone="purple" />
      </div>

      <DenPanel title="Document library" subtitle="Search across titles, content, and comm. type.">
        <AsyncRegion
          state={rows}
          what="Tribal Intel"
          isEmpty={(data) => data.length === 0}
          loading={<p className="tribal-intel__hint">Loading Tribal Intel…</p>}
          empty={
            <EmptyHint>No Tribal Intel yet. Training materials and guides will appear here once uploaded.</EmptyHint>
          }
        >
          {(data) => {
            const commTypes = distinctCommTypes(data);
            const searched = filterTribalIntel(data, query);
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
                      <TribalIntelRow key={doc._id} doc={doc} onSelect={onSelect} />
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

interface TribalIntelRowProps {
  doc: TribalIntelEntry;
  onSelect?: ((docId: string) => void) | undefined;
}

function TribalIntelRow({ doc, onSelect }: TribalIntelRowProps) {
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

      {showReconcileChip && doc.reconcileNotes.trim() !== '' && (
        <p className="tribal-intel__row-reconcile-notes">{doc.reconcileNotes}</p>
      )}
    </>
  );

  // Static, non-interactive row unless a detail handler is wired (see
  // TribalIntelProps): a live no-op button is the dead-control anti-pattern.
  return (
    <li className="tribal-intel__row">
      {onSelect ? (
        <button type="button" className="tribal-intel__row-main" onClick={() => onSelect(doc._id)}>
          {body}
        </button>
      ) : (
        <div className="tribal-intel__row-main tribal-intel__row-main--static">{body}</div>
      )}
    </li>
  );
}
