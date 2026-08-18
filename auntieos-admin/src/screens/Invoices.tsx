import { useMemo, useState } from 'react';
import {
  invoiceDispute,
  invoiceMatchesSearch,
  invoicesPageQuery,
  invoiceQuoteDecision,
  invoiceStamp,
  invoiceWithinWindow,
  isArchivedInvoice,
  normalizeInvoice,
  type InvoiceEntry,
  type InvoiceState,
} from '../api/invoices';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import {
  formatUsd,
  humanizeDate,
  invoiceActionsFor,
  invoiceDaysOverdue,
  invoiceStateInfo,
  invoicePartialPayment,
  type InvoiceAction,
  type InvoicePartialPayment,
  isInvoiceOverdue,
  localDateIso,
  unstampedStateInfo,
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
 * against the STORED `InvoiceState` stamp (or the derived overdue flag), never
 * a negation of another bucket, per the AO-12 ruling the server's classifier
 * inherited. "Open" and "Overdue" overlap on purpose (an overdue invoice is
 * still open): that mirrors the wasm's own Unpaid/Overdue tabs, which never
 * excluded each other either.
 *
 * `state` is null for a doc with no recognizable stamp (impossible per
 * ADR-0002; fail-soft). Such a row matches only "All", positively via its
 * always-true test — an unknown state is never claimed for any bucket.
 */
type FilterKey = 'all' | 'open' | 'overdue' | 'paid' | 'draft' | 'quote' | 'credit';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (state: InvoiceState | null, overdue: boolean) => boolean;
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
 * STILL APPLIED CLIENT-SIDE, NOW THAT THE FIELD IS REALLY BEING WRITTEN. Task
 * 5.1 shipped `archiveInvoice`, so `archivedAt` is no longer a field nothing
 * touches, and the obvious next move looks like pushing this into the query to
 * use the deployed `invoices (archivedAt ASC, date DESC)` index. IT IS STILL
 * WRONG, and it would fail SILENTLY, which is why this comment is longer than
 * the code it guards:
 *
 *  - `where('archivedAt', '==', null)` matches only documents that HAVE the
 *    field set to null. It does not match documents missing it.
 *  - Every invoice predating 5.1 is missing it, and archiving new invoices does
 *    not retroactively give it to the old ones.
 *  - So a "hide archived" predicate would return ZERO rows across essentially
 *    the whole collection, and Firestore would raise no error at all. An empty
 *    Invoices screen with a clean console is exactly the failure class this
 *    codebase exists to refuse.
 *
 * Converting this to a server predicate needs a backfill stamping
 * `archivedAt: null` onto every legacy invoice FIRST. That is a migration, and
 * deliberately not part of this task. `unarchiveInvoice` already writes
 * `archivedAt: null` rather than deleting the field, so restored invoices
 * already carry the shape such a backfill would converge on.
 *
 * The cost of staying client-side, stated rather than hidden: the exclusion only
 * sees rows this page has LOADED, so the hidden-invoice count in the stats note
 * is a count within the loaded page, not within the books. The note says so.
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

/**
 * THE ROW'S QUICK ACTION, mirroring Android's `RowAction`.
 *
 * Android offers exactly one state-appropriate action per row, drawn from the
 * shared `invoiceActionsFor`, so an operator working a list of overdue invoices
 * sends reminders without drilling into each one. The web list offered none: the
 * only path to any action was to open the detail modal, which is a click, a read
 * and a close per invoice.
 *
 * WHAT THIS DOES NOT DO IS FIRE THE CALLABLE FROM THE ROW. Every one of these
 * actions reaches a real household (a reminder email, a receipt, a draft
 * becoming a real bill), and this app's convention is that such a thing is
 * confirmed before it happens (see InvoiceDetail's confirm panel, whose copy
 * spells out what each action does to a person). Android has no such step, and
 * copying its behaviour rather than its information architecture would mean
 * either shipping an unconfirmed one-click send or writing a second confirm
 * flow whose wording could drift from the first.
 *
 * So the row's button OPENS THE DETAIL ARMED ON THAT ACTION: one click lands on
 * the confirm step that already exists, with the same copy, the same callable
 * and the same fail-loud reporting. The parity gap that mattered was that the
 * action was invisible from the list, and that is what closes.
 *
 * `markPaid` is deliberately not offered here, exactly as on Android: recording
 * a payment needs the amount / method / reference fields, so a row button for it
 * would be a button that only ever means "open the detail".
 */
const ROW_ACTION_LABELS: Readonly<Record<InvoiceAction, string>> = {
  reminder: 'Send reminder',
  reviewSend: 'Review and send',
  receipt: 'Receipt',
  markPaid: 'Record payment',
};

/** The one action a row offers, or null. Order is the offer precedence. */
function rowActionFor(state: InvoiceState | null): InvoiceAction | null {
  if (state === null) return null;
  const allowed = invoiceActionsFor(state);
  return allowed.find((a) => a === 'reviewSend' || a === 'reminder' || a === 'receipt') ?? null;
}

/** One row's display facts, read once per render pass. */
interface RowView {
  entry: InvoiceEntry;
  /** The STORED state stamp (ADR-0002). Null when the doc carries none: fail-soft, never re-derived. */
  state: InvoiceState | null;
  overdue: boolean;
  /** Whole days past due, or null when the invoice is not a dated overdue balance. */
  daysOverdue: number | null;
  /** Non-null when money has come in that does not cover the invoice. */
  partial: InvoicePartialPayment | null;
}

function rowViewsFor(rows: InvoiceEntry[], todayIso: string): RowView[] {
  // Normalize BEFORE anything reads a field. InvoiceEntry is a cast over raw
  // Firestore data, not a guarantee, and real docs ARE missing keys it declares.
  return rows.map(normalizeInvoice).map((entry) => {
    // The state is READ off the doc, not computed from it: the server stamped
    // the classifier's verdict in the same write as the money (ADR-0002), so
    // re-deriving it here would be a second opinion at best.
    const { state } = invoiceStamp(entry);
    return {
      entry,
      state,
      overdue: isInvoiceOverdue(state, entry.dueDate, todayIso),
      daysOverdue: invoiceDaysOverdue(state, entry.dueDate, todayIso),
      // Like `overdue`, a display refinement of `open` rather than a state of
      // its own, so it changes the chip and never the actions.
      partial: invoicePartialPayment(state, entry),
    };
  });
}

/**
 * Admin Invoices list ("The Den · Invoices"). Reads the flat `invoices`
 * collection a PAGE at a time through `usePagedCollection` (invoice `date` desc,
 * windowed by the toolbar's date preset), then reads every row's STORED state
 * stamp (`invoiceStamp`, ADR-0002 — this screen never classifies) for both the
 * summary stat strip and the filter tabs.
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
  // Which action the detail should open ALREADY ON its confirm step, set by a
  // row's quick-action button. Null when the row itself was clicked, which opens
  // the detail as it always did. Cleared alongside `selectedId` on close, so
  // reopening the same invoice from the row never re-arms a stale action.
  const [armedAction, setArmedAction] = useState<InvoiceAction | null>(null);
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

  // NORMALIZED, the same as the list rows. `rowViewsFor` normalizes what the
  // LIST reads, and this find used to hand the detail sheet the raw document,
  // so the two halves of one screen disagreed about the same invoice.
  //
  // It reached the server. Mark 10 of the 2026-08-17 walk opened
  // test-kinfolk-001-invoice-open, whose `client` and `invoiceNumber` are both
  // absent, took a payment, and sent `{"client":null,"invoiceNumber":null}` to
  // `recordPayment`, which answered 400: those fields are optional on the
  // contract and the server defaults them to '', but zod will not take a null
  // where a string may go. InvoiceEntry is a cast over Firestore data, not a
  // guarantee; normalizeInvoice is what turns the declaration back into truth.
  const selectedRow =
    selectedId && rows.status === 'ready' ? rows.data.find((r) => r._id === selectedId) : undefined;
  const selected = selectedRow === undefined ? undefined : normalizeInvoice(selectedRow);

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

  // Read every row's stamp exactly once (memoized), then project the stat strip
  // AND the list off the SAME views, rather than re-walking the page per stat.
  // asyncScalar's projector runs only in the `ready` branch, where `views` holds
  // the ready data; AsyncRegion likewise renders its children only when ready.
  const views = useMemo(
    () => (rows.status === 'ready' ? rowViewsFor(rows.data, todayIso) : []),
    [rows, todayIso],
  );

  // THE WINDOW, RE-ASKED AS ARITHMETIC. `where('date','>=',startDay)` is a
  // STRING comparison on a field that legacy documents fill with free text, and
  // in UTF-8 every letter outranks every digit, so a stored "Feb 12, 2026"
  // cleared the bound on its first character AND sorted above every real date.
  // "Last 30 days" was listing invoices six months old, at the top of the list.
  // `invoiceWithinWindow` re-tests each returned row as two instants, so a row
  // whose `date` is not a real calendar day on or after the bound cannot survive
  // whatever the server let through. Server writers are fixed too; this stays
  // because the documents already stored are not, until the backfill is run.
  const inWindow = useMemo(
    () => views.filter((v) => invoiceWithinWindow(v.entry, startDay)),
    [views, startDay],
  );
  const misdatedHidden = views.length - inWindow.length;

  // The archive facet is list-wide, not a tab: it decides which rows this screen
  // is ABOUT, so the stat strip is projected off the survivors. An archived
  // invoice counted into Outstanding would be money the operator has already
  // decided to stop chasing.
  const inScope = useMemo(
    () => inWindow.filter((v) => archivedAllows(archived, v.entry)),
    [inWindow, archived],
  );
  const archivedHidden = inWindow.length - inScope.length;

  const openRows = useMemo(() => inScope.filter((r) => r.state === 'open'), [inScope]);
  const overdueRows = useMemo(() => inScope.filter((r) => r.overdue), [inScope]);

  const outstandingTotal = asyncScalar(rows, () =>
    openRows.reduce((sum, r) => sum + r.entry.amountDue, 0),
  );
  const billedTotal = asyncScalar(rows, () => inScope.reduce((sum, r) => sum + r.entry.total, 0));
  const overdueCount = asyncScalar(rows, () => overdueRows.length);

  /**
   * WHO IS WORST, and by how long. Android's Overdue card carries this and the
   * web card said only "past their due date", which is the one thing the number
   * above it already told you.
   *
   * Named from the loaded rows, so it is a fact about what is on screen rather
   * than a claim about the books; the stats note directly below already states
   * that scope for all three cards. An overdue row whose age cannot be computed
   * contributes its household and no number rather than a fabricated one.
   */
  const worstOverdue = useMemo(() => {
    let worst: RowView | null = null;
    for (const row of overdueRows) {
      if (worst === null || (row.daysOverdue ?? 0) > (worst.daysOverdue ?? 0)) worst = row;
    }
    if (worst === null) return null;
    const who = worst.entry.kinfolkName || worst.entry.client || 'a household';
    return worst.daysOverdue === null ? who : `${who}, ${String(worst.daysOverdue)} days past`;
  }, [overdueRows]);

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
          ? ` ${String(archivedHidden)} archived invoice${archivedHidden === 1 ? '' : 's'} excluded, counted within the invoices loaded here rather than across the books.`
          : '');

  // THE HONESTY LINE. What the search box actually reaches, plus the two costs of
  // windowing on the `date` field, said out loud rather than left as rows that
  // quietly never appear.
  //
  // The second sentence is a COUNT, not a warning, and it should read zero on a
  // healthy collection: it names invoices the server handed back whose `date` is
  // not a real day, which the window then dropped. Every one of them is a
  // document written before creation validated the field. Naming them is how the
  // operator learns the backfill has not been run yet, instead of noticing a
  // short page and assuming the books are thin.
  const misdatedNote =
    misdatedHidden > 0
      ? ` ${String(misdatedHidden)} invoice${misdatedHidden === 1 ? ' whose stored date is not a real date was' : 's whose stored dates are not real dates were'} left out of this window.`
      : '';
  const scopeNote =
    (loaded === null
      ? `Search covers invoice number, household and client, within ${windowLabel}.`
      : `Searching the ${String(loaded)} invoice${plural} loaded from ${windowLabel}, by number, household and client.` +
        (hasMore ? ' Load more to reach further back.' : '')) +
    (range === 'all' ? '' : ' Invoices with no date appear only under All (archive).' + misdatedNote);

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
          // The count, like Android's, rather than the bare word "open": a
          // $4,000 outstanding total means something different across 2 invoices
          // than across 40. The trend only ever renders beside a proven number.
          trend={`across ${String(openRows.length)} open invoice${openRows.length === 1 ? '' : 's'}`}
          tone={outstandingTotal.kind === 'value' && outstandingTotal.value > 0 ? 'orange' : 'success'}
          feature={outstandingTotal.kind === 'value' && outstandingTotal.value > 0}
          formatValue={formatUsd}
        />
        <StatCard label="Billed total" value={billedTotal} trend="invoiced in this window" tone="teal" formatValue={formatUsd} />
        <StatCard
          label="Overdue"
          value={overdueCount}
          // Names the worst offender and how long, matching Android. "all clear"
          // rather than a blank when there are none, because an empty subline
          // under a zero reads as a card that failed to finish rendering.
          trend={worstOverdue ?? 'all clear'}
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
                      <InvoiceRow
                        key={v.entry._id}
                        view={v}
                        todayIso={todayIso}
                        onSelect={(id) => {
                          setArmedAction(null);
                          setSelectedId(id);
                        }}
                        onAction={(id, action) => {
                          setArmedAction(action);
                          setSelectedId(id);
                        }}
                      />
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

      {selected && (
        <InvoiceDetail
          invoice={selected}
          {...(armedAction ? { initialAction: armedAction } : {})}
          onClose={() => {
            setSelectedId(null);
            setArmedAction(null);
          }}
        />
      )}

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
  /** The row's one quick action: opens the detail already on that confirm step. */
  onAction: (invoiceId: string, action: InvoiceAction) => void;
}

