import { useState } from 'react';
import { BOOKINGS_QUERY, type BookingEntry } from '../api/bookings';
import {
  bookingState,
  bookingStateInfo,
  bookingWhen,
  initialsFor,
  type BookingState,
} from '../lib/bookingFormat';
import { useCollection } from '../lib/firestore';
import { asyncScalar } from '../lib/async';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import './Bookings.css';

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * the enumerated `BookingState` (never a negation of another bucket, per the
 * AO-12-style discipline in lib/bookingFormat.ts). There is deliberately no
 * "Unknown" tab: an unrecognized/blank status row still renders (visible
 * under "All", with its own honestly-labeled UNKNOWN chip) — it is simply not
 * promoted to a dedicated tab, the same treatment invoiceFormat.ts's "zero"
 * state gets in Invoices.tsx's FILTERS.
 */
type FilterKey = 'all' | 'draft' | 'pending' | 'scheduled' | 'completed' | 'cancelled';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (state: BookingState) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'draft', label: 'Draft', test: (s) => s === 'draft' },
  { key: 'pending', label: 'Pending', test: (s) => s === 'pending' },
  { key: 'scheduled', label: 'Scheduled', test: (s) => s === 'scheduled' },
  { key: 'completed', label: 'Completed', test: (s) => s === 'completed' },
  { key: 'cancelled', label: 'Cancelled', test: (s) => s === 'cancelled' },
];

interface BookingsProps {
  /**
   * Placeholder: BookingDetail is a separate, not-yet-built screen, and this
   * port is LIST ONLY (no create/edit flow, no row actions — see the
   * OUT-OF-SCOPE note in api/bookings.ts for what a detail screen would still
   * need to add). The router mounts this screen propless, so in production
   * `onSelectBooking` is always undefined — see `BookingRow` below: when
   * unwired the row is a STATIC <div>, not a <button>. A handler-less <button>
   * is still a focusable, tabbable dead control (the anti-pattern), so the row
   * only becomes a real <button> once a detail route wires the handler.
   */
  onSelectBooking?: (bookingId: string) => void;
}

/** One row's derived display facts, computed once per render pass. */
interface RowView {
  entry: BookingEntry;
  state: BookingState;
}

function rowViewsFor(rows: BookingEntry[]): RowView[] {
  return rows.map((entry) => ({ entry, state: bookingState({ status: entry.status }) }));
}

/**
 * Admin Bookings list ("The Den · Bookings"). Streams the flat
 * `kin_care_sessions` collection through the bounded, server-ordered listener
 * (BOOKINGS_QUERY — createdAt desc, capped 200), then classifies every row
 * through the enumerated `bookingState` (never by negation — see
 * lib/bookingFormat.ts) for both the summary stat strip and the filter tabs.
 *
 * List only: creating/editing a booking (BookingCreateScreen's Kinfolk
 * picker + KinCare-type + date/time form) and the per-booking detail view
 * (BookingDetail, and any row actions — Approve/Reject/Cancel/Mark Completed)
 * are separate, not-yet-built surfaces. `onSelectBooking` is this screen's
 * only hook into that later work. The wasm's SEPARATE "Incoming requests"
 * panel (MyTribe booking-envelope collection-group query + approve/cancel a
 * whole series) is also not ported — see the OUT-OF-SCOPE note in
 * api/bookings.ts for exactly why.
 */
