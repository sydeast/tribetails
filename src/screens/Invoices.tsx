import { useMemo, useState } from 'react';
import { INVOICES_QUERY, type InvoiceEntry } from '../api/invoices';
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
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import './Invoices.css';

/**
 * The Den filter tabs. Every predicate below is a POSITIVE membership test
 * against the enumerated `InvoiceState` (or the derived overdue flag) — never
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

interface InvoicesProps {
  /**
   * Placeholder: InvoiceDetail is a separate, not-yet-built screen. Omitting
   * this renders every row as a real, focusable button that simply does
   * nothing when clicked yet — never a dead-looking static row (same
   * onSelect-is-optional convention as FormSchemas.tsx) — so wiring the real
   * detail route later touches only the router, not this screen.
   */
  onSelect?: (invoiceId: string) => void;
}

/** One row's derived display facts, computed once per render pass. */
interface RowView {
  entry: InvoiceEntry;
  state: InvoiceState;
  overdue: boolean;
}

function rowViewsFor(rows: InvoiceEntry[], todayIso: string): RowView[] {
  return rows.map((entry) => {
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
 * collection through the bounded, server-ordered listener (INVOICES_QUERY —
 * createdAt desc, capped 200), then classifies every row through the
 * enumerated `invoiceState` (never by negation — see lib/invoiceFormat.ts for
 * the AO-12 rationale) for both the summary stat strip and the filter tabs.
 *
 * List only: creating an invoice/quote (NewInvoiceDialog) and the per-invoice
 * detail view (InvoiceDetail, and its reminder/receipt/review-and-send row
 * actions) are separate, not-yet-built screens. `onSelect` is this screen's
 * only hook into that later work.
 */
export function Invoices({ onSelect }: InvoicesProps) {
  const rows = useCollection<InvoiceEntry>(INVOICES_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');

  // Computed once per render, not per keystroke/tick: today doesn't change
  // mid-session, and recomputing on every render would be a stable value
  // recreated every time regardless — this just names that stability.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  const outstandingTotal = asyncScalar(rows, (data) =>
    rowViewsFor(data, todayIso)
      .filter((r) => r.state === 'open')
      .reduce((sum, r) => sum + r.entry.amountDue, 0),
  );
  const billedTotal = asyncScalar(rows, (data) => data.reduce((sum, e) => sum + e.total, 0));
  const overdueCount = asyncScalar(
    rows,
    (data) => rowViewsFor(data, todayIso).filter((r) => r.overdue).length,
  );

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Invoices"
        title="Getting"
        accentTail="paid."
        subtitle="Every invoice on the books, newest first."
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
          {(data) => {
            const views = rowViewsFor(data, todayIso);
            // Non-null: FILTERS lists all seven FilterKey members above, and `filter`
            // only ever holds a key set via setFilter(f.key) from that same array, so
            // this always finds one — TS just can't see that invariant through .find().
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = views.filter((v) => activeFilter.test(v.state, v.overdue));

            return (
              <>
                <div className="invoices__tabs" role="tablist" aria-label="Filter invoices">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'invoices__tab invoices__tab--active' : 'invoices__tab'}
                      onClick={() => setFilter(f.key)}
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
                      <InvoiceRow key={v.entry._id} view={v} onSelect={onSelect} />
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

interface InvoiceRowProps {
  view: RowView;
  onSelect?: ((invoiceId: string) => void) | undefined;
}

function InvoiceRow({ view, onSelect }: InvoiceRowProps) {
  const { entry, state, overdue } = view;
  // Overdue is a display-level refinement of "open" (see FILTERS' comment) —
  // it never becomes its own InvoiceState, it just outranks the plain "Open"
  // chip visually, the same relationship the wasm's InvoiceRow renders.
  const info = overdue ? { label: 'Overdue', chipLabel: 'OVERDUE', cssClass: 'overdue' } : invoiceStateInfo(state);
  const household = entry.kinfolkName || entry.client || 'Unknown';
  const secondary = entry.client && entry.client !== entry.kinfolkName ? entry.client : null;
  const dateLine =
    state === 'open' && entry.dueDate
      ? `due ${humanizeDate(entry.dueDate)}`
      : entry.date
        ? `${state === 'paid' ? 'paid' : 'dated'} ${humanizeDate(entry.date)}`
        : entry.dueDate
          ? `due ${humanizeDate(entry.dueDate)}`
          : 'no date';

  return (
    <li className="invoices__row">
      <button type="button" className="invoices__row-main" onClick={() => onSelect?.(entry._id)}>
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
      </button>
    </li>
  );
}
