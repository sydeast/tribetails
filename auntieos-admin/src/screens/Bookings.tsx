import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BOOKINGS_QUERY, type BookingEntry } from '../api/bookings';
import {
  bookingMetaLine,
  bookingSortTimeMs,
  bookingState,
  bookingStateInfo,
  initialsFor,
  EMPTY_BOOKING_CATALOG,
  type BookingCatalog,
  type BookingState,
} from '../lib/bookingFormat';
import { getBusinessSettings } from '../api/settings';
import { useCollection, useDocById } from '../lib/firestore';
import { DenScreenHeading, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { BookingDetailModal } from '../components/BookingDetailModal';
import { BookingStatusActions } from './BookingActions';
import { NewBookingDialog } from '../components/NewBookingDialog';
import { VisitRequestsSection } from '../components/VisitRequestsSection';
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
  type BulkSkip,
} from '../lib/bookingBulk';
import {
  planBulkReschedule,
  bulkRescheduleSummary,
  type BulkRescheduleOutcome,
  type RescheduleTarget,
} from '../lib/bookingReschedule';
import { BulkRescheduleDialog } from '../components/BulkRescheduleDialog';
import { bookingWhenLabel } from '../lib/bookingDetailFormat';
import './Bookings.css';

/**
 * THERE ARE NO FILTER TABS ON THIS SCREEN, and their absence is the ruling
 * rather than an omission (#704).
 *
 * An All / Draft / Pending / Scheduled / Completed / Cancelled tab row used to
 * sit above the sections, each chip collapsing the screen to the one section
 * that held it. The mock
 * (`ui-ideas/auntieos-manage-bookings-2026-05-27-cardsShouldOpenDisplayingFullerDetails.html`)
 * has no such row: the three status sections ARE the filter, they are all open
 * at once, and each carries its own count. A chip row on top of them asked the
 * operator to pick a status twice to read one list.
 *
 * Nothing became unreachable in the removal. Every state the tabs named still
 * renders, under the section that owns it, with its own chip: DRAFT and PENDING
 * under "Pending approval", SCHEDULED under "Scheduled", COMPLETED / CANCELLED
 * and any unrecognized status under "History" (see SECTIONS below).
 */

// ── status sections ─────────────────────────────────────────────────────────

export type BookingSectionKey = 'pending' | 'scheduled' | 'history';

export interface BookingSection {
  key: BookingSectionKey;
  label: string;
  rows: BookingEntry[];
}

/** How a section orders its own rows once membership is decided. */
type SectionSort = 'soonest' | 'mostRecent' | 'stream';

interface SectionDef {
  key: BookingSectionKey;
  label: string;
  test: (state: BookingState) => boolean;
  /** Shown in place of the rows when the section holds none. */
  emptyHint: string;
  sort: SectionSort;
}

/**
 * The mock's three headings, and the ONE place a status is mapped to a bucket.
 *
 * Every predicate is a POSITIVE membership test against the enumerated
 * `BookingState`, never a negation of another bucket (the AO-12-style
 * discipline in lib/bookingFormat.ts). `unknown` is filed under History
 * deliberately: a row whose status this tree does not recognize still has to
 * appear somewhere, and History's own count has included it since this screen
 * shipped. A section set that covered five of the six states would make a real
 * booking invisible, which is the failure mode `lib/bookingFormat.ts` exists to
 * prevent.
 *
 * `pending` holds DRAFT and PENDING together: both are pre-visit states that
 * have not become a scheduled visit, which is what this section's own count and
 * BookingScreen.kt's "Pending approval" have always meant.
 */
const SECTIONS: readonly SectionDef[] = [
  {
    key: 'pending',
    label: 'Pending approval',
    test: (s) => s === 'draft' || s === 'pending',
    emptyHint: 'Nothing is waiting on a reply.',
    // Matches the Android counterpart (`groupBookingsByStatus` in
    // ScheduleViewScreen.kt): "Pending keeps the order the stream delivered."
    // These are requests waiting on a HUMAN, not a schedule, so the read that
    // matters is which one arrived first, and BOOKINGS_QUERY already streams
    // newest-created first.
    sort: 'stream',
  },
  {
    key: 'scheduled',
    label: 'Scheduled',
    test: (s) => s === 'scheduled',
    emptyHint: 'Nothing on the books. A request moves here once you approve it.',
    // #699: a to-do list reads soonest first. `BOOKINGS_QUERY` orders by
    // `createdAt` (the one field every row genuinely carries), so the streamed
    // order was the order the record was WRITTEN, not the order the visit
    // HAPPENS, and thirteen rows under one heading came out looking shuffled.
    sort: 'soonest',
  },
  {
    key: 'history',
    label: 'History',
    test: (s) => s === 'completed' || s === 'cancelled' || s === 'unknown',
    emptyHint: 'No finished visits yet.',
    // A record reads most-recent-first, same as Android's History section.
    sort: 'mostRecent',
  },
];

