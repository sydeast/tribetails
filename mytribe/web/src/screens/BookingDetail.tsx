import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyBookings } from '../api/portal';
import { addBookingNote, getBookingNotes, requestBookingCancellation, requestBookingReschedule } from '../api/bookingApi';
import { ReschedulePicker } from '../components/ReschedulePicker';
import type { RescheduleProposal } from '../lib/rescheduleTime';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { isOfflineError, usePortalMutation } from '../lib/mutationState';
import { applyBookingWrite } from '../lib/bookingsCache';
import { viewOfQuery } from '../lib/queryState';
import {
  auntieName,
  BOOKING_TIMELINE_STEPS,
  bookingStatusChip,
  bookingStatusIcon,
  bookingTimelineIndex,
  bookingSubtitle,
  findBookingById,
  isStartTimePending,
  speciesEmoji,
  visitTile,
  visitWhenLine,
  noteWrittenAt,
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
  const [proposal, setProposal] = useState<RescheduleProposal | null>(null);
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [rescheduleProblem, setRescheduleProblem] = useState<string | null>(null);

  const found = findBookingById(bookings.data, visitId);
  // #1283: what this household already told its Auntie about the visit. The
  // server returns the household's own notes only.
  const notesQueryKey = ['bookingNotes', kinfolkId, found?.batchId ?? null, found?.id ?? null] as const;
  const savedNotes = useQuery({
    queryKey: notesQueryKey,
    queryFn: () => getBookingNotes(found!.kinfolkId, found!.batchId!, found!.id),
    enabled: !!found?.batchId,
  });

  // ABANDON. `addBookingNote` is a bare `.add()` on the visit's notes
  // subcollection with no dedupe key, and its only precondition (a 3-hour
  // window) passes again on a replay, so a second attempt is a second note.
  const addNote = usePortalMutation({
    mutationFn: (body: string) => {
      if (!found?.batchId) throw new Error('This visit is not linked to a booking yet, so notes are not available.');
      return addBookingNote(found.kinfolkId, found.batchId, found.id, body);
    },
    onSuccess: async () => {
      setNoteSaved(true);
      setNoteBody('');
      // The saved note joins the list the household reads above the box.
      await queryClient.invalidateQueries({ queryKey: ['bookingNotes', kinfolkId] });
    },
  }, { policy: 'abandon', what: 'your note' });

  // HOLD. `requestBookingCancellation` returns `alreadyPending: true` without
  // writing when a request is already open on the visit, and the write itself
  // is a set/merge of fixed fields, so a replay cannot stack requests.
  const cancelVisit = usePortalMutation({
    mutationFn: (reason: string) => {
      if (!found?.batchId) throw new Error('This visit is not linked to a booking yet, so it cannot be cancelled here.');
      return requestBookingCancellation(found.kinfolkId, found.batchId, found.id, reason);
    },
    // #1281: the panel used to close here while the visit underneath still
    // showed its pre-ask state for 10s+. The server's copy of the visit goes
    // into the cache first (or, without one, a fresh list is awaited), so
    // "Cancellation requested" is on screen when the panel closes and the
    // button stays on its busy label until then.
    onSuccess: async (res) => {
      await applyBookingWrite(queryClient, kinfolkId, { visit: res.visit ?? null });
      setConfirmingCancel(false);
      setCancelReason('');
    },
  }, { policy: 'hold', what: 'your cancellation request' });

  // HOLD. `requestBookingReschedule` refuses a second pending request with
  // `already-exists` rather than overwriting the first, so the worst a replay
  // can do is surface that refusal — which is the right answer, and is already
  // the sentence `onError` shows. It cannot stack two proposed times.
  const reschedule = usePortalMutation({
    mutationFn: (p: RescheduleProposal) => {
      if (!found?.batchId) throw new Error('This visit is not linked to a booking yet, so it cannot be moved here.');
      return requestBookingReschedule(found.kinfolkId, found.batchId, found.id, p.startMs, rescheduleReason, p.timeBlockId);
    },
    // #1281: same as the cancellation ask above. "New time requested for …"
    // is drawn from the cached visit, so it shows the moment the panel closes.
    onSuccess: async (res) => {
      await applyBookingWrite(queryClient, kinfolkId, { visit: res.visit ?? null });
      setProposingReschedule(false);
      setProposal(null);
      setRescheduleReason('');
      setRescheduleProblem(null);
    },
    onError: (err: unknown) => {
      // The server writes these messages for a household to read
      // (invalid-argument on a past time, already-exists on a second ask), so
      // they are shown as they arrive rather than flattened to "try again".
      // #807: not for an offline failure. The request never reached a server
      // that could have an opinion, and `OfflineMutationNotice` says what did
      // happen. Overwriting that with a server sentence nobody wrote is the
      // same lie in a different place.
      if (isOfflineError(err)) return;
      setRescheduleProblem(err instanceof Error ? err.message : 'Could not send the request. Try again.');
    },
  }, { policy: 'hold', what: 'your new time' });
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
          <LoadingLine variant="block" what="this booking" retry={() => void bookings.refetch()}>
          Loading this booking…
        </LoadingLine>
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
  const canRequestCancel =
    canAct &&
    !found.cancelRequested &&
    // #1299: the server refuses a cancellation while a new time is waiting
    // (and the reverse), so the control is not offered to fail.
    found.rescheduleRequestStatus !== 'pending' &&
    (found.status === 'requested' || found.status === 'confirmed');
  // Same window as a cancellation ask, and for the same reason: a visit that is
  // under way or finished is not moved by asking. A pending ask is handled
  // above this flag, by the branch that renders the waiting state instead.
  //
  // #1098: a night still waiting for its start time cannot be moved yet: the
  // Auntie sets that time, and `requestBookingReschedule` refuses until she
  // has. The control is held back with the reason rather than offered to fail.
  const awaitingStartTime = isStartTimePending(found) && (found.status === 'requested' || found.status === 'confirmed');
  const canRequestReschedule =
    canAct &&
    !awaitingStartTime &&
    found.rescheduleRequestStatus !== 'pending' &&
    found.cancelRequestStatus !== 'pending' &&
    (found.status === 'requested' || found.status === 'confirmed');
  const proposedLabel =
    found.rescheduleRequestedStartTimeMs !== null
      ? weekdayTime(found.rescheduleRequestedStartTimeMs)
      : '';
  const auntieLabel = auntieName(found.auntieDisplayName) ?? 'your Auntie';
  const submitReschedule = () => {
    if (proposal === null) {
      setRescheduleProblem('Pick a day and a time first.');
      return;
    }
    if (proposal.startMs <= Date.now()) {
      setRescheduleProblem('Pick a time in the future.');
      return;
    }
    setRescheduleProblem(null);
    reschedule.mutate(proposal);
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
          {/* #1304: back lands on the tab this visit lives in, so a past visit
              returns to Past Visits and not to the default tab. */}
          <Link className="backlink" to="/schedule" search={found.status === 'completed' || found.status === 'cancelled' ? { tab: 'past' } : {}}>
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
                      <small>{visitWhenLine(found)}</small>
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
                  <div className="ic">{bookingStatusIcon(found.status)}</div>
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

            {canAct && (
              <section className="glass card d3" data-testid="saved-notes">
                <div className="sectlabel">Your notes to {auntieLabel}</div>
                {savedNotes.isPending && savedNotes.fetchStatus === 'fetching' ? (
                  <LoadingLine what="your notes" retry={() => void savedNotes.refetch()}>
                    Loading your notes…
                  </LoadingLine>
                ) : savedNotes.isError ? (
                  <p className="sub">
                    We couldn&rsquo;t load your notes.{' '}
                    <button type="button" className="btn ghost" onClick={() => void savedNotes.refetch()}>
                      Try again
                    </button>
                  </p>
                ) : savedNotes.data && (savedNotes.data.bookingNote || savedNotes.data.notes.length > 0) ? (
                  <>
                    {savedNotes.data.bookingNote && (
                      <p className="info-line" style={{ whiteSpace: 'pre-wrap' }} data-testid="booking-note">
                        <b>When you booked</b>
                        <br />
                        {savedNotes.data.bookingNote}
                      </p>
                    )}
                    {savedNotes.data.notes.map((n) => (
                      <p className="info-line" style={{ whiteSpace: 'pre-wrap' }} key={n.id} data-testid="saved-note">
                        {n.createdAtMs !== null && (
                          <>
                            <b>{noteWrittenAt(n.createdAtMs)}</b>
                            <br />
                          </>
                        )}
                        {n.body}
                      </p>
                    ))}
                  </>
                ) : (
                  <p className="sub">Nothing yet.</p>
                )}
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
                  <OfflineMutationNotice phase={addNote.phase} what="your note" check="the notes above" />
                  {addNote.phase === 'failed' && (
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
                      {'\u{1F4DD}'}{' '}
                      <MutationLabel mutation={addNote} busy="Saving…">
                        Save Note
                      </MutationLabel>
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
                  <div className="m">{visitTile(found).month}</div>
                  <div className="d">{visitTile(found).day}</div>
                </div>
                <div className="info">
                  <b>{found.title ?? found.serviceType ?? 'Visit'}</b>
                  <small>{bookingSubtitle(found)}</small>
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
                    {awaitingStartTime && (
                      <p className="sub" style={{ margin: 0 }} data-testid="reschedule-awaiting-start">
                        Your Auntie has not set the start time yet.
                      </p>
                    )}
                    {canRequestReschedule &&
                      (proposingReschedule ? (
                        <div className="cancel-confirm" data-testid="reschedule-form">
                          <p className="sub">
                            This proposes a new time to Tribe Tails. The visit stays where it is until they accept.
                          </p>
                          <ReschedulePicker
                            serviceId={found.serviceId}
                            disabled={reschedule.isPending}
                            onChange={(p) => {
                              setProposal(p);
                              setRescheduleProblem(null);
                            }}
                          />
                          <textarea
                            className="note-ta"
                            placeholder="Why the change? (optional)"
                            value={rescheduleReason}
                            onChange={(e) => setRescheduleReason(e.target.value)}
                            disabled={reschedule.isPending}
                          />
                          <OfflineMutationNotice phase={reschedule.phase} what="your new time" check="this visit" />
                          {rescheduleProblem && <div className="note-err">{`\u26A0 ${rescheduleProblem}`}</div>}
                          <button
                            className="btn purple block"
                            type="button"
                            onClick={() => submitReschedule()}
                            disabled={reschedule.isPending || proposal === null}
                          >
                            <MutationLabel mutation={reschedule} busy="Sending…">
                              Send this time to Tribe Tails
                            </MutationLabel>
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
                      <OfflineMutationNotice
                        phase={cancelVisit.phase}
                        what="your cancellation request"
                        check="this visit"
                      />
                      {cancelVisit.phase === 'failed' && (
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
                        <MutationLabel mutation={cancelVisit} busy="Sending…">
                          Yes, request cancellation
                        </MutationLabel>
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
                  ) : found.rescheduleRequestStatus === 'pending' && canAct ? (
                    <p className="sub" style={{ margin: 0 }} data-testid="cancel-held">
                      You can ask to cancel once Tribe Tails answers your new time.
                    </p>
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
