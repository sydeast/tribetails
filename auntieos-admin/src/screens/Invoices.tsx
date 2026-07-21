import { useMemo, useState } from 'react';
import { INVOICES_QUERY, normalizeInvoice, type InvoiceEntry } from '../api/invoices';
import {
  formatUsd,
  humanizeDate,
  invoiceState,
  invoiceStateInfo,
  isInvoiceOverdue,
  localDateIso,
  type InvoiceState,
} from '../lib/invoiceFormat';
import { useCollection } from '../lib/firestore';
import { asyncScalar } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton } from '../components/Buttons';
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

/** One row's derived display facts, computed once per render pass. */
interface RowView {
  entry: InvoiceEntry;
  state: InvoiceState;
  overdue: boolean;
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
    return { entry, state, overdue: isInvoiceOverdue(state, entry.dueDate, todayIso) };
  });
}

/**
 * Admin Invoices list ("The Den · Invoices"). Streams the flat `invoices`
 * collection through the bounded, server-ordered listener (INVOICES_QUERY,
 * createdAt desc, capped 200), then classifies every row through the
 * enumerated `invoiceState` (never by negation, see lib/invoiceFormat.ts for
 * the AO-12 rationale) for both the summary stat strip and the filter tabs.
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
export function Invoices() {
  const rows = useCollection<InvoiceEntry>(INVOICES_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<InvoiceCreateMode | null>(null);

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

  const selected =
    selectedId && rows.status === 'ready' ? rows.data.find((r) => r._id === selectedId) : undefined;

  // Computed once per render, not per keystroke/tick: today doesn't change
  // mid-session, and recomputing on every render would be a stable value
  // recreated every time regardless, this just names that stability.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  // Classify every row exactly once (memoized), then project the stat strip AND
  // the list off the SAME views, rather than re-walking all 200 rows per stat.
  // asyncScalar's projector runs only in the `ready` branch, where `views` holds
  // the ready data; AsyncRegion likewise renders its children only when ready.
  const views = useMemo(
    () => (rows.status === 'ready' ? rowViewsFor(rows.data, todayIso) : []),
    [rows, todayIso],
  );

  const outstandingTotal = asyncScalar(rows, () =>
    views.filter((r) => r.state === 'open').reduce((sum, r) => sum + r.entry.amountDue, 0),
  );
  const billedTotal = asyncScalar(rows, (data) => data.reduce((sum, e) => sum + e.total, 0));
  const overdueCount = asyncScalar(rows, () => views.filter((r) => r.overdue).length);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Invoices"
        title="Getting"
        accentTail="paid."
        subtitle="Every invoice on the books, newest first."
        trailing={
          <div className="invoices__new-actions">
            <PrimaryButton label="New quote" onClick={() => setCreating('quote')} />
            <PrimaryButton label="New invoice" onClick={() => setCreating('invoice')} />
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
        <StatCard label="Billed total" value={billedTotal} trend="all invoices on the books" tone="teal" formatValue={formatUsd} />
        <StatCard
          label="Overdue"
          value={overdueCount}
          trend="past their due date"
          tone={overdueCount.kind === 'value' && overdueCount.value > 0 ? 'error' : 'muted'}
          feature={overdueCount.kind === 'value' && overdueCount.value > 0}
        />
      </div>

      <DenPanel title="Invoices" subtitle="Newest first, capped at 200.">
        <AsyncRegion
          state={rows}
          what="invoices"
          isEmpty={(data) => data.length === 0}
          loading={<p className="invoices__hint">Loading invoices…</p>}
          empty={<EmptyHint>No invoices on the books yet.</EmptyHint>}
        >
          {() => {
            // Non-null: FILTERS lists all seven FilterKey members above, and `filter`
            // only ever holds a key set via setFilter(f.key) from that same array, so
            // this always finds one, TS just can't see that invariant through .find().
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = views.filter((v) => activeFilter.test(v.state, v.overdue));

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
                  <EmptyHint>Nothing matches this filter.</EmptyHint>
                ) : (
                  <ul className="invoices__list">
                    {visible.map((v) => (
                      <InvoiceRow key={v.entry._id} view={v} todayIso={todayIso} onSelect={setSelectedId} />
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {selected && <InvoiceDetail invoice={selected} onClose={() => setSelectedId(null)} />}

      {creating && <InvoiceCreate mode={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

interface InvoiceRowProps {
  view: RowView;
  todayIso: string;
  onSelect: (invoiceId: string) => void;
}

function InvoiceRow({ view, todayIso, onSelect }: InvoiceRowProps) {
  const { entry, state, overdue } = view;
  // Overdue is a display-level refinement of "open" (see FILTERS' comment),
  // it never becomes its own InvoiceState, it just outranks the plain "Open"
  // chip visually, the same relationship the wasm's InvoiceRow renders.
  const info = overdue ? { label: 'Overdue', chipLabel: 'OVERDUE', cssClass: 'overdue' } : invoiceStateInfo(state);
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
      <button type="button" className="invoices__row-main" onClick={() => onSelect(entry._id)}>
        {body}
      </button>
    </li>
  );
}
