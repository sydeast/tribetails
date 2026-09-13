import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyBookings } from '../api/portal';
import { addBookingNote, requestBookingCancellation, requestBookingReschedule } from '../api/bookingApi';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { viewOfQuery } from '../lib/queryState';
import {
  BOOKING_TIMELINE_STEPS,
  bookingStatusChip,
  bookingTimelineIndex,
  calTile,
  findBookingById,
  speciesEmoji,
  visitSubtitle,
  weekdayTime,
} from '../lib/portalFormat';
import '../styles/bookingdetail.css';

/**
 * Booking drill-in (B3, punchlist item): ported from
 * ui-ideas/mytribe-booking-detail-2026-05-31.html. There is no dedicated
 * getBookingById callable, same convention as KinDetail's getMyKin reuse, so
 * this reads the same ['myBookings', kinfolkId] cache Schedule.tsx already
 * populates and finds the visit by id (portalFormat.ts's findBookingById).
 *
 * Wires the two booking callables the portal allowlisted but never called:
 * addBookingNote (a note to the Auntie) and requestBookingCancellation. The
 * cancellation one is deliberately NOT called "Cancel booking" anywhere in
 * this screen: per the handler's own doc comment it stamps a request flag
 * for the business to act on, it does not cancel anything itself, so the
 * copy says "request" throughout.
 *
 * Both callables need a resolved `batchId`. A visit AuntieOS scheduled
 * directly (no booking envelope) surfaces here with `batchId: null` — see
 * getMyBookings.ts's session-without-envelope note — and shows an
 * explanatory line in place of the note box instead of a guaranteed-to-fail
 * call.
 */
