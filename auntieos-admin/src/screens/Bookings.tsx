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
import {
  approveBooking,
  rejectBooking,
  cancelBooking,
  batchUpdateBookings,
  type BatchBookingAction,
} from '../api/bookingsWrite';
import type {
  BatchUpdateBookingsResult,
  CreateMultiDateBookingRequestResult,
} from '../contracts/bookingContracts.generated';
import {
  planBulkAction,
  mergeBulkResults,
  chunkEnvelopeIds,
  bulkOutcomeSummary,
  type BulkOutcome,
} from '../lib/bookingBulk';
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

  // ── bulk select ──────────────────────────────────────────────────────────
  // Off by default, exactly as the mock has it: checkboxes only appear once
  // Select is on, so the ordinary read of this list is not a wall of controls.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  // The bar's own confirm step. The mock fires straight from the bar; a bulk
  // CANCEL is not undoable and the per-row surface asks first, so this asks too
  // rather than making "many at once" the one path with no second thought.
  const [confirmAction, setConfirmAction] = useState<BatchBookingAction | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  function leaveSelectMode() {
    setSelecting(false);
    setSelectedIds(new Set());
    setConfirmAction(null);
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmAction(null);
  }

  /**
   * Apply one transition to every selected row.
   *
   * TWO WRITES, ON PURPOSE, and `lib/bookingBulk.ts`'s header explains the full
   * reasoning. In short: the flat `kin_care_sessions` write is the only one that
   * changes what this list shows, and `batchUpdateBookings` is the only one that
   * reaches the household's own copy of the visit. Doing either alone leaves one
   * of the two audiences looking at a stale booking.
   *
   * There is no optimistic swap here. The screen's own live BOOKINGS_QUERY
   * listener carries every landed write back on its own, usually before this
   * function returns, so an optimistic row would be a second source of truth
   * competing with a listener that is already fast. The result banner, not the
   * rows, is what reports what happened.
   */
  async function runBulk(action: BatchBookingAction) {
    if (running || rows.status !== 'ready') return;
    const plan = planBulkAction(rows.data, selectedIds, action);
    setRunning(true);
    setBulkError(null);
    setOutcome(null);

    const sessionFailures = new Map<string, string>();
    for (const target of plan.eligible) {
      try {
        if (action === 'APPROVE') await approveBooking(target.id);
        else if (action === 'REJECT') await rejectBooking(target.id);
        else await cancelBooking(target.id);
      } catch (err) {
        sessionFailures.set(target.id, err instanceof Error ? err.message : 'Write failed');
      }
    }

    // Only rows whose flat write landed AND that have an envelope counterpart.
    // Sending an id whose local write just failed would confirm a visit in the
    // household's copy that the admin's own list still shows as pending.
    const envelopeIds = plan.eligible
      .filter((t) => t.envelopeVisitId !== null && !sessionFailures.has(t.id))
      .map((t) => t.envelopeVisitId as string);

    const envelopeResults: BatchUpdateBookingsResult[] = [];
    for (const chunk of chunkEnvelopeIds(envelopeIds)) {
      try {
        envelopeResults.push(await batchUpdateBookings(chunk, action));
      } catch (err) {
        // A THROWN callable is not a per-id failure, it is the whole chunk
        // never running, so it gets its own line rather than being folded into
        // the per-booking list where it would read as one unlucky booking.
        setBulkError(
          `The household's copy of ${chunk.length} visit${chunk.length === 1 ? '' : 's'} could not be updated: ` +
            `${err instanceof Error ? err.message : 'the call failed'}. The visits were still updated here, so the two now disagree.`,
        );
      }
    }

    const result = mergeBulkResults(action, plan, sessionFailures, envelopeResults);
    setOutcome(result);
    setRunning(false);
    setConfirmAction(null);
    // Everything that landed leaves the selection; everything that did not
    // stays picked, so a retry is one press and not a re-hunt through the list.
    const keep = new Set([...result.failures.map((f) => f.id), ...result.skipped.map((s) => s.id)]);
    setSelectedIds(keep);
  }

  function handleCreated(result: CreateMultiDateBookingRequestResult) {
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
        trailing={
          <>
            {/* The label carries the mode, not an aria-pressed attribute:
                GhostButton takes no arbitrary DOM props, and a control whose
                accessible NAME says what pressing it does next needs no second
                channel to announce its state. */}
            <GhostButton
              label={selecting ? 'Done selecting' : 'Select'}
              onClick={() => (selecting ? leaveSelectMode() : setSelecting(true))}
            />
            <PrimaryButton label="New booking" onClick={() => setShowCreate(true)} />
          </>
        }
      />

      {createNotice !== null && (
        <Banner tone="success" title="Request created" onDismiss={() => setCreateNotice(null)}>
          {createNotice}
        </Banner>
      )}

      {outcome !== null && <BulkOutcomeBanner outcome={outcome} onDismiss={() => setOutcome(null)} />}

      {bulkError !== null && (
        <Banner tone="error" title="The household's copy was not updated" onDismiss={() => setBulkError(null)}>
          {bulkError}
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
                      <BookingRow
                        key={v.entry._id}
                        view={v}
                        onSelectBooking={handleSelectBooking}
                        selecting={selecting}
                        picked={selectedIds.has(v.entry._id)}
                        onTogglePick={toggleRow}
                      />
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>

      {selecting && selectedIds.size > 0 && (
        <BulkBar
          count={selectedIds.size}
          confirming={confirmAction}
          running={running}
          onAsk={setConfirmAction}
          onBack={() => setConfirmAction(null)}
          onRun={(action) => void runBulk(action)}
          onClear={() => {
            setSelectedIds(new Set());
            setConfirmAction(null);
          }}
        />
      )}

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

// ── bulk bar ────────────────────────────────────────────────────────────────

const BULK_ACTIONS: readonly { action: BatchBookingAction; label: string }[] = [
  { action: 'APPROVE', label: 'Approve' },
  { action: 'REJECT', label: 'Reject' },
  { action: 'CANCEL', label: 'Cancel' },
];

/** Confirm-step copy, per action. Says how many, and says what cannot be undone. */
function bulkConfirmCopy(action: BatchBookingAction, count: number): string {
  const noun = count === 1 ? 'booking' : 'bookings';
  if (action === 'APPROVE') {
    return `Approve ${count} ${noun}? Each moves to Scheduled and appears on the calendar.`;
  }
  if (action === 'REJECT') return `Reject ${count} ${noun}? This cannot be undone.`;
  return `Cancel ${count} ${noun}? This cannot be undone.`;
}

interface BulkBarProps {
  count: number;
  confirming: BatchBookingAction | null;
  running: boolean;
  onAsk: (action: BatchBookingAction) => void;
  onBack: () => void;
  onRun: (action: BatchBookingAction) => void;
  onClear: () => void;
}

/**
 * The mock's floating bar: a live count, the three transitions, and a way to
 * back out of the selection. Rendered only while Select is on AND something is
 * picked, matching the mock's own `bar.classList.toggle('show', picked.length
 * > 0)`.
 *
 * The mock labels this button "Clear", and `onClear` does exactly what that
 * says: `setSelectedIds(new Set())` plus dropping any pending confirm. It
 * touches no booking data. But sitting next to Approve and Reject, "Clear"
 * reads as "clear the records", which is why the operator asked what it did.
 * Labelled "Deselect all" instead, the same rename `ui-ideas/` never had to
 * make because nobody had put it next to two destructive-sounding verbs yet.
 *
 * The mock also draws a Reschedule button here. It is deliberately NOT built:
 * rescheduling many visits at once means picking a new time PER visit (they do
 * not share one), which is a different surface from a bar of one-press verbs,
 * and `rescheduleBooking` takes one session and one window. A button that
 * cannot mean anything for a selection of five is worse than its absence.
 */
function BulkBar({ count, confirming, running, onAsk, onBack, onRun, onClear }: BulkBarProps) {
  return (
    <div className="bookings__bulkbar" role="group" aria-label="Bulk actions">
      <span className="bookings__bulkbar-count">
        <b>{count}</b> selected
      </span>
      <span className="bookings__bulkbar-sep" />
      {confirming === null ? (
        <>
          {BULK_ACTIONS.map(({ action, label }) =>
            action === 'APPROVE' ? (
              <PrimaryButton key={action} label={label} onClick={() => onAsk(action)} />
            ) : (
              <GhostButton key={action} label={label} onClick={() => onAsk(action)} />
            ),
          )}
          <span className="bookings__bulkbar-sep" />
          <GhostButton label="Deselect all" onClick={onClear} />
        </>
      ) : (
        <>
          <span className="bookings__bulkbar-confirm">{bulkConfirmCopy(confirming, count)}</span>
          <GhostButton label="Back" onClick={onBack} disabled={running} />
          <PrimaryButton
            label={running ? 'Working…' : `Yes, ${BULK_ACTIONS.find((a) => a.action === confirming)?.label.toLowerCase() ?? 'apply'} ${count}`}
            onClick={() => onRun(confirming)}
            disabled={running}
            busy={running}
          />
        </>
      )}
    </div>
  );
}

// ── bulk result ─────────────────────────────────────────────────────────────

/**
 * What actually happened, per booking.
 *
 * NEVER collapsed into one line. `batchUpdateBookings` reports per-id failures
 * rather than throwing, and the flat writes fail one at a time too, so "3 of 5"
 * with no names is a result the operator cannot act on: they would have to
 * re-derive which two by reading the list. Failures and skips are listed
 * separately because they are different facts. A failure is something that was
 * attempted and broke; a skip was never attempted, and the reason is usually
 * that the row was in a state this action does not apply to.
 */
function BulkOutcomeBanner({ outcome, onDismiss }: { outcome: BulkOutcome; onDismiss: () => void }) {
  const clean = outcome.failures.length === 0 && outcome.skipped.length === 0;
  return (
    <Banner
      tone={outcome.failures.length > 0 ? 'error' : clean ? 'success' : 'warning'}
      title={bulkOutcomeSummary(outcome)}
      onDismiss={onDismiss}
    >
      {outcome.failures.length > 0 && (
        <>
          <p className="bookings__bulk-result-head">Not applied:</p>
          <ul className="bookings__bulk-result">
            {outcome.failures.map((f) => (
              <li key={f.id}>
                <strong>{f.name}</strong>: {f.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {outcome.skipped.length > 0 && (
        <>
          <p className="bookings__bulk-result-head">Skipped, nothing was written:</p>
          <ul className="bookings__bulk-result">
            {outcome.skipped.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {clean && <p className="bookings__bulk-result-head">Every selected booking was updated.</p>}
    </Banner>
  );
}

interface BookingRowProps {
  view: RowView;
  onSelectBooking?: ((bookingId: string) => void) | undefined;
  /** Select mode is on: the row shows its checkbox. */
  selecting: boolean;
  picked: boolean;
  onTogglePick: (bookingId: string) => void;
}

function BookingRow({ view, onSelectBooking, selecting, picked, onTogglePick }: BookingRowProps) {
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
  //
  // The checkbox is a SIBLING of that button, never inside it: nesting an input
  // in a button gives one hit area two meanings, and the label would be swallowed
  // by the button's own accessible name. Opening a booking stays possible while
  // Select is on, which is the point of a per-row checkbox rather than a mode
  // that hijacks the whole row's click.
  return (
    <li className={picked ? 'bookings__row bookings__row--picked' : 'bookings__row'}>
      {selecting && (
        <label className="bookings__row-pick">
          <input
            type="checkbox"
            checked={picked}
            onChange={() => onTogglePick(entry._id)}
            aria-label={`Select ${displayName}, ${info.chipLabel}`}
          />
        </label>
      )}
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