function InvoiceRow({ view, todayIso, onSelect, onAction }: InvoiceRowProps) {
  const { entry, state, overdue, daysOverdue, partial } = view;
  // Overdue is a display-level refinement of "open" (see FILTERS' comment),
  // it never becomes its own InvoiceState, it just outranks the plain "Open"
  // chip visually, the same relationship the wasm's InvoiceRow renders.
  // Part-paid is the same kind of refinement, ranked below overdue: an overdue
  // invoice that is also part-paid is still, first, overdue.
  // A null state is a doc with no recognizable stamp: the neutral chip renders
  // the raw status text and claims nothing. The deliberate fail-soft, never a
  // re-classification from the money fields.
  const info = overdue
    ? { label: 'Overdue', chipLabel: 'OVERDUE', cssClass: 'overdue' }
    : partial
      ? { label: 'Part paid', chipLabel: 'PART PAID', cssClass: 'partpaid' }
      : state === null
        ? unstampedStateInfo(entry.status)
        : invoiceStateInfo(state);
  const household = entry.kinfolkName || entry.client || 'Unknown';
  const secondary = entry.client && entry.client !== entry.kinfolkName ? entry.client : null;
  // "12 days overdue" over "due May 21" on an overdue row: the age is the thing
  // that decides what to do about it, and it is the same stored dueDate either
  // way. Android's meta line reads the same. An overdue invoice whose age cannot
  // be computed keeps the plain due date rather than inventing a number.
  const dateLine =
    daysOverdue !== null
      ? `${String(daysOverdue)} day${daysOverdue === 1 ? '' : 's'} overdue`
      : state === 'open' && entry.dueDate
        ? `due ${humanizeDate(entry.dueDate, todayIso)}`
        : entry.date
          ? `${state === 'paid' ? 'paid' : 'dated'} ${humanizeDate(entry.date, todayIso)}`
          : entry.dueDate
            ? `due ${humanizeDate(entry.dueDate, todayIso)}`
            : 'no date';

  const archived = isArchivedInvoice(entry);
  // A quote the household turned down. It keeps `status: 'quote'` server-side
  // (issue #385: `cancelled` means the operator withdrew it, which is a
  // different fact), so without this marker a dead quote sits in the Quote
  // filter looking exactly like one still waiting for an answer.
  const declinedQuote = state === 'quote' && invoiceQuoteDecision(entry) === 'denied';
  const action = rowActionFor(state);
  // OPEN disputes only. See the chip below for why a won one is not marked.
  const disputed = invoiceDispute(entry)?.open === true;

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
        {/* WHAT IS ACTUALLY STILL OWED. The screen already computed this to
            decide the PART PAID chip and then threw the figures away, so the row
            said "$40.00" for an invoice with $20 left on it. On a money surface
            the chip naming a condition without naming the amount is the half of
            the fact that does not help anyone collect. */}
        {partial ? (
          <span className="invoices__row-partial">
            {formatUsd(partial.paidCents / 100)} paid, {formatUsd(partial.remainingCents / 100)} still
            owed
          </span>
        ) : null}
      </span>

      <span className="invoices__row-amount">{formatUsd(entry.total)}</span>

      <span className="invoices__row-chips">
        <span className={`invoices__chip invoices__chip--${info.cssClass}`}>{info.chipLabel}</span>
        {/* Only ever rendered under the Included / Only archived facet, since the
            default hides these rows entirely. Without it an archived invoice sits
            among active ones looking identical while being excluded from the
            Outstanding and Billed totals directly above, which makes those totals
            impossible to check by eye. */}
        {archived ? <span className="invoices__chip invoices__chip--archived">ARCHIVED</span> : null}
        {/* A DISPUTED ROW LOOKS EXACTLY LIKE A SETTLED ONE WITHOUT THIS. A
            chargeback deliberately leaves `status: paid` and `amountDue: 0`
            alone, so the row keeps its PAID chip and stays inside the Billed
            total above while the money is being pulled back out of the Stripe
            balance. This is the marker that stops the list from asserting
            something the ledger no longer supports.

            It sits BESIDE the state chip rather than replacing it, like
            ARCHIVED: a dispute is not one of the eight stamped invoice states
            and re-labelling the row would be classifying, which no client does.

            OPEN DISPUTES ONLY. Nothing ever clears `disputeStatus` — the
            contest happened and stays on record — so marking every invoice
            that carries one would put a permanent badge on every invoice ever
            disputed and won. A marker that never goes away is one the eye
            stops seeing, which would cost exactly the invoice this exists for.
            The won history is on the detail panel, where it is read on
            purpose rather than scanned past. */}
        {disputed ? <span className="invoices__chip invoices__chip--disputed">DISPUTED</span> : null}
        {/* BESIDE the QUOTE chip, not instead of it, for the same reason
            ARCHIVED and DISPUTED sit beside theirs: the doc really is still a
            quote, and re-labelling the row would be classifying. */}
        {declinedQuote ? <span className="invoices__chip invoices__chip--declined">DECLINED</span> : null}
      </span>
    </>
  );

  return (
    <li className="invoices__row">
      <button type="button" className="invoices__row-main lift" onClick={() => onSelect(entry._id)}>
        {body}
      </button>
      {/* OUTSIDE the row button, not inside it: a button inside a button is
          invalid HTML and the inner click would be swallowed by the outer one. */}
      {action ? (
        <div className="invoices__row-action">
          <GhostButton
            label={ROW_ACTION_LABELS[action]}
            onClick={() => onAction(entry._id, action)}
          />
        </div>
      ) : null}
    </li>
  );
}
