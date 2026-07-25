import { useMemo, useState } from 'react';
import {
  invoiceMatchesSearch,
  invoicesPageQuery,
  isArchivedInvoice,
  normalizeInvoice,
  type InvoiceEntry,
} from '../api/invoices';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import {
  formatUsd,
  humanizeDate,
  invoiceState,
  invoiceStateInfo,
  invoicePartialPayment,
  type InvoicePartialPayment,
  isInvoiceOverdue,
  localDateIso,
  type InvoiceState,
} from '../lib/invoiceFormat';
import { useCollection } from '../lib/firestore';
import { usePagedCollection } from '../lib/usePagedCollection';
import { asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import {
  ListToolbar,
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
  rangeStartIso,
  type DateRangeKey,
} from '../components/ListToolbar';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { InvoiceDetail } from '../components/InvoiceDetail';
import { InvoiceCreate, type InvoiceCreateMode } from './InvoiceCreate';
import './Invoices.css';

/**
 * The Den filter tabs. Every predicate below is a POSITIVE membership test
 * against the enumerated `InvoiceState` (or the derived overdue flag), never
 * a negation of another bucket, per the AO-12 fix in lib/invoiceFormat.ts.
 * "Open" and "Overdue" overlap on purpose (an overdue invoice is still open):
 * that mirrors the wasm's own Unpaid/Overdue tabs, which never excluded each
 * other either.
 */
type FilterKey = 'all' | 'open' | 'overdue' | 'paid' | 'draft' | 'quote' | 'credit';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (state: InvoiceState, overdue: boolean) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'open', label: 'Open', test: (s) => s === 'open' },
  { key: 'overdue', label: 'Overdue', test: (_s, overdue) => overdue },
  { key: 'paid', label: 'Paid', test: (s) => s === 'paid' },
  { key: 'draft', label: 'Draft', test: (s) => s === 'draft' },
  { key: 'quote', label: 'Quote', test: (s) => s === 'quote' },
  { key: 'credit', label: 'Credit', test: (s) => s === 'credit' || s === 'redeemed' },
];

/**
 * The archive facet. Blank is the toolbar's own "all" value, so the three
 * states are: hide archived (the default), show them alongside, show only them.
 *
 * Applied CLIENT-SIDE over the loaded page, deliberately. See
 * `InvoiceEntry.archivedAt`: nothing writes the field yet, and Firestore's
 * `== null` matches only documents that HAVE it, so a server-side exclusion
 * today would return every invoice as "archived" by omission, silently. A
 * presence check over the loaded rows is the same rule with none of that.
 */
type ArchivedMode = 'hide' | '' | 'only';

const ARCHIVED_OPTIONS = [
  { value: 'hide', label: 'Hidden' },
  { value: 'only', label: 'Only archived' },
] as const;

function archivedAllows(mode: ArchivedMode, entry: InvoiceEntry): boolean {
  if (mode === 'hide') return !isArchivedInvoice(entry);
  if (mode === 'only') return isArchivedInvoice(entry);
  return true;
}

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

/** One row's derived display facts, computed once per render pass. */
interface RowView {
  entry: InvoiceEntry;
  state: InvoiceState;
  overdue: boolean;
  /** Non-null when money has come in that does not cover the invoice. */
  partial: InvoicePartialPayment | null;
}

function rowViewsFor(rows: InvoiceEntry[], todayIso: string): RowView[] {
  // Normalize BEFORE anything reads a field. InvoiceEntry is a cast over raw
  // Firestore data, not a guarantee, and real docs ARE missing keys it declares.
  return rows.map(normalizeInvoice).map((entry) => {
    const state = invoiceState({
      status: entry.status,
      amountDue: entry.amountDue,
      total: entry.total,
      creditRedeemed: entry.creditRedeemedAt !== undefined,
    });
    return {
      entry,
      state,
      overdue: isInvoiceOverdue(state, entry.dueDate, todayIso),
      // Like `overdue`, a display refinement of `open` rather than a state of
      // its own, so it changes the chip and never the actions.
      partial: invoicePartialPayment(state, entry),
    };
  });
}

