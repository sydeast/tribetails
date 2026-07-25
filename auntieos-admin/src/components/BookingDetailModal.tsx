import { useCallback, useEffect, useRef, useState } from 'react';
import { type ScheduleSessionEntry } from '../api/schedule';
import {
  type BookingNoteEntry,
  bookingNotesQuery,
  noteAuthorLabel,
  noteBody,
  sortNotes,
} from '../api/bookingNotes';
import {
  addBookingNote,
  addInternalBookingNote,
  assignAuntie,
  getVisitAssignment,
  rescheduleBooking,
} from '../api/bookingsWrite';
import { listStaff, staffLabel, type StaffMember } from '../api/staff';
import { getKinfolkProfile } from '../api/kinfolkProfile';
import { useCollection } from '../lib/firestore';
import { arr, str } from '../lib/coerce';
import {
  bookingWhenLabel,
  buildRescheduleTimes,
  durationLabel,
  localDateInput,
  localTimeInput,
  noteLockReason,
  notesLocked,
  visitDurationMinutes,
} from '../lib/bookingDetailFormat';
import { sessionHousehold, sessionState, sessionStateInfo } from '../lib/sessionFormat';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import { DenPanel, EmptyHint, ServicePill } from './DenScreenKit';
import './BookingDetailModal.css';

