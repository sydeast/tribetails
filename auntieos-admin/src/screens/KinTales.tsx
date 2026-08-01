import { useMemo, useState } from 'react';
import { kinTaleMatchesSearch, kinTalesPageQuery, type KinTaleEntry } from '../api/kinTales';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
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
import { usePagedCollection } from '../lib/usePagedCollection';
import { asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, ServicePill, EmptyHint } from '../components/DenScreenKit';
import {
  ListToolbar,
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
  rangeStartIso,
  type DateRangeKey,
} from '../components/ListToolbar';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { NeedsTriageSection } from '../components/NeedsTriageSection';
import './KinTales.css';

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * the enumerated `KinTaleState` (the Sessions/Invoices `FILTERS` / AO-12
 * convention), never a negation of another bucket. A row whose status
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

/**
 * The selected window as it reads inside a sentence, e.g. "the last 7 days".
 * Derived from the toolbar's own preset list so the chip and the prose can never
 * name two different windows.
 */
function rangeLabel(range: DateRangeKey): string {
  const preset = DATE_RANGE_PRESETS.find((p) => p.key === range);
  if (preset === undefined || preset.days === null) return 'the archive';
  return `the ${preset.label.toLowerCase()}`;
}

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
  /**
   * Placeholder: the compose/create surface (`KinTaleCompose.tsx`) is a
   * separate, not-yet-ROUTED screen (it exists, it is just not yet mounted by
   * a real route the way `onSelect`'s detail view isn't either). Called with
   * no arguments to start a brand-new KinTale; the compose screen then asks
   * which Kin Care session it belongs to. Same "omit -> static, never a
   * live no-op" rule as `onSelect` and `FormSchemas.tsx`'s own `onNew`: see
   * the trailing button below.
   */
  onNew?: () => void;
}

/**
 * Admin KinTales list ("The Den · KinTales", nav slug `kintales` per
 * `lib/nav.ts`). Reads the flat `kin_care_reports` collection a PAGE at a time
 * through `usePagedCollection` (createdAt desc, windowed by the toolbar's date
 * preset), then classifies every row through the enumerated `kinTaleState`
 * (never by negation, see lib/kinTaleFormat.ts for the AO-12-style
 * rationale) for both the summary stat strip and the filter tabs.
 *
 * WHAT PHASE 4 CHANGED, AND WHY THE COPY CHANGED WITH IT. This screen used to
 * take a flat 200 newest rows and do everything client-side. Every number on it
 * was therefore a fact about a page nobody could see the edges of, and the
 * subtitle said "capped at 200", which named the cap without naming what fell
 * outside it. Now the fetch is a real date window with "Load more", which is
 * strictly more honest but only if the screen says which window it is in. So:
 *
 *  - the toolbar note states the window, the number of rows LOADED, and that
 *    search covers those rows rather than the collection,
 *  - the stat strip carries a line saying whether its three counts cover the
 *    whole window or only what is loaded so far, decided from `hasMore` rather
 *    than assumed,
 *  - the empty state names the window ("No KinTales in the last 7 days"), never
 *    the collection, because a quiet week is not an empty archive.
 *
 * SEARCH IS CLIENT-SIDE over the loaded rows, and that is stated on screen. The
 * archive's own KinTale search was client-side too; what is new is that the
 * scope is now visible instead of implied by an invisible cap.
 *
 * List/feed only: composing or editing a KinTale (KinTaleComposeScreen), the
 * per-report detail/comment-thread/share-link view (KinTaleReportScreen), and
 * template editing are separate surfaces. `onSelect` is this screen's only
 * hook into that later work.
 *
 * B2: the orphan-migration triage actions (assign/mark-duplicate/archive) DO
 * live here now, above the toolbar (`NeedsTriageSection`). They read and
 * write through their own one-shot callable client (`api/kinTaleTriage.ts`),
 * not this screen's windowed `usePagedCollection` stream: the orphans this
 * section surfaces are old migration rows, not recent ones, so the main
 * list's date-windowed, 25-per-page query is the wrong source for them (see
 * `NeedsTriageSection.tsx`'s own header for why).
 */
