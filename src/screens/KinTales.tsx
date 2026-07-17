import { useState } from 'react';
import { KINTALES_QUERY, type KinTaleEntry } from '../api/kinTales';
import {
  kinTaleHeadline,
  kinTaleHousehold,
  kinTaleState,
  kinTaleStateInfo,
  kinTaleWhen,
  sentViaLabel,
  type KinTaleState,
} from '../lib/kinTaleFormat';
import { useCollection } from '../lib/firestore';
import { asyncScalar } from '../lib/async';
import { DenScreenHeading, DenPanel, StatCard, ServicePill, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import './KinTales.css';

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * the enumerated `KinTaleState` (the Sessions/Invoices `FILTERS` / AO-12
 * convention) — never a negation of another bucket. A row whose status
 * matches none of the three known codes (`'unknown'`) still shows under
 * "All"; it simply has no dedicated tab of its own, same as Sessions' own
 * `'unknown'` state.
 */
type FilterKey = 'all' | 'draft' | 'sent' | 'failed';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (state: KinTaleState) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'draft', label: 'Drafts', test: (s) => s === 'draft' },
  { key: 'sent', label: 'Sent', test: (s) => s === 'sent' },
  { key: 'failed', label: 'Failed', test: (s) => s === 'failed' },
];

interface KinTalesProps {
  /**
   * Placeholder: the single-report detail/editor (`KinTaleReportScreen.kt`:
   * compose, comment thread, share link, "view as kinfolk") is a separate,
   * not-yet-built screen; this port is LIST/FEED ONLY. The router mounts this
   * screen propless, so `onSelect` is undefined in production. See `KinTaleRow`:
   * when unwired the row renders a STATIC <div>, not a <button>. A handler-less
   * <button> still carries the implicit ARIA button role and is a focusable dead
   * control, so the row only becomes a real <button> once a detail route wires
   * the handler.
   */
  onSelect?: (kinTaleId: string) => void;
}

/**
 * Admin KinTales list ("The Den · KinTales", nav slug `kintales` per
 * `lib/nav.ts`). Streams the flat `kin_care_reports` collection through the
 * bounded, server-ordered listener (KINTALES_QUERY — createdAt desc, capped
 * 200), then classifies every row through the enumerated `kinTaleState`
 * (never by negation — see lib/kinTaleFormat.ts for the AO-12-style
 * rationale) for both the summary stat strip and the filter tabs.
 *
 * List/feed only: composing or editing a KinTale (KinTaleComposeScreen), the
 * per-report detail/comment-thread/share-link view (KinTaleReportScreen), the
 * orphan-migration triage actions (assign/mark-duplicate/archive), template
 * editing, and search/sort are separate, not-yet-built surfaces. `onSelect`
 * is this screen's only hook into that later work.
 */
export function KinTales({ onSelect }: KinTalesProps) {
  const rows = useCollection<KinTaleEntry>(KINTALES_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');

  const sentCount = asyncScalar(rows, (data) =>
    data.filter((e) => kinTaleState(e.status) === 'sent').length,
  );
  const draftCount = asyncScalar(rows, (data) =>
    data.filter((e) => kinTaleState(e.status) === 'draft').length,
  );
  const failedCount = asyncScalar(rows, (data) =>
    data.filter((e) => kinTaleState(e.status) === 'failed').length,
  );

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · KinTales"
        title="Every recap that goes"
        accentTail="home."
        subtitle="Every KinTale a Kinfolk receives after care, newest first."
      />

      <div className="kintales__summary">
        <StatCard label="Sent" value={sentCount} trend="delivered to a Kinfolk" tone="success" />
        <StatCard label="Drafts" value={draftCount} trend="not yet sent" tone="teal" />
        <StatCard
          label="Needs another look"
          value={failedCount}
          trend="failed to send"
          tone={failedCount.kind === 'value' && failedCount.value > 0 ? 'error' : 'muted'}
          feature={failedCount.kind === 'value' && failedCount.value > 0}
        />
      </div>

      <DenPanel title="KinTales" subtitle="Newest first, capped at 200.">
        <AsyncRegion
          state={rows}
          what="KinTales"
          isEmpty={(data) => data.length === 0}
          loading={<p className="kintales__hint">Loading KinTales…</p>}
          empty={<EmptyHint>No KinTales sent yet.</EmptyHint>}
        >
          {(data) => {
            // Non-null: FILTERS lists all four FilterKey members above, and
            // `filter` only ever holds a key set via setFilter(f.key) from
            // that same array (Sessions.tsx's identical .find()! comment).
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = data.filter((e) => activeFilter.test(kinTaleState(e.status)));

            return (
              <>
                <div className="kintales__tabs" role="tablist" aria-label="Filter KinTales">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'kintales__tab kintales__tab--active' : 'kintales__tab'}
                      onClick={() => setFilter(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {visible.length === 0 ? (
                  <EmptyHint>Nothing matches this filter.</EmptyHint>
                ) : (
                  <ul className="kintales__list">
                    {visible.map((entry) => (
                      <KinTaleRow key={entry._id} entry={entry} onSelect={onSelect} />
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

interface KinTaleRowProps {
  entry: KinTaleEntry;
  onSelect?: ((kinTaleId: string) => void) | undefined;
}

function KinTaleRow({ entry, onSelect }: KinTaleRowProps) {
  const state = kinTaleState(entry.status);
  const info = kinTaleStateInfo(state);
  const household = kinTaleHousehold(entry.kinfolkName);
  const headline = kinTaleHeadline(entry.title, entry.bodyCopy);
  const when = kinTaleWhen(entry);
  const mediaCount = entry.mediaFileIds.length;
  const kinCount = entry.kinIds.length;
  // Only a SENT (or otherwise dispatched) row carries a real channel; a
  // draft's blank sentVia would otherwise read as the misleading "imported"
  // sentViaLabel default (see lib/kinTaleFormat.ts#sentViaLabel's doc comment).
  const channel = entry.sentVia.trim() !== '' ? sentViaLabel(entry.sentVia) : null;

  const body = (
    <>
      <span className="kintales__row-head">
        <span className="kintales__row-name">{household}</span>
        {entry.serviceType.trim() !== '' ? <ServicePill serviceType={entry.serviceType} /> : null}
        <span className={`kintales__chip kintales__chip--${info.cssClass}`}>{info.chipLabel}</span>
      </span>

      <span className="kintales__row-headline">{headline}</span>

      <span className="kintales__row-meta">
        <span className="kintales__row-when">{when}</span>
        {entry.authorDisplayName.trim() !== '' ? (
          <span className="kintales__row-author">by {entry.authorDisplayName}</span>
        ) : null}
        {kinCount > 0 ? <span className="kintales__row-pip">{kinCount} kin</span> : null}
        {mediaCount > 0 ? (
          <span className="kintales__row-pip">
            {mediaCount} photo{mediaCount === 1 ? '' : 's'}
          </span>
        ) : null}
        {channel ? <span className="kintales__row-pip">{channel}</span> : null}
      </span>
    </>
  );

  // Static, non-interactive row unless a detail handler is wired: a live
  // no-op button is the dead-control anti-pattern (see ControlShell in
  // Buttons.tsx, and the identical convention in Sessions.tsx/Invoices.tsx).
  return (
    <li className="kintales__row">
      {onSelect ? (
        <button type="button" className="kintales__row-main" onClick={() => onSelect(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="kintales__row-main kintales__row-main--static">{body}</div>
      )}
    </li>
  );
}