/** Whatever a rejected callable or Firestore read gave us, as operator copy. */
function failure(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * Why an assignment or a note thread is unavailable on a legacy flat session.
 * Shown, never implied by an absent control: an operator who cannot see the
 * Assigned Auntie row has no way to tell "nobody is assigned" from "this visit
 * cannot be assigned", and the archive (and android) both left them guessing.
 */
const NO_ENVELOPE_ASSIGN =
  'This visit is not part of a booking request, so there is no visit record to assign against. Assignment lives on the request, and only visits approved from one carry it.';
const NO_ENVELOPE_NOTES =
  'This visit is not part of a booking request, so there is no visit record to attach notes to. Notes live on the request, and only visits approved from one carry it.';

export interface BookingDetailModalProps {
  /**
   * The session row, BY VALUE from the live `SCHEDULE_SESSIONS_QUERY` stream
   * the Schedule screen already holds (the `InvoiceDetail.tsx` convention), so
   * a successful reschedule flows back through that listener rather than
   * needing a manual refetch here.
   */
  entry: ScheduleSessionEntry;
  onClose: () => void;
  /**
   * Route to the household record. Omit and the kinfolk name renders as static
   * text rather than a link that goes nowhere (the `Buttons.tsx` rule: no live
   * no-op controls).
   */
  onOpenKinfolk?: (kinfolkId: string) => void;
  /** Route to a sent KinTale. Same omit-means-static rule. */
  onOpenKinTale?: (kinTaleId: string) => void;
  /** Injected clock for the note cutoff, so the lock is testable. */
  nowMs?: () => number;
}

/**
 * The Schedule agenda's per-visit detail sheet: the React port of the archive's
 * `BookingDetailModal.kt` (556 lines), which the wasm-to-React port dropped
 * entirely. Closes operator issue 16 ("restore opening info cards and hyperlink
 * from calendar entries to KinTale/Kinfolk details").
 *
 * WHAT IT SHOWS: the facts the operator named, kinfolk (linked), service
 * address, requested services, duration, date and time, plus status, the
 * booking's own request notes, the assigned Auntie, and a link to the visit's
 * KinTale.
 *
 * WHAT IT WRITES, all through callables that were already deployed:
 *   rescheduleBooking        the flat `kin_care_sessions` row (any session)
 *   assignAuntie             the envelope visit doc (envelope sessions only)
 *   addBookingNote           kinfolk-facing thread   (envelope sessions only)
 *   addInternalBookingNote   staff-only thread       (envelope sessions only)
 *
 * THE ENVELOPE SPLIT is the one thing to understand before changing anything
 * here. A session created by approving a booking request carries
 * `kinCareBatchId`/`kinCareVisitId`, which address
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`. That doc, not
 * the flat session row, is where the assignment and both note subcollections
 * live. A session created ad hoc has neither id and therefore has no such doc,
 * so those three surfaces are genuinely unavailable, and this sheet SAYS SO
 * instead of quietly rendering them missing or empty.
 *
 * ARCHIVE FIXES, deliberate divergences rather than porting slips:
 *  - Times are read and written as real instants in the operator's LOCAL zone.
 *    The archive prefilled its reschedule fields by slicing the stored UTC
 *    string, so an evening visit prefilled as the next morning (AO-18).
 *  - The note threads read the nested `kinCares/{visitId}` path the server
 *    actually writes to; the archive read the flat parent path and so never
 *    displayed a note back. See `api/bookingNotes.ts`.
 *  - Both composers lock at the 3-hour cutoff. The server only enforces it on
 *    the kinfolk-facing one; the internal lock is a client policy, flagged in
 *    `api/bookingsWrite.ts#addInternalBookingNote`.
 */
export function BookingDetailModal({
  entry,
  onClose,
  onOpenKinfolk,
  onOpenKinTale,
  nowMs = Date.now,
}: BookingDetailModalProps) {
  const kinfolkId = str(entry.kinfolkId);
  const batchId = str(entry.kinCareBatchId);
  const visitId = str(entry.kinCareVisitId);
  // All three, not two: the notes path and the assign payload each need every
  // segment, so a session with a batch id and no visit id is just as unusable.
  const isEnvelopeVisit = kinfolkId !== '' && batchId !== '' && visitId !== '';

  const startTime = str(entry.startTime);
  const household = sessionHousehold(str(entry.kinfolkName));
  const stateInfo = sessionStateInfo(sessionState(str(entry.status)));
  const durationMinutes = visitDurationMinutes(entry);
  const locked = notesLocked(startTime, nowMs());
  const reportIds = arr<string>(entry.reportIds).filter((id) => typeof id === 'string' && id !== '');

  return (
    <Dialog title="Visit detail" onClose={onClose} variant="sheet">
      <div className="bdm">
        <DenPanel title="Booking" subtitle="What was asked for, and when.">
          <dl className="bdm__facts">
            <Fact label="Kinfolk">
              {onOpenKinfolk && kinfolkId !== '' ? (
                <button
                  type="button"
                  className="bdm__link"
                  onClick={() => onOpenKinfolk(kinfolkId)}
                >
                  {household}
                </button>
              ) : (
                household
              )}
            </Fact>
            <Fact label="Address">
              <AddressValue kinfolkId={kinfolkId} />
            </Fact>
            <Fact label="Requested services">
              <ServicePill serviceType={str(entry.serviceType)} />
            </Fact>
            <Fact label="Duration">{durationLabel(durationMinutes)}</Fact>
            <Fact label="When">{bookingWhenLabel(startTime)}</Fact>
            <Fact label="Status">
              <span className={`schedule__chip schedule__chip--${stateInfo.cssClass}`}>
                {stateInfo.chipLabel}
              </span>
            </Fact>
            <Fact label="Booking notes">
              {str(entry.notes).trim() === '' ? 'None on the request' : str(entry.notes)}
            </Fact>
          </dl>
        </DenPanel>

        <AssignedAuntiePanel
          kinfolkId={kinfolkId}
          batchId={batchId}
          visitId={visitId}
          enabled={isEnvelopeVisit}
        />

        <DenPanel title="KinTale" subtitle="The recap this visit sent home.">
          {reportIds.length === 0 ? (
            <EmptyHint>
              No KinTale for this visit yet. A draft appears here once it has been sent.
            </EmptyHint>
          ) : (
            <div className="bdm__kintales">
              {reportIds.map((id, index) => (
                <GhostButton
                  key={id}
                  label={reportIds.length === 1 ? 'Open the KinTale' : `Open KinTale ${index + 1}`}
                  {...(onOpenKinTale ? { onClick: () => onOpenKinTale(id) } : {})}
                />
              ))}
            </div>
          )}
        </DenPanel>

        <ReschedulePanel entry={entry} durationMinutes={durationMinutes} onDone={onClose} />

        {isEnvelopeVisit ? (
          <>
            <NotesPanel
              kinfolkId={kinfolkId}
              batchId={batchId}
              visitId={visitId}
              internal={false}
              locked={locked}
            />
            <NotesPanel
              kinfolkId={kinfolkId}
              batchId={batchId}
              visitId={visitId}
              internal
              locked={locked}
            />
          </>
        ) : (
          <DenPanel title="Notes" subtitle="Kinfolk-facing and internal threads.">
            <EmptyHint>{NO_ENVELOPE_NOTES}</EmptyHint>
          </DenPanel>
        )}
      </div>
    </Dialog>
  );
}

// ── facts ────────────────────────────────────────────────────────────────────

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bdm__fact">
      <dt className="bdm__fact-label">{label}</dt>
      <dd className="bdm__fact-value">{children}</dd>
    </div>
  );
}