/**
 * Admin Invoices list ("The Den · Invoices"). Reads the flat `invoices`
 * collection a PAGE at a time through `usePagedCollection` (invoice `date` desc,
 * windowed by the toolbar's date preset), then classifies every row through the
 * enumerated `invoiceState` (never by negation, see lib/invoiceFormat.ts for
 * the AO-12 rationale) for both the summary stat strip and the filter tabs.
 *
 * WHAT PHASE 4 CHANGED. The date window, the household facet and the archive
 * facet are SERVER-side or list-wide; the status tabs and the search box narrow
 * what is already loaded. They compose in that order, and the screen says which
 * is which, because the difference decides what a count means:
 *
 *  - the toolbar note states the window, how many invoices are LOADED, and that
 *    search runs over those rather than over the books,
 *  - the stat strip carries a line saying whether Outstanding / Billed / Overdue
 *    cover the whole window or only what is loaded so far. "Billed total" in
 *    particular reads like a business fact, and across a partial page it is not
 *    one,
 *  - the empty state names the window, never the books.
 *
 * ARCHIVED INVOICES ARE EXCLUDED BY DEFAULT, by the presence of `archivedAt`,
 * with a facet to include or isolate them. Nothing writes that field until Task
 * 5.1; until then the exclusion is a no-op that costs nothing and needs no
 * second code path later.
 *
 * InvoiceDetail (row actions: reminder/mark-paid/receipt) and InvoiceCreate
 * (new invoice/new quote) are now BUILT. Unlike the FormSchemas editor (a
 * separate ROUTE the router must wire in later), both are in-screen modals,
 * so this screen owns their open/close state itself rather than exposing an
 * `onSelect` placeholder prop for a router to fill in. That is the one
 * substantive change from the read-only version of this screen: the prop is
 * gone, every row is now a real, always-interactive button, and the
 * `onSelect`-absent "static row" branch (the dead-control guard that made
 * sense while there was nothing to select INTO) is retired along with it.
 */
