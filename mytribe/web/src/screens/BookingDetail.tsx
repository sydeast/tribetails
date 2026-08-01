import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyBookings } from '../api/portal';
import { addBookingNote, requestBookingCancellation } from '../api/bookingApi';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
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

  if (bookings.isLoading) {
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
  const canRequestCancel = canAct && !found.cancelRequested && (found.status === 'requested' || found.status === 'confirmed');
  const auntieLabel = found.auntieDisplayName ? `Auntie ${found.auntieDisplayName}` : 'your Auntie';

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
                    <div className="lab">Service</div>
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

                <span className="btn ghost block navlink-inert" title="Coming soon">
                  {'\u{1F4C5}'} Reschedule visit
                </span>

                {found.cancelRequested ? (
                  <div className="cancel-pending">
                    <span className="dot" />
                    Cancellation already requested. We&rsquo;ll confirm shortly.
                  </div>
                ) : canRequestCancel ? (
                  confirmingCancel ? (
                    <div className="cancel-confirm">
                      <p className="sub">
                        This asks Tribe Tails to cancel the visit, it is not instant. Add a reason if you&rsquo;d like.
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
                      {'✕'} Request cancellation
                    </button>
                  )
                ) : null}
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