/**
 * The service address, read from `kinfolk/{id}` on open.
 *
 * It is NOT on the session doc: `approveBookingSeriesCore.ts` copies the
 * household name onto a session but never the address, so the only honest
 * source is the household record itself. One `getDoc`, not a listener: an
 * address does not change while a detail sheet is open.
 */
function AddressValue({ kinfolkId }: { kinfolkId: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; value: string } | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    if (kinfolkId === '') {
      setState({ kind: 'ready', value: '' });
      return;
    }
    let alive = true;
    setState({ kind: 'loading' });
    void getKinfolkProfile(kinfolkId)
      .then((profile) => {
        if (alive) setState({ kind: 'ready', value: str(profile.serviceAddress).trim() });
      })
      .catch((err: unknown) => {
        if (alive) setState({ kind: 'error', message: failure(err) });
      });
    return () => {
      alive = false;
    };
  }, [kinfolkId]);

  if (state.kind === 'loading') return <>Loading the address…</>;
  // Fail loud: a read failure is not "no address on file", and treating it as
  // one would send an Auntie to a visit with no destination and no warning.
  if (state.kind === 'error') return <>Could not load the address: {state.message}</>;
  return <>{state.value === '' ? 'Not on file' : state.value}</>;
}

// ── assigned Auntie ──────────────────────────────────────────────────────────

interface AssignedAuntiePanelProps {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  /** False on a legacy flat session: the control renders DISABLED with the reason. */
  enabled: boolean;
}