export interface InvoicesProps {
  /**
   * Opens this invoice's detail on mount. Set by the router from
   * `/invoices?invoiceId=<id>`, which is where the Notifications feed's "Open"
   * lands for an invoice notification. An id that is not in the streamed page
   * simply opens nothing, the same as selecting a row that scrolled out.
   */
  initialInvoiceId?: string;
  /**
   * Opens the QUOTE composer on mount, pre-filled with this household. Set by
   * the router from `/invoices?composeQuoteForKinfolkId=<id>`, the destination
   * of the Notifications feed's "Create quote". The archive threaded the same
   * seed through its App shell under this exact name; here it rides the URL, so
   * a seeded composer survives a reload and is linkable.
   */
  composeQuoteForKinfolkId?: string;
}
/** The composer's open state: which mode, and the household it was seeded with. */
interface CreatingState {
  mode: InvoiceCreateMode;
  seedKinfolkId?: string;
}
export function Invoices({ initialInvoiceId, composeQuoteForKinfolkId }: InvoicesProps = {}) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRangeKey>(DEFAULT_DATE_RANGE);
  const [kinfolkId, setKinfolkId] = useState('');
  const [archived, setArchived] = useState<ArchivedMode>('hide');
  const [selectedId, setSelectedId] = useState<string | null>(initialInvoiceId ?? null);
  // Seeded only on mount: reopening the composer from the "New quote" button
  // later must start blank, not silently re-seed the household from a stale URL.
  const [creating, setCreating] = useState<CreatingState | null>(
    composeQuoteForKinfolkId ? { mode: 'quote', seedKinfolkId: composeQuoteForKinfolkId } : null,
  );

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

  // Computed once per render, not per keystroke/tick: today doesn't change
  // mid-session, and recomputing on every render would be a stable value
  // recreated every time regardless, this just names that stability.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  // The window's lower bound as a DAY, because `invoices.date` is a `YYYY-MM-DD`
  // day string rather than an instant (see `invoicesPageQuery`). Truncating the
  // instant to its day makes the boundary day itself fall inside the window,
  // which is what "last 7 days" means to the person reading it.
  const startDay = useMemo(() => rangeStartIso(range, new Date())?.slice(0, 10) ?? null, [range]);
  const spec = useMemo(() => invoicesPageQuery({ startDay, kinfolkId }), [startDay, kinfolkId]);
  const { state: rows, hasMore, more, loadMore } = usePagedCollection<InvoiceEntry>(spec);

  // The facet's options come from the household DIRECTORY rather than from the
  // loaded invoices: a facet built from the page can only offer households that
  // are already visible, which is the opposite of what the control is for.
  const households = useCollection<Kinfolk>(KINFOLK_QUERY);
  const householdOptions = useMemo(
    () =>
      households.status === 'ready'
        ? households.data.map((kf) => ({ value: kf._id, label: kinfolkDisplayName(kf) }))
        : [],
    [households],
  );

  const selected =
    selectedId && rows.status === 'ready' ? rows.data.find((r) => r._id === selectedId) : undefined;

  // THE DEEP LINK CAN NOW MISS. `/invoices?invoiceId=<id>` is where the
  // Notifications feed's "Open" lands, and it resolves against the rows this
  // screen has loaded. That used to be the 200 newest and is now one page of one
  // date window, so an invoice dated outside it opens NOTHING. Silently opening
  // nothing after a click is the dead-control failure in another costume, so the
  // screen says which of its own filters is in the way.
  const deepLinkMissed =
    initialInvoiceId !== undefined &&
    selectedId === initialInvoiceId &&
    rows.status === 'ready' &&
    selected === undefined;

  // Classify every row exactly once (memoized), then project the stat strip AND
  // the list off the SAME views, rather than re-walking the page per stat.
  // asyncScalar's projector runs only in the `ready` branch, where `views` holds
  // the ready data; AsyncRegion likewise renders its children only when ready.
  const views = useMemo(
    () => (rows.status === 'ready' ? rowViewsFor(rows.data, todayIso) : []),
    [rows, todayIso],
  );

  // The archive facet is list-wide, not a tab: it decides which rows this screen
  // is ABOUT, so the stat strip is projected off the survivors. An archived
  // invoice counted into Outstanding would be money the operator has already
  // decided to stop chasing.
  const inScope = useMemo(
    () => views.filter((v) => archivedAllows(archived, v.entry)),
    [views, archived],
  );
  const archivedHidden = views.length - inScope.length;

  const outstandingTotal = asyncScalar(rows, () =>
    inScope.filter((r) => r.state === 'open').reduce((sum, r) => sum + r.entry.amountDue, 0),
  );
  const billedTotal = asyncScalar(rows, () => inScope.reduce((sum, r) => sum + r.entry.total, 0));
  const overdueCount = asyncScalar(rows, () => inScope.filter((r) => r.overdue).length);

  const windowLabel = rangeLabel(range);
  const loaded = rows.status === 'ready' ? inScope.length : null;
  const plural = loaded === 1 ? '' : 's';
  // "all 1 invoice" is not a sentence anyone writes.
  const everyOne = loaded === 1 ? 'the 1' : `all ${String(loaded)}`;

  // Built as single strings rather than as adjacent JSX expressions: each of
  // these is ONE sentence to the operator, and it should be one text node to a
  // screen reader too.
  const statsNote =
    loaded === null
      ? null
      : (hasMore
          ? `These totals cover the ${String(loaded)} invoice${plural} loaded so far, not all of ${windowLabel}.`
          : `These totals cover ${everyOne} invoice${plural} in ${windowLabel}.`) +
        (archivedHidden > 0
          ? ` ${String(archivedHidden)} archived invoice${archivedHidden === 1 ? '' : 's'} excluded.`
          : '');

  // THE HONESTY LINE. What the search box actually reaches, plus the one cost of
  // windowing on the free-text `date` field, said out loud rather than left as a
  // row that quietly never appears.
  const scopeNote =
    (loaded === null
      ? `Search covers invoice number, household and client, within ${windowLabel}.`
      : `Searching the ${String(loaded)} invoice${plural} loaded from ${windowLabel}, by number, household and client.` +
        (hasMore ? ' Load more to reach further back.' : '')) +
    (range === 'all' ? '' : ' Invoices with no date appear only under All (archive).');

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Invoices"
        title="Getting"
        accentTail="paid."
        subtitle="Every invoice in the window you choose, by invoice date, newest first."
        trailing={
          <div className="invoices__new-actions">
            <PrimaryButton label="New quote" onClick={() => setCreating({ mode: 'quote' })} />
            <PrimaryButton label="New invoice" onClick={() => setCreating({ mode: 'invoice' })} />
          </div>
        }
      />

      <div className="invoices__summary">
        <StatCard
          label="Outstanding"
          value={outstandingTotal}
          trend="open invoices"
          tone={outstandingTotal.kind === 'value' && outstandingTotal.value > 0 ? 'orange' : 'success'}
          feature={outstandingTotal.kind === 'value' && outstandingTotal.value > 0}
          formatValue={formatUsd}
        />
        <StatCard label="Billed total" value={billedTotal} trend="invoiced in this window" tone="teal" formatValue={formatUsd} />
        <StatCard
          label="Overdue"
          value={overdueCount}
          trend="past their due date"
          tone={overdueCount.kind === 'value' && overdueCount.value > 0 ? 'error' : 'muted'}
          feature={overdueCount.kind === 'value' && overdueCount.value > 0}
        />
      </div>

      {/* What the three totals above actually cover. "Billed total" especially:
          summed across a partial page it reads like a book figure and is not
          one, so the line reads off `hasMore` rather than assuming a full page. */}
      {statsNote !== null && <p className="invoices__stats-note">{statsNote}</p>}

      <DenPanel title="Invoices" subtitle="By invoice date, newest first, a page at a time.">
        <ListToolbar
          label="Filter invoices"
          search={search}
          onSearchChange={setSearch}
          searchLabel="Search invoices"
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
            {
              id: 'archived',
              label: 'Archived',
              value: archived,
              onChange: (value) => setArchived(value as ArchivedMode),
              options: ARCHIVED_OPTIONS,
              allLabel: 'Included',
            },
          ]}
          note={
            <>
              {scopeNote}
              {households.status === 'error' && (
                <span className="invoices__facet-error">
                  {' '}
                  Household list unavailable: {households.message}
                </span>
              )}
            </>
          }
        />

        {deepLinkMissed && (
          <p className="invoices__deep-link-miss" role="alert">
            {`The invoice this link points at is not in ${windowLabel}. Try All (archive), clear the household filter, or Load more.`}
          </p>
        )}

        <AsyncRegion
          state={rows}
          what="invoices"
          isEmpty={(data) => data.length === 0}
          loading={<p className="invoices__hint">Loading invoices…</p>}
          empty={<EmptyHint>{`No invoices in ${windowLabel}.`}</EmptyHint>}
        >
          {(data) => {
            // Non-null: FILTERS lists all seven FilterKey members above, and `filter`
            // only ever holds a key set via setFilter(f.key) from that same array, so
            // this always finds one, TS just can't see that invariant through .find().
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = inScope
              .filter((v) => activeFilter.test(v.state, v.overdue))
              .filter((v) => invoiceMatchesSearch(v.entry, search));

            return (
              <>
                <div className="invoices__tabs" role="tablist" aria-label="Filter invoices">
                  {FILTERS.map((f, index) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'invoices__tab invoices__tab--active' : 'invoices__tab'}
                      onClick={() => setFilter(f.key)}
                      {...getTabProps(index)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {visible.length === 0 ? (
                  <EmptyHint>
                    {`Nothing in the loaded invoices matches this filter.${
                      hasMore ? ' Load more to reach further back.' : ''
                    }`}
                  </EmptyHint>
                ) : (
                  <ul className="invoices__list">
                    {visible.map((v) => (
                      <InvoiceRow key={v.entry._id} view={v} todayIso={todayIso} onSelect={setSelectedId} />
                    ))}
                  </ul>
                )}

                {/* A FAILED PAGE IS NOT A FAILED LIST. The rows above are still
                    true, the cursor has not moved, and the failure is reported
                    beside them rather than replacing them. That is why this is
                    an inline alert and not the AsyncRegion banner above. */}
                {hasMore && (
                  <div className="invoices__more">
                    <GhostButton
                      label={more.status === 'loading' ? 'Loading more…' : 'Load more'}
                      onClick={loadMore}
                      disabled={more.status === 'loading'}
                    />
                    {more.status === 'error' && (
                      <p className="invoices__more-error" role="alert">
                        Couldn&rsquo;t load more invoices. {more.message} The{' '}
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

      {selected && <InvoiceDetail invoice={selected} onClose={() => setSelectedId(null)} />}

      {creating && (
        <InvoiceCreate
          mode={creating.mode}
          {...(creating.seedKinfolkId ? { seedKinfolkId: creating.seedKinfolkId } : {})}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}

interface InvoiceRowProps {
  view: RowView;
  todayIso: string;
  onSelect: (invoiceId: string) => void;
}

function InvoiceRow({ view, todayIso, onSelect }: InvoiceRowProps) {
  const { entry, state, overdue, partial } = view;
  // Overdue is a display-level refinement of "open" (see FILTERS' comment),
  // it never becomes its own InvoiceState, it just outranks the plain "Open"
  // chip visually, the same relationship the wasm's InvoiceRow renders.
  // Part-paid is the same kind of refinement, ranked below overdue: an overdue
  // invoice that is also part-paid is still, first, overdue.
  const info = overdue
    ? { label: 'Overdue', chipLabel: 'OVERDUE', cssClass: 'overdue' }
    : partial
      ? { label: 'Part paid', chipLabel: 'PART PAID', cssClass: 'partpaid' }
      : invoiceStateInfo(state);
  const household = entry.kinfolkName || entry.client || 'Unknown';
  const secondary = entry.client && entry.client !== entry.kinfolkName ? entry.client : null;
  const dateLine =
    state === 'open' && entry.dueDate
      ? `due ${humanizeDate(entry.dueDate, todayIso)}`
      : entry.date
        ? `${state === 'paid' ? 'paid' : 'dated'} ${humanizeDate(entry.date, todayIso)}`
        : entry.dueDate
          ? `due ${humanizeDate(entry.dueDate, todayIso)}`
          : 'no date';

  const body = (
    <>
      <span className="invoices__row-number">#{entry.invoiceNumber || '(none)'}</span>

      <span className="invoices__row-who">
        <span className="invoices__row-name">{household}</span>
        {secondary ? <span className="invoices__row-secondary">{secondary}</span> : null}
      </span>

      <span className={overdue ? 'invoices__row-meta invoices__row-meta--overdue' : 'invoices__row-meta'}>
        {dateLine}
        {entry.sessionIds.length > 0 ? (
          <span className="invoices__row-visits">
            linked to {entry.sessionIds.length} visit{entry.sessionIds.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </span>

      <span className="invoices__row-amount">{formatUsd(entry.total)}</span>

      <span className={`invoices__chip invoices__chip--${info.cssClass}`}>{info.chipLabel}</span>
    </>
  );

  return (
    <li className="invoices__row">
      <button type="button" className="invoices__row-main lift" onClick={() => onSelect(entry._id)}>
        {body}
      </button>
    </li>
  );
}
