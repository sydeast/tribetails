import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { BookingDetailModal } from '../components/BookingDetailModal';
import { BookingStatusActions } from './BookingActions';
import { NewBookingDialog } from '../components/NewBookingDialog';
import type { CreateMultiDateBookingResult } from '../api/bookingsWrite';
import './Bookings.css';

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * the enumerated `BookingState` (never a negation of another bucket, per the
 * AO-12-style discipline in lib/bookingFormat.ts). There is deliberately no
 * "Unknown" tab: an unrecognized/blank status row still renders (visible
 * under "All", with its own honestly-labeled UNKNOWN chip), it is simply not
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
   * Row-select hook. The router mounts this screen propless (no detail ROUTE
   * exists), so by default this screen wires its OWN handler: selecting a row
   * opens `BookingDetailModal`, the full detail sheet, fed from the SAME live
   * BOOKINGS_QUERY stream this list already reads (no second fetch, see the
   * `detailEntry` lookup below). Passing `onSelectBooking` explicitly overrides
   * that default, letting a future detail ROUTE (or a test) own selection
   * instead; when overridden, this screen's own overlay never renders (see the
   * `!onSelectBooking` guard it renders under).
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
 * (BOOKINGS_QUERY, createdAt desc, capped 200), then classifies every row
 * through the enumerated `bookingState` (never by negation, see
 * lib/bookingFormat.ts) for both the summary stat strip and the filter tabs.
 *
 * SELECTING A ROW opens `BookingDetailModal`, the same full detail sheet the
 * Schedule agenda opens (household link, service address, requested services,
 * duration, status, assigned Auntie, KinTale link, reschedule, and both note
 * threads), with this screen's Approve / Reject / Cancel / Mark Completed
 * composed into its `actions` slot as `BookingStatusActions`.
 *
 * It used to open `BookingActions` instead, a thin dialog carrying the status
 * chip, service, when, one notes line and those buttons. Nothing was wrong with
 * it except that the operator asked for the opposite: a card should open the
 * FULLER record, and the sheet that already held it was reachable from Schedule
 * only. Nothing that dialog offered was dropped in the move: its four
 * transitions are the composed panel, and its two-field reschedule is a strict
 * subset of the sheet's own reschedule panel (which recomputes the end from the
 * stored service duration instead of asking the operator to retype it).
 *
 * Still NOT built here: creating/editing a booking (BookingCreateScreen's
 * Kinfolk picker + KinCare-type + date/time form), and the wasm's SEPARATE
 * "Incoming requests" panel (MyTribe booking-envelope collection-group query +
 * `manageBookingSeries`/`batchUpdateBookings`, which act on a different, NESTED
 * collection than the rows here), see the OUT-OF-SCOPE notes in api/bookings.ts
 * and api/bookingsWrite.ts for exactly why those two callables don't apply to
 * this list's rows.
 */