function AssignedAuntiePanel({ kinfolkId, batchId, visitId, enabled }: AssignedAuntiePanelProps) {
  const [assignedUid, setAssignedUid] = useState<string | null>(null);
  const [assignedName, setAssignedName] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffLoading, setStaffLoading] = useState(false);
  const staffInFlight = useRef(false);

  // The canonical read on open. Assignment is never mirrored onto
  // `kin_care_sessions`, so the row the agenda already holds cannot answer it.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void getVisitAssignment(kinfolkId, batchId, visitId)
      .then((assignment) => {
        if (!alive) return;
        setAssignedUid(assignment.assignedAuntieUid);
        setAssignedName(assignment.auntieDisplayName);
      })
      .catch((err: unknown) => {
        if (alive) setError({ title: 'Could not read the assigned Auntie', message: failure(err) });
      });
    return () => {
      alive = false;
    };
  }, [enabled, kinfolkId, batchId, visitId]);

  // Loaded from the click, not from an effect keyed on `pickerOpen`: an effect
  // whose own loading flag is in its dependency list tears itself down mid
  // request and drops the result.
  const ensureRoster = useCallback(async () => {
    if (staff !== null || staffInFlight.current) return;
    staffInFlight.current = true;
    setStaffLoading(true);
    setStaffError(null);
    try {
      setStaff(await listStaff());
    } catch (err) {
      setStaffError(failure(err));
    } finally {
      staffInFlight.current = false;
      setStaffLoading(false);
    }
  }, [staff]);

  /**
   * Optimistic swap with revert. The row flips immediately so the operator sees
   * their choice land, the callable runs, and a rejection puts the previous
   * Auntie back AND says why, rather than leaving a name on screen that the
   * server never accepted.
   */
  async function changeAssignee(uid: string | null, optimisticName: string | null) {
    if (!enabled || assigning) return;
    const prevUid = assignedUid;
    const prevName = assignedName;
    setAssignedUid(uid);
    setAssignedName(optimisticName);
    setPickerOpen(false);
    setAssigning(true);
    setError(null);
    try {
      await assignAuntie(kinfolkId, batchId, visitId, uid);
    } catch (err) {
      setAssignedUid(prevUid);
      setAssignedName(prevName);
      setError({ title: 'Could not change the assigned Auntie', message: failure(err) });
      setAssigning(false);
      return;
    }
    // The write landed, so a failed re-read must NOT revert: the optimistic
    // name is now correct-but-unconfirmed, and the server owns the canonical
    // display name (it resolves it from `staff/{uid}`, we only guessed).
    try {
      const canonical = await getVisitAssignment(kinfolkId, batchId, visitId);
      setAssignedUid(canonical.assignedAuntieUid);
      setAssignedName(canonical.auntieDisplayName);
    } catch (err) {
      setError({ title: 'Assigned, but could not confirm the saved name', message: failure(err) });
    } finally {
      setAssigning(false);
    }
  }

  const displayed = assignedName ?? (assignedUid !== null ? 'Assigned' : 'Unassigned');

  return (
    <DenPanel title="Staffing" subtitle="Who is running this visit.">
      <dl className="bdm__facts">
        <Fact label="Assigned Auntie">{enabled ? displayed : 'Unavailable'}</Fact>
      </dl>

      <div className="bdm__row">
        <GhostButton
          label={assigning ? 'Saving…' : pickerOpen ? 'Hide the list' : 'Choose an Auntie'}
          disabled={!enabled || assigning}
          onClick={() => {
            const next = !pickerOpen;
            setPickerOpen(next);
            if (next) void ensureRoster();
          }}
        />
        <GhostButton
          label="Unassign"
          disabled={!enabled || assigning || assignedUid === null}
          onClick={() => void changeAssignee(null, null)}
        />
      </div>

      {!enabled && <EmptyHint>{NO_ENVELOPE_ASSIGN}</EmptyHint>}

      {pickerOpen && enabled && (
        <div className="bdm__picker">
          {staffError !== null ? (
            <Banner tone="error" title="Could not load the roster">
              {staffError}
              <div className="bdm__row">
                <GhostButton
                  label="Try again"
                  onClick={() => {
                    setStaffError(null);
                    void ensureRoster();
                  }}
                />
              </div>
            </Banner>
          ) : staffLoading || staff === null ? (
            <EmptyHint>Loading the roster…</EmptyHint>
          ) : staff.length === 0 ? (
            <EmptyHint>No staff on the roster yet.</EmptyHint>
          ) : (
            staff.map((member) => (
              <GhostButton
                key={member.uid}
                label={staffLabel(member)}
                disabled={assigning || member.uid === assignedUid}
                onClick={() => void changeAssignee(member.uid, staffLabel(member))}
              />
            ))
          )}
        </div>
      )}

      {error !== null && (
        <Banner tone="error" title={error.title}>
          {error.message}
        </Banner>
      )}
    </DenPanel>
  );
}

// ── reschedule ───────────────────────────────────────────────────────────────

interface ReschedulePanelProps {
  entry: ScheduleSessionEntry;
  durationMinutes: number;
  onDone: () => void;
}

