import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { kinTaleMatchesSearch, kinTalesPageQuery, type KinTaleEntry } from '../api/kinTales';
import {
  GENERATED_DRAFTS_QUERY,
  GENERATED_DRAFTS_MAX,
  type GeneratedDraftRow,
} from '../api/drafts';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import {
  kinTaleHousehold,
  kinTaleState,
  kinTaleStateInfo,
  kinTaleWhen,
  sentViaLabel,
  type KinTaleState,
} from '../lib/kinTaleFormat';
import { kinTaleListRows, type KinTaleListRow } from '../lib/kinTaleList';
import { type Async } from '../lib/async';
import { createdAtProvenanceNote } from '../lib/createdAtProvenance';
import { useCollection } from '../lib/firestore';
import { usePagedCollection } from '../lib/usePagedCollection';
import {
  DenScreenHeading,
  DenPanel,
  StatusPill,
  EmptyHint,
  type DenTone,
} from '../components/DenScreenKit';
import { IconTile } from '../components/IconTile';
import { LoadingRow } from '../components/LoadingRow';
import {
  ListToolbar,
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
  rangeStartIso,
  type DateRangeKey,
} from '../components/ListToolbar';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton } from '../components/Buttons';
import { NeedsTriageSection } from '../components/NeedsTriageSection';
import './KinTales.css';

// The logs mock (`ui-ideas/auntieos-kintale-logs-2026-05-27.html`) puts a
// Lucide line icon on the heading tile, on every row's status tile and on every
// meta pip. No icon package is installed here (the Inbox.tsx / NavGlyphs.tsx
// precedent), so the paths are inline: 24-unit viewBox, `currentColor` stroke,
// `aria-hidden`. Keyed by the Lucide name the mock's comments use.
type GlyphKey = 'clipboardList' | 'settings' | 'mailCheck' | 'triangleAlert' | 'fileText' | 'image' | 'send';

const GLYPH_PATHS: Record<GlyphKey, string> = {
  clipboardList:
    'M8 2h8v4H8zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  mailCheck:
    'M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8M22 7l-10 5L2 7M16 19l2 2 4-4',
  triangleAlert:
    'm10.29 3.86-8.18 14A2 2 0 0 0 3.84 21h16.32a2 2 0 0 0 1.73-3.14l-8.18-14a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  fileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm10 6-5-5L5 21',
  send: 'm22 2-7 20-4-9-9-4ZM22 2 11 13',
};

function Glyph({ name, size = 14 }: { name: GlyphKey; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPH_PATHS[name]} />
    </svg>
  );
}

/**
 * The mock's bucket groups, in the order it draws them: "Needs another look"
 * (failed), "Drafts", "Sent". Every predicate is a POSITIVE membership test
 * against the enumerated `KinTaleState` (the Sessions/Invoices `FILTERS` /
 * AO-12 convention), never a negation of another bucket. A row whose status
 * matches none of the three known codes (`'unknown'`) has no bucket in the
 * mock, and folding it into Drafts by negation is exactly the fabricated-state
 * bug AO-12 names, so it gets a fourth group, last, and is never hidden.
 *
 * Each bucket also carries the row's tone and status glyph: the mock tints the
 * status tile and the pill from one swatch per state, and this is the one place
 * that swatch is named.
 */
type BucketKey = 'failed' | 'draft' | 'sent' | 'unknown';

interface BucketDef {
  key: BucketKey;
  label: string;
  test: (state: KinTaleState) => boolean;
  tone: DenTone;
  glyph: GlyphKey;
}

const BUCKETS: readonly BucketDef[] = [
  { key: 'failed', label: 'Needs another look', test: (s) => s === 'failed', tone: 'error', glyph: 'triangleAlert' },
  { key: 'draft', label: 'Drafts', test: (s) => s === 'draft', tone: 'neutral', glyph: 'fileText' },
  { key: 'sent', label: 'Sent', test: (s) => s === 'sent', tone: 'success', glyph: 'mailCheck' },
  { key: 'unknown', label: 'Unknown status', test: (s) => s === 'unknown', tone: 'warning', glyph: 'fileText' },
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
   * Opens the single-report detail view (`KinTaleDetail.tsx`: compose, comment
   * thread, share link, "view as kinfolk"). This screen exists and is wired by
   * `routes/KinTalesView.tsx`. The handler is optional here so the component
   * stays reusable in contexts where selection is not yet hooked up. See
   * `KinTaleRow`: when unwired the row renders a STATIC <div>, not a <button>.
   * A handler-less <button> still carries the implicit ARIA button role and is
   * a focusable dead control, so the row only becomes a real <button> once a
   * detail route wires the handler.
   */
  onSelect?: (kinTaleId: string) => void;
}