/**
 * Orders one section's rows by the visit's own start time (falling through
 * the same `completedAt` / `departedAt` / `createdAt` chain `bookingWhen`
 * displays, via `bookingSortTimeMs`), rather than the `createdAt`-descending
 * order `BOOKINGS_QUERY` streams rows in.
 *
 * A row with no parseable time sorts LAST regardless of direction: it is
 * neither the soonest nor the most recent, it is unknown, and putting it at
 * either end would misplace it next to rows that really do carry that time.
 * Rows tie-broken by their position in the streamed page, so two undated rows
 * (or two with the exact same instant) keep a stable relative order instead of
 * shuffling on every re-render.
 */
function sortSectionRows(rows: readonly BookingEntry[], sort: SectionSort): BookingEntry[] {
  if (sort === 'stream') return [...rows];
  const direction = sort === 'soonest' ? 1 : -1;
  return rows
    .map((entry, index) => ({ entry, index, ms: bookingSortTimeMs(entry) }))
    .sort((a, b) => {
      if (a.ms === null && b.ms === null) return a.index - b.index;
      if (a.ms === null) return 1;
      if (b.ms === null) return -1;
      return (a.ms - b.ms) * direction;
    })
    .map((v) => v.entry);
}

/**
 * Split the streamed rows into the mock's three status sections.
 *
 * Always returns all three, in this order, EMPTY ONES INCLUDED, so the screen
 * can say what a section is waiting for rather than silently dropping the
 * heading and leaving the operator to wonder whether it failed to load.
 *
 * #699: each section then orders ITS OWN rows by visit start time (see
 * `sortSectionRows`), rather than preserving `BOOKINGS_QUERY`'s
 * `createdAt`-descending stream order. That used to read as random to an
 * operator looking at visit dates, because it is: the record-creation order
 * has no relationship to the visit's own date once bookings are made out of
 * sequence, which they are.
 */
export function groupBookingsByStatus(rows: readonly BookingEntry[]): BookingSection[] {
  const views = rows.map((entry) => ({ entry, state: bookingState({ status: entry.status }) }));
  return SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    rows: sortSectionRows(
      views.filter((v) => section.test(v.state)).map((v) => v.entry),
      section.sort,
    ),
  }));
}

/**
 * How many History rows are drawn before "Load more".
 *
 * History is where the volume is (96 of the 100 rows on the live screen) and it
 * used to sit behind a single "Show N finished" press, which is not what the
 * mock does: its History section is OPEN like the other two (#704). Open and
 * unbounded would put ninety-six cards under the two sections that need
 * answering, so the section is open and PAGED, the same "Load more" the
 * Invoices, Sessions and KinTales lists already use for their long tails.
 */
const HISTORY_PAGE_SIZE = 25;