export function Bookings({ onSelectBooking }: BookingsProps) {
  const rows = useCollection<BookingEntry>(BOOKINGS_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');

  // "Pending" mirrors BookingScreen.kt's "Pending approval" stat: DRAFT and
  // PENDING are both pre-visit states (BookingCreateScreen's Save-draft /
  // Submit-request outcomes) that have not yet become a real scheduled visit.
  const pendingCount = asyncScalar(
    rows,
    (data) => rowViewsFor(data).filter((r) => r.state === 'draft' || r.state === 'pending').length,
  );
  const scheduledCount = asyncScalar(
    rows,
    (data) => rowViewsFor(data).filter((r) => r.state === 'scheduled').length,
  );
  // "History" mirrors the wasm's own
  // `history = sessions.filter { status !in {SCHEDULED, DRAFT, PENDING} }`:
  // everything that has left the pending/scheduled lifecycle. Composed here
  // from three POSITIVELY enumerated states (never a negation), and — unlike
  // the wasm's own gap — this deliberately still counts an `unknown` status
  // row rather than letting it vanish from every stat uncounted.
  const historyCount = asyncScalar(
    rows,
    (data) =>
      rowViewsFor(data).filter(
        (r) => r.state === 'completed' || r.state === 'cancelled' || r.state === 'unknown',
      ).length,
  );

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Bookings"
        title="Every"
        accentTail="visit."
        subtitle="Pending requests and scheduled visits, newest first."
      />

      <div className="bookings__summary">
        <StatCard
          label="Pending"
          value={pendingCount}
          trend="awaiting a reply"
          tone="orange"
          feature={pendingCount.kind === 'value' && pendingCount.value > 0}
        />
        <StatCard label="Scheduled" value={scheduledCount} trend="on the books" tone="teal" />
        <StatCard label="History" value={historyCount} trend="completed, cancelled, or other" tone="purple" />
      </div>

      <DenPanel title="Bookings" subtitle="Newest first, capped at 200.">
        <AsyncRegion
          state={rows}
          what="bookings"
          isEmpty={(data) => data.length === 0}
          loading={<p className="bookings__hint">Loading bookings…</p>}
          empty={<EmptyHint>No bookings yet. New requests land here.</EmptyHint>}
        >
          {(data) => {
            const views = rowViewsFor(data);
            // Non-null: FILTERS lists all six FilterKey members above, and `filter`
            // only ever holds a key set via setFilter(f.key) from that same array,
            // so this always finds one — TS just can't see that invariant through
            // .find().
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = views.filter((v) => activeFilter.test(v.state));

            return (
              <>
                <div className="bookings__tabs" role="tablist" aria-label="Filter bookings">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'bookings__tab bookings__tab--active' : 'bookings__tab'}
                      onClick={() => setFilter(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {visible.length === 0 ? (
                  <EmptyHint>Nothing matches this filter.</EmptyHint>
                ) : (
                  <ul className="bookings__list">
                    {visible.map((v) => (
                      <BookingRow key={v.entry._id} view={v} onSelectBooking={onSelectBooking} />
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

interface BookingRowProps {
  view: RowView;
  onSelectBooking?: ((bookingId: string) => void) | undefined;
}

function BookingRow({ view, onSelectBooking }: BookingRowProps) {
  const { entry, state } = view;
  const info = bookingStateInfo(state);
  const displayName = entry.kinfolkName.trim() !== '' ? entry.kinfolkName : 'Unnamed Kinfolk';
  // Recomputed per row per render (not memoized): each is a handful of cheap
  // string ops, not worth the hook bookkeeping at list scale.
  const when = bookingWhen(entry);
  const notePreview = entry.kinfolkNotes.trim() !== '' ? entry.kinfolkNotes : entry.notes;
  const serviceLabel = entry.serviceType.trim() !== '' ? entry.serviceType : 'Visit';

  const body = (
    <>
      <Avatar
        label={displayName}
        initials={initialsFor(displayName)}
        gradientSeed={entry.kinfolkId !== '' ? entry.kinfolkId : displayName}
        size={40}
        shape="rounded"
      />

      <span className="bookings__row-who">
        <span className="bookings__row-name">{displayName}</span>
        <span className="bookings__row-meta">
          {serviceLabel} · {when}
        </span>
        {notePreview.trim() !== '' && (
          <span className="bookings__row-note">Note: {notePreview.slice(0, 120)}</span>
        )}
      </span>

      <span className={`bookings__chip bookings__chip--${info.cssClass}`}>{info.chipLabel}</span>
    </>
  );

  // Static, non-interactive row unless a detail handler is wired: a handler-less
  // <button> is still a focusable, tabbable dead control, so when unwired the
  // row is a plain <div> — no button role, no cursor, no hover.
  return (
    <li className="bookings__row">
      {onSelectBooking ? (
        <button type="button" className="bookings__row-main" onClick={() => onSelectBooking(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="bookings__row-main bookings__row-main--static">{body}</div>
      )}
    </li>
  );
}