export function BookingDetail() {
  const { visitId } = useParams({ from: '/schedule/$visitId' });
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();

  const bookings = useQuery({ queryKey: ['myBookings', kinfolkId], queryFn: () => getMyBookings(kinfolkId) });
  const { signOut, signingOut } = useSignOut();

  const [noteBody, setNoteBody] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [proposingReschedule, setProposingReschedule] = useState(false);
  const [proposedAt, setProposedAt] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [rescheduleProblem, setRescheduleProblem] = useState<string | null>(null);

  const found = findBookingById(bookings.data, visitId);

  const addNote = useMutation({
    mutationFn: (body: string) => {
      if (!found?.batchId) throw new Error('This visit is not linked to a booking yet, so notes are not available.');
      return addBookingNote(found.kinfolkId, found.batchId, found.id, body);
    },
    onSuccess: () => {
      setNoteSaved(true);
      setNoteBody('');
    },
  });

  const cancelVisit = useMutation({
    mutationFn: (reason: string) => {
      if (!found?.batchId) throw new Error('This visit is not linked to a booking yet, so it cannot be cancelled here.');
      return requestBookingCancellation(found.kinfolkId, found.batchId, found.id, reason);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myBookings', kinfolkId] });
      setConfirmingCancel(false);
      setCancelReason('');
    },
  });

  const reschedule = useMutation({
    mutationFn: (proposedStartTimeMs: number) => {
      if (!found?.batchId) throw new Error('This visit is not linked to a booking yet, so it cannot be moved here.');
      return requestBookingReschedule(found.kinfolkId, found.batchId, found.id, proposedStartTimeMs, rescheduleReason);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myBookings', kinfolkId] });
      setProposingReschedule(false);
      setProposedAt('');
      setRescheduleReason('');
      setRescheduleProblem(null);
    },
    onError: (err: unknown) => {
      // The server writes these messages for a household to read
      // (invalid-argument on a past time, already-exists on a second ask), so
      // they are shown as they arrive rather than flattened to "try again".
      setRescheduleProblem(err instanceof Error ? err.message : 'Could not send the request. Try again.');
    },
  });
  if (bookings.isError) {
    return (
      <LaunchError
        onRetry={() => void bookings.refetch()}
        retrying={bookings.isRefetching}
        onSignOut={signOut}
        signingOut={signingOut}
      />
    );
  }

  // Paused, this gate used to be false and the screen fell through to the
  // "not on your schedule" card below, about a schedule it never read.
  const bookingsView = viewOfQuery(bookings);
  if (bookingsView.kind === 'offline') {
    return (
      <>
        <PortalNav active="schedule" />
        <div className="wrap">
          <section className="glass card">
            <OfflineNotice what="this booking" />
          </section>
        </div>
      </>
    );
  }
  if (bookingsView.kind !== 'data') {
    return (
      <>
        <PortalNav active="schedule" />
        <div className="wrap">
          <p className="sub">Loading this booking…</p>
        </div>
      </>
    );
  }

  if (!found) {
    return (
      <>
        <PortalNav active="schedule" />
        <div className="wrap">
          <div className="crumbrow">
            <Link className="backlink" to="/schedule">
              {'←'} Back to Schedule
            </Link>
          </div>
          <section className="glass card">
            <h3 className="title">We couldn&rsquo;t find that booking.</h3>
            <p className="sub">It may have been removed. Head back to your schedule to see what&rsquo;s current.</p>
          </section>
        </div>
      </>
    );
  }

  const chip = bookingStatusChip(found.status);
  const timelineIndex = bookingTimelineIndex(found.status);
  const canAct = found.batchId !== null;
  // `cancelRequested` means an ask is PENDING, not "was ever asked". A declined
  // ask therefore reopens the button, which is the point: the household can ask
  // again with new information rather than being stuck behind a banner.
  const canRequestCancel = canAct && !found.cancelRequested && (found.status === 'requested' || found.status === 'confirmed');
  // Same window as a cancellation ask, and for the same reason: a visit that is
  // under way or finished is not moved by asking. A pending ask is handled
  // above this flag, by the branch that renders the waiting state instead.
  const canRequestReschedule =
    canAct &&
    found.rescheduleRequestStatus !== 'pending' &&
    (found.status === 'requested' || found.status === 'confirmed');
  const proposedLabel =
    found.rescheduleRequestedStartTimeMs !== null
      ? weekdayTime(found.rescheduleRequestedStartTimeMs)
      : '';
  const auntieLabel = found.auntieDisplayName ? `Auntie ${found.auntieDisplayName}` : 'your Auntie';
  const submitReschedule = () => {
    const ms = parseLocalDateTime(proposedAt);
    if (ms === null) {
      setRescheduleProblem('Pick a date and time first.');
      return;
    }
    if (ms <= Date.now()) {
      setRescheduleProblem('Pick a time in the future.');
      return;
    }
    setRescheduleProblem(null);
    reschedule.mutate(ms);
  };

  const submitNote = () => {
    const body = noteBody.trim();
    if (!body) return;
    addNote.mutate(body);
  };

  return (
    <>
      <PortalNav active="schedule" />

      <div className="wrap">
        <div className="crumbrow">
          <Link className="backlink" to="/schedule">
            {'←'} Back to Schedule
          </Link>
        </div>

        <header className="hero-greet" style={{ marginBottom: 22 }}>
          <div className="kick">Schedule</div>
          <div className="bk-head">
            <h1>{found.title ?? found.serviceType ?? 'Booking Details'}</h1>
            <span className={`chip lg ${chip.tone}`}>
              <span className="dot" />
              {chip.label}
            </span>
          </div>
        </header>

        {timelineIndex !== null && (
          <section className="glass timeline card d1">
            <div className="sectlabel">Status timeline</div>
            <div className="tl-track">
              <span className="tl-line">
                <i style={{ width: `${(timelineIndex / (BOOKING_TIMELINE_STEPS.length - 1)) * 100}%` }} />
              </span>
              {BOOKING_TIMELINE_STEPS.map((step, i) => (
                <div key={step.id} className={`tl-step ${i < timelineIndex ? 'done' : i === timelineIndex ? 'now' : ''}`}>
                  <div className="tl-dot">{i < timelineIndex ? '✓' : i + 1}</div>
                  <div className="lbl">{step.label}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="cols">
          <div className="stack">
            <section className="glass card d2">
              <div className="sectlabel">This booking</div>
              <div className="bk-fields">
                <div className="bk-field f1">
                  <div className="ic">{'\u{1F4CD}'}</div>
                  <div>
                    {/* #542: same kinfolk-facing concept as the wizard's step 2 — this
                        business sells by length of visit, so the word is a duration. */}
                    <div className="lab">KinCare Duration</div>
                    <div className="val">
                      {found.serviceType ?? 'Visit'}
                      <small>{found.startTimeMs !== null ? weekdayTime(found.startTimeMs) : 'Time to be confirmed'}</small>
                    </div>
                  </div>
                </div>
                <div className="bk-field f2">
                  <div className="ic">{speciesEmoji(null)}</div>
                  <div>
                    <div className="lab">Kin</div>
                    <div className="val">{found.kinNames.length > 0 ? found.kinNames.join(', ') : 'Not set'}</div>
                  </div>
                </div>
                <div className="bk-field f3">
                  <div className="ic">{'\u{1F469}'}</div>
                  <div>
                    <div className="lab">Auntie</div>
                    <div className="val">{found.auntieDisplayName ?? 'Not yet assigned'}</div>
                  </div>
                </div>
                <div className="bk-field f4">
                  <div className="ic">{'✅'}</div>
                  <div>
                    <div className="lab">Status</div>
                    <div className="val">{chip.label.charAt(0) + chip.label.slice(1).toLowerCase()}</div>
                  </div>
                </div>
              </div>
            </section>

            {found.notes && (
              <section className="glass card d3">
                <div className="sectlabel">Additional Information</div>
                <p className="info-line">{found.notes}</p>
              </section>
            )}

            <section className="glass card d4">
              <div className="sectlabel">Add a note</div>
              {canAct ? (
                <>
                  <h3 className="title">Leave a note for {auntieLabel}</h3>
                  <p className="sub" style={{ marginBottom: 14 }}>
                    Anything you want them to know before this visit.
                  </p>
                  <textarea
                    className={`note-ta${addNote.isError ? ' err' : ''}`}
                    placeholder="For example, a vet check this week, please keep an eye on their appetite."
                    value={noteBody}
                    onChange={(e) => {
                      setNoteBody(e.target.value);
                      setNoteSaved(false);
                    }}
                    disabled={addNote.isPending}
                  />
                  {addNote.isError && (
                    <div className="note-err">
                      {`⚠ ${addNote.error instanceof Error ? addNote.error.message : 'Could not save your note. Try again.'}`}
                    </div>
                  )}
                  <div className="note-foot">
                    <button
                      className="btn grad"
                      type="button"
                      onClick={submitNote}
                      disabled={addNote.isPending || noteBody.trim().length === 0}
                    >
                      {'\u{1F4DD}'} {addNote.isPending ? 'Saving…' : 'Save Note'}
                    </button>
                    {noteSaved && !addNote.isError ? (
                      <span className="note-ok">{'✓'} Note saved</span>
                    ) : (
                      <span className="sub" style={{ margin: 0 }}>
                        Saved notes go straight to {auntieLabel}.
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <p className="sub">This visit isn&rsquo;t linked to a booking yet, so notes aren&rsquo;t available here.</p>
              )}
            </section>
          </div>

          <div className="stack">
            <section className="glass card d2">
              <div className="sectlabel">When and where</div>
              <div className="visit v1" style={{ cursor: 'default' }}>
                <div className="cal">
                  <div className="m">{found.startTimeMs !== null ? calTile(found.startTimeMs).month : '—'}</div>
                  <div className="d">{found.startTimeMs !== null ? calTile(found.startTimeMs).day : '—'}</div>
                </div>
                <div className="info">
                  <b>{found.title ?? found.serviceType ?? 'Visit'}</b>
                  <small>{visitSubtitle(found.startTimeMs, found.auntieDisplayName)}</small>
                </div>
                <div className="pet">{speciesEmoji(null)}</div>
              </div>
            </section>

            <section className="glass card d3">
              <div className="sectlabel">Need a change</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <Link className="btn ghost block" to="/messages">
                  {'\u{1F4AC}'} Message {auntieLabel}
                </Link>

                {found.rescheduleRequestStatus === 'pending' ? (
                  <div className="cancel-pending" data-testid="reschedule-pending">
                    <span className="dot" />
                    New time requested{proposedLabel ? ` for ${proposedLabel}` : ''}. We&rsquo;ll confirm shortly.
                  </div>
                ) : (
                  <>
                    {found.rescheduleRequestStatus === 'accepted' && (
                      <div className="note" role="status" data-testid="reschedule-accepted">
                        <span className="dot" />
                        Your new time was accepted. This visit now shows the time you asked for.
                        {found.rescheduleResponseNote ? ` ${found.rescheduleResponseNote}` : ''}
                      </div>
                    )}
                    {found.rescheduleRequestStatus === 'declined' && (
                      <div className="note err" role="status" data-testid="reschedule-declined">
                        <span className="dot" />
                        {`Tribe Tails could not take ${proposedLabel || 'that time'}. ${found.rescheduleResponseNote ?? ''}`.trim()}
                      </div>
                    )}
                    {canRequestReschedule &&
                      (proposingReschedule ? (
                        <div className="cancel-confirm" data-testid="reschedule-form">
                          <p className="sub">
                            This proposes a new time to Tribe Tails. The visit stays where it is until they accept.
                          </p>
                          <label className="sub" htmlFor="new-visit-time" style={{ margin: 0 }}>
                            New date and time
                          </label>
                          <input
                            className="input"
                            id="new-visit-time"
                            type="datetime-local"
                            value={proposedAt}
                            onChange={(e) => setProposedAt(e.target.value)}
                            disabled={reschedule.isPending}
                          />
                          <textarea
                            className="note-ta"
                            placeholder="Why the change? (optional)"
                            value={rescheduleReason}
                            onChange={(e) => setRescheduleReason(e.target.value)}
                            disabled={reschedule.isPending}
                          />
                          {rescheduleProblem && <div className="note-err">{`\u26A0 ${rescheduleProblem}`}</div>}
                          <button
                            className="btn purple block"
                            type="button"
                            onClick={() => submitReschedule()}
                            disabled={reschedule.isPending || proposedAt.trim().length === 0}
                          >
                            {reschedule.isPending ? 'Sending…' : 'Send this time to Tribe Tails'}
                          </button>
                          <button
                            className="btn ghost block"
                            type="button"
                            onClick={() => setProposingReschedule(false)}
                            disabled={reschedule.isPending}
                          >
                            Never mind
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn ghost block"
                          type="button"
                          onClick={() => setProposingReschedule(true)}
                        >
                          {'\u{1F4C5}'} Reschedule visit
                        </button>
                      ))}
                  </>
                )}

                {found.cancelRequestStatus === 'pending' ? (
                  <div className="cancel-pending" data-testid="cancel-pending">
                    <span className="dot" />
                    Cancellation requested. Tribe Tails has it in their queue and will answer soon.
                  </div>
                ) : (
                  <>
                    {found.cancelRequestStatus === 'accepted' && (
                      <div className="note" role="status" data-testid="cancel-accepted">
                        <span className="dot" />
                        {`This visit is cancelled. ${found.cancelResponseNote ?? ''}`.trim()}
                      </div>
                    )}
                    {found.cancelRequestStatus === 'declined' && (
                      <div className="note err" role="status" data-testid="cancel-declined">
                        <span className="dot" />
                        {`Tribe Tails is keeping this visit on the books. ${found.cancelResponseNote ?? ''}`.trim()}
                      </div>
                    )}
                    {canRequestCancel ? (
                  confirmingCancel ? (
                    <div className="cancel-confirm">
                      <p className="sub">
                        This asks Tribe Tails to cancel the visit, it is not instant. It goes to their
                        requests queue and they will accept or decline it. Add a reason if you&rsquo;d like.
                      </p>
                      <textarea
                        className="note-ta"
                        placeholder="Optional reason"
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        disabled={cancelVisit.isPending}
                      />
                      {cancelVisit.isError && (
                        <div className="note-err">
                          {`⚠ ${cancelVisit.error instanceof Error ? cancelVisit.error.message : 'Could not send the request. Try again.'}`}
                        </div>
                      )}
                      <button
                        className="btn purple block"
                        type="button"
                        onClick={() => cancelVisit.mutate(cancelReason)}
                        disabled={cancelVisit.isPending}
                      >
                        {cancelVisit.isPending ? 'Sending…' : 'Yes, request cancellation'}
                      </button>
                      <button
                        className="btn ghost block"
                        type="button"
                        onClick={() => setConfirmingCancel(false)}
                        disabled={cancelVisit.isPending}
                      >
                        Never mind
                      </button>
                    </div>
                  ) : (
                      <button
                        className="btn ghost block"
                        type="button"
                        style={{ color: 'var(--coral)', borderColor: 'rgba(213,83,90,.3)' }}
                        onClick={() => setConfirmingCancel(true)}
                      >
                        {'✕'} {found.cancelRequestStatus === 'declined' ? 'Ask again' : 'Request cancellation'}
                      </button>
                    )
                  ) : null}
                  </>
                )}
              </div>
            </section>
          </div>
        </div>

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}
/**
 * Epoch millis from an `<input type="datetime-local">` value, or null when the
 * field is blank or unparseable.
 *
 * `new Date('2026-09-01T15:00')` is read as LOCAL time by every browser that
 * ships this input, which is what the household typed. Appending a Z, or
 * routing through Date.UTC, would silently move the proposal by the viewer's
 * offset.
 */
function parseLocalDateTime(value: string): number | null {
  if (!value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