interface BookingsProps {
  /**
   * Row-select hook. The router mounts this screen with no selection handler
   * (no detail ROUTE exists), so by default this screen wires its OWN: selecting
   * a row opens `BookingDetailModal`, the full detail sheet, fed from the SAME
   * live BOOKINGS_QUERY stream this list already reads (no second fetch, see the
   * `detailEntry` lookup below). Passing `onSelectBooking` explicitly overrides
   * that default, letting a future detail ROUTE (or a test) own selection
   * instead; when overridden, this screen's own overlay never renders (see the
   * `!onSelectBooking` guard it renders under).
   */
  onSelectBooking?: (bookingId: string) => void;
  /**
   * Opens this booking's detail sheet on mount. Set by the router from
   * `/bookings?bookingId=<flat session id>`, where a booking notification's
   * "Open" lands (`lib/notificationActions.ts` derives the flat id from the
   * envelope visit id the notification carries).
   *
   * Resolved BY ID, not by searching the streamed page: BOOKINGS_QUERY is the
   * 200 newest sessions, so an older visit would otherwise open nothing and
   * leave the operator on the list, issue #389's complaint exactly. An id with
   * no session behind it (a visit still awaiting approval has none yet) gets the
   * "Booking unavailable" dialog rather than silence.
   */
  initialBookingId?: string;
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
 * lib/bookingFormat.ts) into the mock's three status sections.
 *
 * LAID OUT AS THE MOCK LAYS IT OUT (#704): a plain "Bookings" heading carrying
 * Select and New booking, the visit-requests queue as one compact banner, then
 * Pending approval / Scheduled / History straight after, each with its own
 * count and all three open. What used to sit between the heading and the first
 * section (a Pending / Scheduled / History stat strip and a six-chip filter tab
 * row) is gone: the strip's three numbers ARE the section counts, and the tabs
 * asked for a status the sections already separate.
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
export function Bookings({ onSelectBooking, initialBookingId }: BookingsProps) {
  const navigate = useNavigate();
  const rows = useCollection<BookingEntry>(BOOKINGS_QUERY);
  // History is open like every other section, and grows a page at a time. It
  // used to be closed behind "Show N finished", which the mock does not do.
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE_SIZE);
  // The overlay's own selection state, used only when no external
  // onSelectBooking is supplied (see BookingsProps's doc above). Seeded from the
  // deep link so `/bookings?bookingId=<id>` opens the sheet on arrival.
  const [detailId, setDetailId] = useState<string | null>(initialBookingId ?? null);
  const handleSelectBooking = onSelectBooking ?? setDetailId;

  // The "New booking request" create surface (AO-25). It writes the envelope
  // model ('requested'), a DIFFERENT collection from the kin_care_sessions this
  // list streams, so the created request lands in the Incoming-requests queue
  // for approval and does NOT appear below until approved: the success banner
  // says so rather than leaving the operator to wonder.
  const [showCreate, setShowCreate] = useState(false);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  /**
   * The operator's KinCare catalog and booking windows, for the one meta line
   * under each name (`lib/bookingFormat.ts#bookingMetaLine`). One-shot read of
   * `business_settings`, the same `getBusinessSettings` + `live`-guard shape
   * Schedule.tsx and NewBookingDialog.tsx already use.
   *
   * FAILS QUIET, on purpose, and the empty catalog is an honest degrade rather
   * than a hidden fault: with no rates map a row shows the raw `serviceType` it
   * stores, which is exactly what every row showed before #704, and with no
   * time blocks it names the clock time instead of the window. Neither is a
   * fabricated value, and neither is worth a banner over a list that reads
   * correctly without it. A read this screen genuinely depends on
   * (BOOKINGS_QUERY) still surfaces its own failure through AsyncRegion.
   */
  const [catalog, setCatalog] = useState<BookingCatalog>(EMPTY_BOOKING_CATALOG);
  useEffect(() => {
    let live = true;
    getBusinessSettings()
      .then((settings) => {
        if (!live) return;
        setCatalog({
          serviceRates: settings.serviceRates,
          serviceDurations: settings.serviceDurations,
          timeBlocks: settings.timeBlocks,
        });
      })
      .catch(() => {
        // See the state's doc above: the empty catalog IS the fallback.
      });
    return () => {
      live = false;
    };
  }, []);

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
  /**
   * The open reschedule sheet's plan (#397 M16), or null when it is closed.
   *
   * RESCHEDULE DOES NOT GO THROUGH `confirmAction`, and cannot: that state is
   * typed to the generated `BatchBookingAction`, which is the three transitions
   * `batchUpdateBookings` accepts and nothing else. A reschedule is not a
   * transition and not one press, it is a per-visit sheet, so the bar opens it
   * instead of asking a yes/no question the operator has no way to answer yet.
   */
  const [reschedulePlan, setReschedulePlan] = useState<{
    eligible: RescheduleTarget[];
    skipped: BulkSkip[];
  } | null>(null);
  const [rescheduleOutcome, setRescheduleOutcome] = useState<BulkRescheduleOutcome | null>(null);

  function leaveSelectMode() {
    setSelecting(false);
    setSelectedIds(new Set());
    setConfirmAction(null);
  }

  /**
   * Open the per-visit review sheet on the current selection.
   *
   * The plan is taken HERE, from the live rows, rather than inside the sheet:
   * the sheet is handed visits that can really be moved plus the reasons the
   * others were left out, so a selected row is never simply missing from it.
   */
  function openReschedule() {
    if (rows.status !== 'ready') return;
    setOutcome(null);
    setRescheduleOutcome(null);
    setConfirmAction(null);
    setReschedulePlan(planBulkReschedule(rows.data, selectedIds));
  }

  /**
   * The sheet closed. `null` means the operator backed out before confirming,
   * so nothing was written and the selection is left exactly as it was.
   *
   * Otherwise everything that landed leaves the selection and everything that
   * did not stays picked, which is the same rule `runBulk` follows: a retry is
   * one press and not a re-hunt through the list.
   */
  function closeReschedule(result: BulkRescheduleOutcome | null) {
    setReschedulePlan(null);
    if (result === null) return;
    setRescheduleOutcome(result);
    setSelectedIds(
      new Set([...result.failures.map((f) => f.id), ...result.skipped.map((s) => s.id)]),
    );
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

  /**
   * The Select toggle, rendered TWICE and driving one piece of state (#701).
   *
   * Operator: "Select needs to be near the fucking block it's used for". It had
   * been sitting in the page heading alone, roughly 750px above the first row it
   * picks, with two unrelated blocks in between. It now also sits on the list
   * toolbar, immediately above the sections whose rows it reveals checkboxes on,
   * and the mock's page-header copy keeps its own.
   *
   * ONE control, two places, never two modes: both press the same handler and
   * both report the same `aria-pressed`, so there is no way for one to say
   * Select is on while the other says it is off.
   */
  const selectToggle = (
    <GhostButton
      label="Select"
      pressed={selecting}
      onClick={() => (selecting ? leaveSelectMode() : setSelecting(true))}
    />
  );

  // A DEEP-LINKED id is read BY ID as well, because the stream below is the 200
  // newest sessions and a notification can name an older one. Only ever the id
  // the link carried: `detailId` also holds ids picked from rows, and letting
  // the fetched document answer for one of those would leak it into a later
  // selection.
  const deepLinkId =
    initialBookingId !== undefined && detailId === initialBookingId ? initialBookingId : null;
  const deepLinked = useDocById<BookingEntry>('kin_care_sessions', deepLinkId);

  // The row the detail sheet shows. Preferred from the SAME live stream `rows`
  // already holds (never a second fetch for a row already on screen): once a
  // write round-trips through Firestore, this listener's next snapshot updates
  // `detailEntry` too. The by-id read is the fallback, and it is live for the
  // same reason. `null` once both have answered means the booking really is not
  // there, and gets its own honest "unavailable" dialog below, never a blank
  // sheet.
  const streamedEntry =
    detailId !== null && rows.status === 'ready'
      ? (rows.data.find((r) => r._id === detailId) ?? null)
      : null;
  const deepLinkedEntry =
    deepLinkId !== null && deepLinked.status === 'ready' ? deepLinked.data : null;
  const detailEntry = streamedEntry ?? deepLinkedEntry;

  // Still resolving. Without this the "unavailable" dialog flashes over every
  // deep link for as long as the reads take, which reads as a dead link even
  // when the booking is about to open.
  const detailPending =
    detailId !== null &&
    detailEntry === null &&
    (rows.status === 'loading' || (deepLinkId !== null && deepLinked.status === 'loading'));

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Bookings"
        title="Bookings"
        subtitle="Pending requests and scheduled visits"
        trailing={
          <>
            {selectToggle}
            <PrimaryButton label="New booking" onClick={() => setShowCreate(true)} />
          </>
        }
      />

      {createNotice !== null && (
        <Banner tone="success" title="Request created" onDismiss={() => setCreateNotice(null)}>
          {createNotice}
        </Banner>
      )}

      {/* #399 item 2 and #438, in one queue. Above the list because it is work
          waiting on a human, not a view of the schedule: a household has asked
          to move or cancel a visit and nothing happens until someone here
          accepts or declines. #698: reserves its own space with a loading
          panel while its three callables are in flight and says so plainly
          when nothing is waiting, rather than popping in late. #704: it is one
          compact banner rather than an open list of request cards, because the
          mock puts the three status sections directly under the heading and a
          queue that is usually empty was pushing the first one to y=580. */}
      <VisitRequestsSection />
      {outcome !== null && <BulkOutcomeBanner outcome={outcome} onDismiss={() => setOutcome(null)} />}
      {rescheduleOutcome !== null && (
        <BulkRescheduleBanner
          outcome={rescheduleOutcome}
          onDismiss={() => setRescheduleOutcome(null)}
        />
      )}

      {bulkError !== null && (
        <Banner tone="error" title="The household's copy was not updated" onDismiss={() => setBulkError(null)}>
          {bulkError}
        </Banner>
      )}

      {/* The list's own header: what order the sections are in, and the Select
          toggle that acts on them (#701). The page heading above owns the
          screen's name; repeating "Bookings" here as a second heading would
          announce a section that is the whole page. */}
      <div className="bookings__toolbar" role="group" aria-label="Bookings list">
        <p className="bookings__toolbar-note">
          Pending: newest request first. Scheduled: soonest visit first. History: most recent
          first. Capped at 200.
        </p>
        {selectToggle}
      </div>

      <AsyncRegion
        state={rows}
        what="bookings"
        isEmpty={(data) => data.length === 0}
        loading={<p className="bookings__hint">Loading bookings…</p>}
        empty={<EmptyHint>No bookings yet. New requests land here.</EmptyHint>}
      >
        {(data) =>
          groupBookingsByStatus(data).map((section) => (
            <BookingSectionBlock
              key={section.key}
              section={section}
              catalog={catalog}
              // History is where the volume is: 96 of the 100 rows on the live
              // screen. Open like the other two, per the mock, and drawn a page
              // at a time so those 96 do not bury the ones needing an answer.
              limit={section.key === 'history' ? historyShown : null}
              onShowMore={() => setHistoryShown((n) => n + HISTORY_PAGE_SIZE)}
              onSelectBooking={handleSelectBooking}
              selecting={selecting}
              selectedIds={selectedIds}
              onTogglePick={toggleRow}
            />
          ))
        }
      </AsyncRegion>

      {selecting && selectedIds.size > 0 && (
        <BulkBar
          count={selectedIds.size}
          confirming={confirmAction}
          running={running}
          onAsk={setConfirmAction}
          onBack={() => setConfirmAction(null)}
          onRun={(action) => void runBulk(action)}
          onReschedule={openReschedule}
          onClear={() => {
            setSelectedIds(new Set());
            setConfirmAction(null);
          }}
        />
      )}

      {reschedulePlan !== null && (
        <BulkRescheduleDialog
          targets={reschedulePlan.eligible}
          skipped={reschedulePlan.skipped}
          onClose={closeReschedule}
        />
      )}

      {/* Only this screen's OWN selection renders its own overlay; an external
          onSelectBooking (see the prop's doc) means the caller owns the detail
          UI instead. A selected id that no longer resolves to a row says so,
          rather than opening a sheet with nothing in it. */}
      {!onSelectBooking &&
        detailId !== null &&
        (detailPending ? (
          <Dialog title="Opening booking" onClose={() => setDetailId(null)}>
            <p className="bookings__hint">Looking this booking up…</p>
          </Dialog>
        ) : detailEntry === null && deepLinkId !== null && deepLinked.status === 'error' ? (
          // A READ THAT FAILED IS NOT A BOOKING THAT IS GONE. Both leave
          // `detailEntry` null, and collapsing them would tell the operator a
          // network blip meant the visit had been cancelled, which is the
          // error-as-empty conflation lib/async.ts exists to refuse. The
          // failure gets its own dialog, its own message, and the retry the
          // hook hands back.
          <Dialog
            title="Couldn't open this booking"
            onClose={() => setDetailId(null)}
            footer={<GhostButton label="Done" onClick={() => setDetailId(null)} />}
          >
            <p className="bookings__hint" role="alert">
              This booking couldn&rsquo;t be read. {deepLinked.message}
              {deepLinked.retry && (
                <button type="button" className="async-retry" onClick={deepLinked.retry}>
                  Retry
                </button>
              )}
            </p>
          </Dialog>
        ) : detailEntry === null ? (
          <Dialog
            title="Booking unavailable"
            onClose={() => setDetailId(null)}
            footer={<GhostButton label="Done" onClick={() => setDetailId(null)} />}
          >
            {/* THE THIRD READING MATTERS as much as the other two, and it is the
                one a notification produces: a visit that is still REQUESTED has
                no session document at all, because approval is what creates one
                (approveBookingSeriesCore.ts). Saying only "cancelled or removed"
                would send the operator looking for a booking that is sitting in
                the incoming-requests queue waiting for them. */}
            <p className="bookings__hint">
              This booking isn&rsquo;t available to open. A visit gets its own record only once
              the request is approved, so a request still waiting on you has none yet. Otherwise
              it may have been cancelled or removed.
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

// ── one status section ──────────────────────────────────────────────────────

interface BookingSectionBlockProps {
  section: BookingSection;
  catalog: BookingCatalog;
  /** Rows drawn before "Load more", or `null` for a section that draws them all. */
  limit: number | null;
  onShowMore: () => void;
  onSelectBooking: (bookingId: string) => void;
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  onTogglePick: (bookingId: string) => void;
}

/**
 * One of the mock's three status blocks: a heading, the count beside it, and
 * either the rows or a line saying what the section is waiting for.
 *
 * ALWAYS OPEN (#704). History used to render as a single "Show N finished"
 * button, so the section the mock draws as a list of cards was one control. It
 * is a list of cards now, capped at `limit` with a "Load more" underneath that
 * says how many are still to come, which keeps the two sections above it
 * readable without hiding the third behind a press.
 *
 * `role="group"` with `aria-labelledby`, not a bare `<section>`: a named
 * `<section>` is a landmark REGION, and three landmarks for three parts of one
 * list would tell a screen-reader user this page has three top-level areas when
 * it has one. The heading still carries the name either way.
 *
 * The count lives INSIDE the heading rather than beside it so it is part of the
 * section's accessible name: "History 96" answers "how much is under here"
 * without moving focus into the section to count. It is also the ONLY place
 * that number is now stated: the three stat cards that used to repeat it above
 * the list are gone (#704).
 */
function BookingSectionBlock({
  section,
  catalog,
  limit,
  onShowMore,
  onSelectBooking,
  selecting,
  selectedIds,
  onTogglePick,
}: BookingSectionBlockProps) {
  const headingId = `bookings-section-${section.key}`;
  // Non-null: SECTIONS is what produced this section's key.
  const def = SECTIONS.find((s) => s.key === section.key)!;
  const shown = limit === null ? section.rows : section.rows.slice(0, limit);
  const remaining = section.rows.length - shown.length;

  return (
    <section className="bookings__section" role="group" aria-labelledby={headingId}>
      <h3 className="bookings__section-head" id={headingId}>
        {section.label} <span className="bookings__section-count">{section.rows.length}</span>
      </h3>
      {section.rows.length === 0 ? (
        <EmptyHint>{def.emptyHint}</EmptyHint>
      ) : (
        <ul className="bookings__list">
          {rowViewsFor(shown).map((v) => (
            <BookingRow
              key={v.entry._id}
              view={v}
              catalog={catalog}
              onSelectBooking={onSelectBooking}
              selecting={selecting}
              picked={selectedIds.has(v.entry._id)}
              onTogglePick={onTogglePick}
            />
          ))}
        </ul>
      )}
      {remaining > 0 && (
        <div className="bookings__more">
          <GhostButton label={`Load ${remaining} more`} onClick={onShowMore} />
        </div>
      )}
    </section>
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
  /** Opens the per-visit review sheet. Not an action this bar can fire itself. */
  onReschedule: () => void;
  onClear: () => void;
}

/**
 * The mock's floating bar: a live count, the three transitions, Reschedule, and
 * a way to back out of the selection. Rendered only while Select is on AND
 * something is picked, matching the mock's own `bar.classList.toggle('show',
 * picked.length > 0)`.
 *
 * The mock labels this button "Clear", and `onClear` does exactly what that
 * says: `setSelectedIds(new Set())` plus dropping any pending confirm. It
 * touches no booking data. But sitting next to Approve and Reject, "Clear"
 * reads as "clear the records", which is why the operator asked what it did.
 * Labelled "Deselect all" instead, the same rename `ui-ideas/` never had to
 * make because nobody had put it next to two destructive-sounding verbs yet.
 *
 * RESCHEDULE IS THE ONE BUTTON HERE THAT ASKS A QUESTION INSTEAD OF ANSWERING
 * ONE (#397 M16). This comment used to say the mock's fourth button could not
 * be built, on the grounds that many visits do not share one new window and
 * `rescheduleBooking` takes one session and one time. The mechanism was right
 * and the conclusion was wrong: the operator's ruling is a per-visit review
 * sheet, so the press opens `BulkRescheduleDialog` with a prefilled field per
 * selected visit, and the sheet is what supplies the distinct window each call
 * needs. It therefore goes nowhere near `confirming`, which is the yes/no step
 * for the three one-press transitions.
 */
function BulkBar({
  count,
  confirming,
  running,
  onAsk,
  onBack,
  onRun,
  onReschedule,
  onClear,
}: BulkBarProps) {
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
          <GhostButton label="Reschedule" onClick={onReschedule} disabled={running} />
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

/**
 * What the reschedule sheet did, kept on the screen after the sheet closes.
 *
 * A SECOND COPY OF THE RESULT, ON PURPOSE. The sheet shows the same per-visit
 * verdicts while it is open, because that is where the override retry lives;
 * this survives it being dismissed, so an operator who closed the sheet still
 * has the list of which households did not move and why. Same shape and same
 * split as the banner above: a failure was attempted and refused, a skip was
 * never attempted at all.
 */
function BulkRescheduleBanner({
  outcome,
  onDismiss,
}: {
  outcome: BulkRescheduleOutcome;
  onDismiss: () => void;
}) {
  const clean = outcome.failures.length === 0 && outcome.skipped.length === 0;
  return (
    <Banner
      tone={outcome.failures.length > 0 ? 'error' : clean ? 'success' : 'warning'}
      title={bulkRescheduleSummary(outcome)}
      onDismiss={onDismiss}
    >
      {outcome.applied.length > 0 && (
        <>
          <p className="bookings__bulk-result-head">Moved:</p>
          <ul className="bookings__bulk-result">
            {outcome.applied.map((a) => (
              <li key={a.id}>
                <strong>{a.name}</strong>: now {bookingWhenLabel(a.startTime)}
              </li>
            ))}
          </ul>
        </>
      )}
      {outcome.failures.length > 0 && (
        <>
          <p className="bookings__bulk-result-head">Not moved:</p>
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
          <p className="bookings__bulk-result-head">Left where they are:</p>
          <ul className="bookings__bulk-result">
            {outcome.skipped.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </Banner>
  );
}

interface BookingRowProps {
  view: RowView;
  catalog: BookingCatalog;
  onSelectBooking?: ((bookingId: string) => void) | undefined;
  /** Select mode is on: the row shows its checkbox. */
  selecting: boolean;
  picked: boolean;
  onTogglePick: (bookingId: string) => void;
}

/**
 * One booking card, in the mock's own order (#704): the select checkbox, a
 * coloured accent stripe in the status's own hue, the initials avatar, then the
 * name, the one service/date/window line, the status pill DIRECTLY UNDER the
 * name, and the note.
 *
 * The pill used to sit at the far right of the row, pushed there by the
 * name block's `flex: 1`. That put the one fact that decides what to do with a
 * booking at the opposite end of the card from the booking's name, and left the
 * stripe's job (status at a glance, down the left edge) undone entirely.
 *
 * NO INLINE ACTION BUTTONS, and this is a DEPARTURE FROM THE MOCK held on
 * purpose. The mock draws Approve / Reject on a pending card and Cancel on a
 * scheduled one; commit cd594d4 took them off when the card started opening
 * `BookingDetailModal`, which carries all four transitions with the full record
 * in front of the operator. #704 lists that difference and explicitly does not
 * rule on it, so it stays as cd594d4 chose rather than being reinstated by a
 * pass that was asked to fix the list's shape.
 */
function BookingRow({
  view,
  catalog,
  onSelectBooking,
  selecting,
  picked,
  onTogglePick,
}: BookingRowProps) {
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
  const meta = bookingMetaLine(entry, catalog);
  const kinfolkNotes = entry.kinfolkNotes ?? '';
  const notePreview = kinfolkNotes.trim() !== '' ? kinfolkNotes : (entry.notes ?? '');

  const body = (
    <>
      <span
        className={`bookings__row-accent bookings__row-accent--${info.cssClass}`}
        aria-hidden="true"
      />

      <Avatar
        label={displayName}
        initials={initialsFor(displayName)}
        gradientSeed={entry.kinfolkId !== '' ? entry.kinfolkId : displayName}
        size={44}
        shape="rounded"
      />

      <span className="bookings__row-who">
        <span className="bookings__row-name">{displayName}</span>
        <span className="bookings__row-meta">{meta}</span>
        <span className={`bookings__chip bookings__chip--${info.cssClass}`}>{info.chipLabel}</span>
        {notePreview.trim() !== '' && (
          <span className="bookings__row-note">Note: {notePreview.slice(0, 120)}</span>
        )}
      </span>
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