/**
 * Admin KinTales list ("The Den · KinTales", nav slug `kintales` per
 * `lib/nav.ts`). Reads the flat `kin_care_reports` collection a PAGE at a time
 * through `usePagedCollection` (createdAt desc, windowed by the toolbar's date
 * preset), then classifies every row through the enumerated `kinTaleState`
 * (never by negation, see lib/kinTaleFormat.ts for the AO-12-style
 * rationale) for both the summary stat strip and the filter tabs.
 *
 * ── IT READS TWO COLLECTIONS, BECAUSE A KINTALE LIVES IN TWO ────────────────
 * A KinTale in DRAFT state is not in `kin_care_reports`. The generator writes
 * it to `generated_drafts`, which is what Home's "KinTales pending" panel has
 * always read. This screen read only the first, so its own Drafts bucket and
 * its own Drafts tab reported 0 forever while Home, on the same session, listed
 * drafts, and the empty state claimed "No KinTales in the last 30 days" about a
 * window that had them. Operator ruling, 2026-08-04, verbatim: "generated
 * drafts are just drafts of the kintales". So both are read here and joined by
 * `lib/kinTaleList.ts`, and the two surfaces now share one query object
 * (`GENERATED_DRAFTS_QUERY`), which is also one Firestore Watch target.
 *
 * The join's limits are REAL and are therefore stated on screen rather than
 * hidden: the drafts side is a bounded 50-row listener, not a pager, so its
 * window and household facet are applied client-side and the counts say when
 * that cap has been reached. A failed or in-flight drafts read never silently
 * becomes "Drafts 0"; it is named beside the toolbar, because a confident zero
 * over an unread collection is precisely the defect this screen was reported
 * for.
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
export function KinTales({ onSelect }: KinTalesProps) {
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRangeKey>(DEFAULT_DATE_RANGE);
  const [kinfolkId, setKinfolkId] = useState('');

  // Computed once per window choice, never per render: a boundary recreated
  // every render would churn the page and reset the cursor (see CollectionSpec's
  // "filter values must be stable" note, which the paged hook inherits).
  const startIso = useMemo(() => rangeStartIso(range, new Date()), [range]);
  const spec = useMemo(() => kinTalesPageQuery({ startIso, kinfolkId }), [startIso, kinfolkId]);
  const { state: reports, hasMore, more, loadMore } = usePagedCollection<KinTaleEntry>(spec);

  // The DRAFT half of the same entity. Deliberately the identical spec object
  // Home's widget uses, so the two surfaces share one Watch target and can
  // never report two different draft sets (see api/drafts.ts).
  const drafts = useCollection<GeneratedDraftRow>(GENERATED_DRAFTS_QUERY);

  // The joined list. `reports` decides the region's status: it is the paged,
  // server-windowed side, and a first-page failure there means the list really
  // is unknown. A drafts failure does NOT blank a readable report list; it is
  // reported beside the toolbar and in the counts note instead, the same
  // "a failed facet is not a failed list" split the household select already uses.
  const rows: Async<KinTaleListRow[]> = useMemo(() => {
    if (reports.status !== 'ready') return reports;
    return {
      status: 'ready',
      data: kinTaleListRows(reports.data, drafts.status === 'ready' ? drafts.data : [], {
        startIso,
        kinfolkId,
      }),
    };
  }, [reports, drafts, startIso, kinfolkId]);

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

  // The rows the list is actually showing, computed ONCE here rather than inside
  // the AsyncRegion render prop, because the count chip beside the toolbar and
  // the buckets below have to be two views of one number. Null, never zero,
  // while the first page is in flight or has failed.
  const visible = useMemo(
    () => (rows.status === 'ready' ? rows.data.filter((e) => kinTaleMatchesSearch(e, search)) : null),
    [rows, search],
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

  // THE RESULT-COUNT CHIP (the mock's third SUGGESTION, approved 2026-08-09).
  //
  // Both forms end in "loaded", and that word is the whole point: this screen
  // pages a date window, so a bare "12" beside a list whose cursor is still open
  // would describe a page and read as an archive. The toolbar note directly
  // beneath names the window those rows came from.
  //
  // Null while the first page is in flight or has failed, because a chip reading
  // "0 loaded" over a collection nobody has managed to read yet is the confident
  // zero this app refuses. "0 of 2 loaded" after a search is a different claim
  // and an honest one: the denominator is known.
  //
  // The two forms are chosen by whether anything was actually excluded, not by
  // whether the box has text in it, so a search that happens to match every
  // loaded row reads as the plain count rather than as the noise "2 of 2".
  // Android's `resultCountLabel` decides it the same way, off the same rule.
  const countLabel =
    loaded === null || visible === null
      ? null
      : visible.length === loaded
        ? `${String(loaded)} loaded`
        : `${String(visible.length)} of ${String(loaded)} loaded`;

  // WHAT THE DRAFT HALF OF EVERY NUMBER ABOVE IS WORTH. The drafts stream is a
  // capped listener rather than a pager, so three different things can be true
  // about it and each has to be said out loud rather than folded into a
  // confident count: it has not arrived, it failed, or it came back full and is
  // therefore a page of the drafts rather than all of them.
  //
  // Its own line rather than a clause on the one above, because that one only
  // renders once the first page has landed and a failed drafts read has to be
  // visible before then too.
  const draftsNote =
    drafts.status === 'loading'
      ? 'Drafts are still loading, so the Drafts count is not final yet.'
      : drafts.status === 'error'
        ? `Drafts could not be loaded (${drafts.message}), so the Drafts count is missing them.`
        : drafts.data.length === GENERATED_DRAFTS_MAX
          ? `Drafts are the newest ${String(GENERATED_DRAFTS_MAX)} only; older drafts are not counted.`
          : '';

  return (
    <div className="screen kintales">
      {/* d1 / d2 / d3: the Den entrance stagger (styles/base.css). Three blocks
          in reading order, which is the shape the mock is drawn in: the head,
          the search row, then the triage queue and the buckets. */}
      <div className="d1">
        <DenScreenHeading
          kicker="The Den · KinTales"
          title="KinTales"
          subtitle="Every recap that goes home to a Kinfolk after care, and every draft still waiting to go. Newest first."
          // The mock's `.head .ico`: the ClipboardList tile in the orange wash,
          // 42px, before the title block.
          leading={<IconTile icon={<Glyph name="clipboardList" size={20} />} size={42} tone="orange" />}
          // The mock's one head control. There is no "New KinTale" here: a
          // KinTale is only ever started from a Kin Care (operator ruling
          // 2026-09-10, #676: "KinTales can only be created from KinCares"),
          // which is Auntie Time's "Complete KinTale" (#703). The mock never
          // drew one either.
          trailing={
            <Link to="/kintale-templates" className="auntie-btn auntie-btn--ghost">
              <span className="auntie-btn__leading" aria-hidden="true">
                <Glyph name="settings" />
              </span>
              <span className="auntie-btn__label">Edit templates</span>
            </Link>
          }
        />
      </div>

      {/* The mock's search row sits on the ground under the head, with the
          result chip beside it. The range and household controls ride along:
          the list is a date window, and the chip's "loaded" is only honest
          beside the control that chose the window. */}
      <div className="d2 kintales__toolbar">
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
              {countLabel !== null && (
                <span className="kintales__count" role="status">
                  {countLabel}
                </span>
              )}
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

        {/* What the bucket counts below actually count. They are a fact about the
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

        {draftsNote !== '' && (
          <p className="kintales__stats-note" {...(drafts.status === 'error' ? { role: 'alert' } : {})}>
            {draftsNote}
          </p>
        )}
      </div>

      <div className="d3 kintales__body">
        {/* REPORTS ONLY, never the joined list. This section triages orphaned
            `kin_care_reports` migration rows through callables keyed on that
            collection's document ids; handing it a `generated_drafts` row would
            offer an Assign/Archive action against a document those callables
            cannot address. */}
        <NeedsTriageSection
          kinfolk={households}
          candidateReports={reports.status === 'ready' ? reports.data : []}
        />

        <AsyncRegion
          state={rows}
          what="KinTales"
          isEmpty={(data) => data.length === 0}
          loading={<LoadingRow label="Loading KinTales…" className="kintales__hint" />}
          empty={<EmptyHint>{`No KinTales in ${windowLabel}.`}</EmptyHint>}
        >
          {(data) => {
            // Computed at the top of the screen, off this same `rows` state, so
            // the count chip and these buckets are one number. This branch only
            // runs while that state is ready, which is exactly when it is
            // non-null; the fallback keeps that a type fact rather than a
            // belief.
            const shown = visible ?? [];

            return (
              <>
                {shown.length === 0 ? (
                  <EmptyHint>
                    {`Nothing in the loaded KinTales matches this search.${
                      hasMore ? ' Load more to reach further back.' : ''
                    }`}
                  </EmptyHint>
                ) : (
                  // The mock's three bucket groups, in its order, each a panel
                  // headed by the bucket label with the count as the mono note
                  // on the rule. A bucket with nothing in it is not drawn: an
                  // empty "Needs another look" panel would read as a warning
                  // about nothing.
                  BUCKETS.map((bucket) => {
                    const members = shown.filter((e) => bucket.test(kinTaleState(e.status ?? '')));
                    if (members.length === 0) return null;
                    return (
                      <DenPanel
                        key={bucket.key}
                        title={bucket.label}
                        meta={String(members.length)}
                        className="kintales__bucket"
                      >
                        <ul className="kintales__list" aria-label={bucket.label}>
                          {members.map((entry) => (
                            <KinTaleRow key={entry._id} entry={entry} bucket={bucket} onSelect={onSelect} />
                          ))}
                        </ul>
                      </DenPanel>
                    );
                  })
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
      </div>
    </div>
  );
}

interface KinTaleRowProps {
  entry: KinTaleListRow;
  bucket: BucketDef;
  onSelect?: ((kinTaleId: string) => void) | undefined;
}

/**
 * The mock's `.row`: a 36px status tile in the bucket's tone, then the
 * household in Fraunces, the "service · when" line under it, then the mono
 * pips, and the status pill at the right edge. No headline line: the mock's
 * row carries none and neither does Android's, so the tale's title is read on
 * the detail screen rather than guessed from a clamp here.
 */
function KinTaleRow({ entry, bucket, onSelect }: KinTaleRowProps) {
  const state = kinTaleState(entry.status ?? '');
  const info = kinTaleStateInfo(state);
  const rawName = (entry.kinfolkName ?? '').trim();
  const household = kinTaleHousehold(rawName);
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
  const serviceType = (entry.serviceType ?? '').trim();
  const authorDisplayName = (entry.authorDisplayName ?? '').trim();
  // Only a SENT (or otherwise dispatched) row carries a real channel; a
  // draft's blank sentVia would otherwise read as the misleading "imported"
  // sentViaLabel default (see lib/kinTaleFormat.ts#sentViaLabel's doc comment).
  const channel = sentVia.trim() !== '' ? sentViaLabel(sentVia) : null;
  // `generated_drafts` only. That collection holds drafts of every generator
  // output, not just visit recaps, so the row names which kind it is rather
  // than letting an sms draft read as a visit recap. Blank for a report row.
  const draftType = entry.draftType ?? '';
  // WHY THIS ROW IS WHERE IT IS. The list is ordered `createdAt desc`, and on a
  // handful of imported rows that date is the day they were IMPORTED rather
  // than the day they were written, because nothing recoverable said otherwise
  // (operator's ruling 2026-08-04; see lib/createdAtProvenance.ts). Unmarked,
  // such a row is indistinguishable from one genuinely created that day, which
  // is the same defect one field along. Blank for every row whose date can be
  // taken at face value.
  const provenanceNote = createdAtProvenanceNote(entry.createdAtSource);

  const body = (
    <>
      <IconTile icon={<Glyph name={bucket.glyph} size={16} />} size={36} tone={bucket.tone} className="kintales__tile" />
      <span className="kintales__row-text">
        {/* The mock's `.nm.unnamed`: the fallback reads italic and dim, so a
            blank household never passes for a household called that. */}
        <span className={rawName === '' ? 'kintales__row-name kintales__row-name--unnamed' : 'kintales__row-name'}>
          {household}
        </span>
        <span className="kintales__row-submeta">
          {serviceType !== '' && (
            <>
              <span>{serviceType}</span>
              <span className="kintales__dot" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span className="kintales__row-when">{when}</span>
        </span>
        <span className="kintales__row-pips">
          {kinCount > 0 ? <span className="kintales__row-pip">{kinCount} kin</span> : null}
          {mediaCount > 0 ? (
            <span className="kintales__row-pip">
              <Glyph name="image" size={11} /> {mediaCount} photo{mediaCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {channel ? (
            <span className="kintales__row-pip">
              <Glyph name="send" size={11} /> {channel}
            </span>
          ) : null}
          {authorDisplayName !== '' ? <span className="kintales__row-pip">by {authorDisplayName}</span> : null}
          {draftType !== '' ? <span className="kintales__row-pip">{draftType}</span> : null}
          {provenanceNote !== '' ? (
            <span className="kintales__row-pip kintales__row-pip--provenance">{provenanceNote}</span>
          ) : null}
        </span>
      </span>
      <StatusPill label={info.chipLabel} tone={bucket.tone} size="compact" />
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