export function Bookings({ onSelectBooking }: BookingsProps) {
  const navigate = useNavigate();
  const rows = useCollection<BookingEntry>(BOOKINGS_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');
  // The overlay's own selection state, used only when no external
  // onSelectBooking is supplied (see BookingsProps's doc above).
  const [detailId, setDetailId] = useState<string | null>(null);
  const handleSelectBooking = onSelectBooking ?? setDetailId;

  // The "New booking request" create surface (AO-25). It writes the envelope
  // model ('requested'), a DIFFERENT collection from the kin_care_sessions this
  // list streams, so the created request lands in the Incoming-requests queue
  // for approval and does NOT appear below until approved: the success banner
  // says so rather than leaving the operator to wonder.
  const [showCreate, setShowCreate] = useState(false);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  function handleCreated(result: CreateMultiDateBookingResult) {
    setShowCreate(false);
    setCreateNotice(
      `Booking request created: ${result.visitCount} visit${result.visitCount === 1 ? '' : 's'} submitted for approval. ` +
        `It enters the Incoming-requests queue and appears in this list once approved.`,
    );
  }

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

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
  // from three POSITIVELY enumerated states (never a negation), and, unlike
  // the wasm's own gap, this deliberately still counts an `unknown` status
  // row rather than letting it vanish from every stat uncounted.
  const historyCount = asyncScalar(
    rows,
    (data) =>
      rowViewsFor(data).filter(
        (r) => r.state === 'completed' || r.state === 'cancelled' || r.state === 'unknown',
      ).length,
  );

  // The row the detail sheet shows, resolved from the SAME live stream `rows`
  // already holds (never a second fetch): once a write round-trips through
  // Firestore, this listener's next snapshot updates `detailEntry` too. `null`
  // (stream not ready, or the id no longer resolves to a row) gets its own
  // honest "unavailable" dialog below rather than a blank sheet.
  const detailEntry =
    detailId !== null && rows.status === 'ready' ? (rows.data.find((r) => r._id === detailId) ?? null) : null;

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Bookings"
        title="Every"
        accentTail="visit."
        subtitle="Pending requests and scheduled visits, newest first."
        trailing={<PrimaryButton label="New booking" onClick={() => setShowCreate(true)} />}
      />

      {createNotice !== null && (
        <Banner tone="success" title="Request created" onDismiss={() => setCreateNotice(null)}>
          {createNotice}
        </Banner>
      )}

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
            // so this always finds one, TS just can't see that invariant through
            // .find().
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = views.filter((v) => activeFilter.test(v.state));

            return (
              <>
                <div className="bookings__tabs" role="tablist" aria-label="Filter bookings">
                  {FILTERS.map((f, index) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'bookings__tab bookings__tab--active' : 'bookings__tab'}
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
                  <ul className="bookings__list">
                    {visible.map((v) => (
                      <BookingRow key={v.entry._id} view={v} onSelectBooking={handleSelectBooking} />
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {/* Only this screen's OWN selection renders its own overlay; an external
          onSelectBooking (see the prop's doc) means the caller owns the detail
          UI instead. A selected id that no longer resolves to a row says so,
          rather than opening a sheet with nothing in it. */}
      {!onSelectBooking &&
        detailId !== null &&
        (detailEntry === null ? (
          <Dialog
            title="Booking unavailable"
            onClose={() => setDetailId(null)}
            footer={<GhostButton label="Done" onClick={() => setDetailId(null)} />}
          >
            <p className="bookings__hint">
              This booking is no longer available. It may have been cancelled or removed.
            </p>
          </Dialog>
        ) : (
          <BookingDetailModal
            entry={detailEntry}
            onClose={() => setDetailId(null)}
            actions={
              <BookingStatusActions entry={detailEntry} onDone={() => setDetailId(null)} />
            }
            onOpenKinfolk={(kinfolkId) =>
              void navigate({ to: '/directory/$kinfolkId', params: { kinfolkId } })
            }
            onOpenKinTale={(kinTaleId) =>
              // Search param, not a path: the convention lib/notificationActions.ts
              // set for invoice and kintale deep links, and the one Schedule.tsx
              // already passes to this same sheet.
              void navigate({ to: '/kintales', search: { kinTaleId } })
            }
          />
        ))}

      {showCreate && (
        <NewBookingDialog onClose={() => setShowCreate(false)} onCreated={handleCreated} />
      )}
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
  // `?? ''` on every field read, matching sessionFormat.ts's convention.
  // BookingEntry is a CAST over raw Firestore data, not a validation of it, and
  // a real kin_care_sessions doc can be missing any of these. Reading one blind
  // threw and the error boundary blanked the WHOLE Bookings page (2026-07-20).
  const kinfolkName = entry.kinfolkName ?? '';
  const displayName = kinfolkName.trim() !== '' ? kinfolkName : 'Unnamed Kinfolk';
  // Recomputed per row per render (not memoized): each is a handful of cheap
  // string ops, not worth the hook bookkeeping at list scale.
  const when = bookingWhen(entry);
  const kinfolkNotes = entry.kinfolkNotes ?? '';
  const notePreview = kinfolkNotes.trim() !== '' ? kinfolkNotes : (entry.notes ?? '');
  const serviceLabel = (entry.serviceType ?? '').trim() !== '' ? entry.serviceType : 'Visit';

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
  // row is a plain <div>, no button role, no cursor, no hover.
  return (
    <li className="bookings__row">
      {onSelectBooking ? (
        <button type="button" className="bookings__row-main lift" onClick={() => onSelectBooking(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="bookings__row-main bookings__row-main--static">{body}</div>
      )}
    </li>
  );
}