export function KinTales({ onSelect, onNew }: KinTalesProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRangeKey>(DEFAULT_DATE_RANGE);
  const [kinfolkId, setKinfolkId] = useState('');

  // Computed once per window choice, never per render: a boundary recreated
  // every render would churn the page and reset the cursor (see CollectionSpec's
  // "filter values must be stable" note, which the paged hook inherits).
  const startIso = useMemo(() => rangeStartIso(range, new Date()), [range]);
  const spec = useMemo(() => kinTalesPageQuery({ startIso, kinfolkId }), [startIso, kinfolkId]);
  const { state: rows, hasMore, more, loadMore } = usePagedCollection<KinTaleEntry>(spec);

  // The facet's options come from the household DIRECTORY, not from the loaded
  // KinTales. Deriving them from the page would offer only households that are
  // already on screen, which is the opposite of what the control is for.
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);
  const householdOptions = useMemo(
    () =>
      households.status === 'ready'
        ? households.data.map((kf) => ({ value: kf._id, label: kinfolkDisplayName(kf) }))
        : [],
    [households],
  );

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

  const sentCount = asyncScalar(rows, (data) =>
    data.filter((e) => kinTaleState(e.status ?? '') === 'sent').length,
  );
  const draftCount = asyncScalar(rows, (data) =>
    data.filter((e) => kinTaleState(e.status ?? '') === 'draft').length,
  );
  const failedCount = asyncScalar(rows, (data) =>
    data.filter((e) => kinTaleState(e.status ?? '') === 'failed').length,
  );

  const windowLabel = rangeLabel(range);
  const loaded = rows.status === 'ready' ? rows.data.length : null;
  const plural = loaded === 1 ? '' : 's';
  // "all 1 KinTale" is not a sentence anyone writes.
  const everyOne = loaded === 1 ? 'the 1' : `all ${String(loaded)}`;

  // THE HONESTY LINE. Two forms, because before the first page lands there is no
  // count to state and inventing one is the whole failure class this app refuses.
  const scopeNote =
    loaded === null
      ? `Search covers household and title, within ${windowLabel}.`
      : `Searching the ${String(loaded)} KinTale${plural} loaded from ${windowLabel}, by household and title.` +
        (hasMore ? ' Load more to reach further back.' : '');

  return (
    <div className="screen">
      {/* d1 / d2 / d3: the Den entrance stagger (styles/base.css). Three blocks
          in reading order, which is the shape the mocks were drawn around. */}
      <div className="d1">
        <DenScreenHeading
          kicker="The Den · KinTales"
          title="Every recap that goes"
          accentTail="home."
          subtitle="Every KinTale a Kinfolk receives after care, newest first."
          trailing={
            <PrimaryButton label="New KinTale" {...(onNew ? { onClick: () => onNew() } : {})} leading={<PlusGlyph />} />
          }
        />
        <NeedsTriageSection
          kinfolk={households}
          candidateReports={rows.status === 'ready' ? rows.data : []}
        />
      </div>

      <div className="d2">
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

        {/* What the three numbers above actually count. They are a fact about the
            rows that have been LOADED, which is the whole window only once the
            cursor is exhausted, so the line reads off `hasMore` rather than
            guessing from the page size. */}
        {loaded !== null && (
          <p className="kintales__stats-note">
            {hasMore
              ? `These counts cover the ${String(loaded)} KinTale${plural} loaded so far, not all of ${windowLabel}.`
              : `These counts cover ${everyOne} KinTale${plural} in ${windowLabel}.`}
          </p>
        )}
      </div>

      <DenPanel title="KinTales" subtitle="Newest first, a page at a time." className="d3">
        <ListToolbar
          label="Filter KinTales"
          search={search}
          onSearchChange={setSearch}
          searchLabel="Search KinTales"
          range={range}
          onRangeChange={setRange}
          facets={[
            {
              id: 'household',
              label: 'Household',
              value: kinfolkId,
              onChange: setKinfolkId,
              options: householdOptions,
            },
          ]}
          note={
            <>
              {scopeNote}
              {/* A facet whose options failed to load is a control that silently
                  offers nothing. Say so beside it rather than rendering an
                  empty dropdown that looks like an empty directory. */}
              {households.status === 'error' && (
                <span className="kintales__facet-error">
                  {' '}
                  Household list unavailable: {households.message}
                </span>
              )}
            </>
          }
        />

        <AsyncRegion
          state={rows}
          what="KinTales"
          isEmpty={(data) => data.length === 0}
          loading={<p className="kintales__hint">Loading KinTales…</p>}
          empty={<EmptyHint>{`No KinTales in ${windowLabel}.`}</EmptyHint>}
        >
          {(data) => {
            // Non-null: FILTERS lists all four FilterKey members above, and
            // `filter` only ever holds a key set via setFilter(f.key) from
            // that same array (Sessions.tsx's identical .find()! comment).
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = data
              .filter((e) => activeFilter.test(kinTaleState(e.status ?? '')))
              .filter((e) => kinTaleMatchesSearch(e, search));

            return (
              <>
                <div className="kintales__tabs" role="tablist" aria-label="Filter KinTales">
                  {FILTERS.map((f, index) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'kintales__tab kintales__tab--active' : 'kintales__tab'}
                      onClick={() => setFilter(f.key)}
                      {...getTabProps(index)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {visible.length === 0 ? (
                  <EmptyHint>
                    {`Nothing in the loaded KinTales matches this filter.${
                      hasMore ? ' Load more to reach further back.' : ''
                    }`}
                  </EmptyHint>
                ) : (
                  <ul className="kintales__list">
                    {visible.map((entry) => (
                      <KinTaleRow key={entry._id} entry={entry} onSelect={onSelect} />
                    ))}
                  </ul>
                )}

                {/* A FAILED PAGE IS NOT A FAILED LIST. The rows above stayed
                    exactly where they were: the hook keeps them, keeps the
                    cursor, and reports the failure here instead of blanking a
                    list the operator can already read. That is why this is an
                    inline alert and not the AsyncRegion error above. */}
                {hasMore && (
                  <div className="kintales__more">
                    <GhostButton
                      label={more.status === 'loading' ? 'Loading more…' : 'Load more'}
                      onClick={loadMore}
                      disabled={more.status === 'loading'}
                    />
                    {more.status === 'error' && (
                      <p className="kintales__more-error" role="alert">
                        Couldn&rsquo;t load more KinTales. {more.message} The{' '}
                        {String(data.length)} already listed are unaffected.
                        {more.retry && (
                          <button type="button" className="async-retry" onClick={more.retry}>
                            Retry
                          </button>
                        )}
                      </p>
                    )}
                  </div>
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
  const state = kinTaleState(entry.status ?? '');
  const info = kinTaleStateInfo(state);
  const household = kinTaleHousehold(entry.kinfolkName ?? '');
  const headline = kinTaleHeadline(entry.title ?? '', entry.bodyCopy ?? '');
  const when = kinTaleWhen({
    visitDate: entry.visitDate ?? '',
    arrivedAt: entry.arrivedAt ?? '',
    sentAt: entry.sentAt ?? '',
    createdAt: entry.createdAt ?? '',
  });
  // Every read below is defaulted. KinTaleEntry is a CAST over raw Firestore
  // data, not a validation of it: a real kin_care_reports doc can be missing any
  // of these, and reading one blind blanked the WHOLE KinTales page through the
  // error boundary (2026-07-20).
  const mediaCount = (entry.mediaFileIds ?? []).length;
  const kinCount = (entry.kinIds ?? []).length;
  const sentVia = entry.sentVia ?? '';
  const serviceType = entry.serviceType ?? '';
  const authorDisplayName = entry.authorDisplayName ?? '';
  // Only a SENT (or otherwise dispatched) row carries a real channel; a
  // draft's blank sentVia would otherwise read as the misleading "imported"
  // sentViaLabel default (see lib/kinTaleFormat.ts#sentViaLabel's doc comment).
  const channel = sentVia.trim() !== '' ? sentViaLabel(sentVia) : null;

  const body = (
    <>
      <span className="kintales__row-head">
        <span className="kintales__row-name">{household}</span>
        {serviceType.trim() !== '' ? <ServicePill serviceType={serviceType} /> : null}
        <span className={`kintales__chip kintales__chip--${info.cssClass}`}>{info.chipLabel}</span>
      </span>

      <span className="kintales__row-headline">{headline}</span>

      <span className="kintales__row-meta">
        <span className="kintales__row-when">{when}</span>
        {authorDisplayName.trim() !== '' ? (
          <span className="kintales__row-author">by {authorDisplayName}</span>
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
        <button type="button" className="kintales__row-main lift" onClick={() => onSelect(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="kintales__row-main kintales__row-main--static">{body}</div>
      )}
    </li>
  );
}