function ReschedulePanel({ entry, durationMinutes, onDone }: ReschedulePanelProps) {
  const startTime = str(entry.startTime);
  const [date, setDate] = useState(() => localDateInput(startTime));
  const [time, setTime] = useState(() => localTimeInput(startTime));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ported from the archive: a visit that already ran (or was cancelled) is not
  // rescheduled, it is a different action. A blank status counts as scheduled,
  // matching `sessionState`'s own default.
  const status = str(entry.status).trim().toUpperCase();
  const canReschedule = status === '' || status === 'SCHEDULED';

  if (!canReschedule) {
    return (
      <DenPanel title="Reschedule" subtitle="Move this visit to a new date and time.">
        <EmptyHint>
          This visit is {stateWord(status)}, so it is no longer on the books to move.
        </EmptyHint>
      </DenPanel>
    );
  }

  async function submit() {
    if (busy) return;
    const times = buildRescheduleTimes(date, time, durationMinutes);
    if (times === null) {
      setError('Enter a real date and a time of day before rescheduling.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rescheduleBooking(entry._id, times.startTime, times.endTime);
      setBusy(false);
      // The live `kin_care_sessions` listener carries the new window back to
      // the agenda on its own, so the sheet closes rather than showing a stale
      // copy of the visit it just moved.
      onDone();
    } catch (err) {
      setBusy(false);
      setError(failure(err));
    }
  }

  return (
    <DenPanel
      title="Reschedule"
      subtitle={`Moving this visit keeps its length: ${durationLabel(durationMinutes)}.`}
    >
      <div className="bdm__row">
        <label className="bdm__field">
          <span className="bdm__field-label">New date</span>
          <input
            className="bdm__field-input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={busy}
            aria-label="New date"
          />
        </label>
        <label className="bdm__field">
          <span className="bdm__field-label">New time</span>
          <input
            className="bdm__field-input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={busy}
            aria-label="New time"
          />
        </label>
      </div>
      <PrimaryButton
        label={busy ? 'Rescheduling…' : 'Reschedule visit'}
        onClick={() => void submit()}
        disabled={busy}
        busy={busy}
      />
      {error !== null && (
        <Banner tone="error" title="Could not reschedule">
          {error}
        </Banner>
      )}
    </DenPanel>
  );
}

/** Lower-case status word for the "no longer on the books" copy. */
function stateWord(status: string): string {
  return sessionStateInfo(sessionState(status)).chipLabel.toLowerCase();
}

// ── note threads ─────────────────────────────────────────────────────────────

interface NotesPanelProps {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  /** True reads/writes the staff-only `internalNotes` subcollection. */
  internal: boolean;
  locked: boolean;
}

/**
 * One note thread plus its composer. A CHILD component, not an inline block,
 * so its `useCollection` subscription only exists when there is a real path to
 * subscribe to: a legacy flat session has no `kinCares/{visitId}` doc, and a
 * conditional hook in the parent would be illegal.
 */
function NotesPanel({ kinfolkId, batchId, visitId, internal, locked }: NotesPanelProps) {
  const state = useCollection<BookingNoteEntry>(
    bookingNotesQuery(kinfolkId, batchId, visitId, internal),
  );
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noun = internal ? 'internal note' : 'kinfolk-facing note';
  const composerLabel = internal ? 'Add an internal note' : 'Add a kinfolk-facing note';
  const listLabel = internal ? 'Internal notes' : 'Kinfolk-facing notes';

  async function save() {
    const body = draft.trim();
    if (body === '' || saving || locked) return;
    setSaving(true);
    setError(null);
    try {
      if (internal) await addInternalBookingNote(kinfolkId, batchId, visitId, body);
      else await addBookingNote(kinfolkId, batchId, visitId, body);
      setDraft('');
    } catch (err) {
      // Fail loud. The kinfolk-facing callable rejects late notes server-side
      // with its own message; showing it verbatim is how an operator learns
      // the difference between "blocked by the cutoff" and "the write broke".
      setError(failure(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DenPanel
      title={listLabel}
      subtitle={
        internal
          ? 'Staff only. The household never sees these.'
          : 'The household sees these on the booking.'
      }
    >
      {state.status === 'loading' && <EmptyHint>Loading the notes…</EmptyHint>}
      {state.status === 'error' && (
        <Banner tone="error" title="Could not load the notes">
          {state.message}
        </Banner>
      )}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <EmptyHint>No {noun}s yet.</EmptyHint>
        ) : (
          <ul className="bdm__notes" aria-label={listLabel}>
            {sortNotes(state.data).map((note) => (
              <li key={note._id} className="bdm__note">
                <span className="bdm__note-body">{noteBody(note)}</span>
                <span className="bdm__note-author">{noteAuthorLabel(note)}</span>
              </li>
            ))}
          </ul>
        ))}

      {locked && (
        <Banner tone="warning" title="Notes are closed for this visit">
          {noteLockReason()}
        </Banner>
      )}

      <label className="bdm__field bdm__field--wide">
        <span className="bdm__field-label">{composerLabel}</span>
        <textarea
          className="bdm__composer"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={locked || saving}
          aria-label={composerLabel}
        />
      </label>
      <PrimaryButton
        label={saving ? 'Saving…' : `Save ${noun}`}
        onClick={() => void save()}
        disabled={locked || saving || draft.trim() === ''}
        busy={saving}
      />
      {error !== null && (
        <Banner tone="error" title={`Could not save the ${noun}`}>
          {error}
        </Banner>
      )}
    </DenPanel>
  );
}
