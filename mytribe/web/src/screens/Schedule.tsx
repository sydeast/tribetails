import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyBookings, getMyVisits } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { RouteMap } from '../components/RouteMap';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import { bookingChip, calTile, fullDateKick, isoTime, speciesEmoji, visitSubtitle, visitVariant } from '../lib/portalFormat';
import type { BookingDto, GetMyBookingsResult } from '../api/types';

type Tab = 'upcoming' | 'past';

function findBookingBySessionId(result: GetMyBookingsResult | undefined, sessionId: string): BookingDto | null {
  if (!result) return null;
  const all = [result.liveVisit, ...result.upcoming, ...result.recent].filter((b): b is BookingDto => b !== null);
  return all.find((b) => b.sessionId === sessionId) ?? null;
}

/**
 * Schedule, ported from ui-ideas/mytribe-schedule-2026-05-31.html.
 * Upcoming/Past is a client-side tab toggle over one getMyBookings call.
 * The live-visit gate uses getMyVisits's AuntieOS "ARRIVED" status (not
 * getMyBookings' active/enRoute) — mirrors ScheduleScreen.kt exactly, since
 * that's the signal that also unlocks the breadcrumbs live map. getMyVisits
 * is best-effort: a failure there only drops the live map + replay data,
 * it never blocks the upcoming/recent lists (which come from getMyBookings).
 */
export function Schedule() {
  const [tab, setTab] = useState<Tab>('upcoming');
  const [openReplayId, setOpenReplayId] = useState<string | null>(null);

  const kinfolkId = getActiveKinfolkId();
  const bookings = useQuery({ queryKey: ['myBookings', kinfolkId], queryFn: () => getMyBookings(kinfolkId) });
  const visits = useQuery({ queryKey: ['myVisits', kinfolkId], queryFn: () => getMyVisits(kinfolkId, 20), retry: false });

  const liveVisit = visits.data?.visits.find((v) => v.status.toLowerCase() === 'arrived') ?? null;
  const liveBooking = liveVisit ? findBookingBySessionId(bookings.data, liveVisit.id) : null;
  const breadcrumbs = useBreadcrumbs(liveVisit?.id ?? null);

  const { signOut, signingOut } = useSignOut();

  if (bookings.isError) {
    return (
      <LaunchError
        onRetry={() => void bookings.refetch()}
        retrying={bookings.isRefetching}
        onSignOut={signOut} signingOut={signingOut}
      />
    );
  }

  const upcoming = bookings.data?.upcoming ?? [];
  const past = bookings.data?.recent ?? [];
  const visitsBySession = new Map((visits.data?.visits ?? []).map((v) => [v.id, v]));

  return (
    <>
      <PortalNav active="schedule" />

      <div className="wrap">
        <header className="pagehead">
          <div className="htext">
            <div className="kick">{fullDateKick()}</div>
            <h1>
              Your <span>schedule</span>
            </h1>
          </div>
          <Link className="btn grad" to="/schedule/book" search={{ weekly: false }}>
            {'\u{1F4C5}'} Request a Booking
          </Link>
        </header>

        <div className="tabrow" role="tablist" aria-label="Schedule view">
          <button className={tab === 'upcoming' ? 'act' : ''} role="tab" aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
            Upcoming <span className="count">{upcoming.length}</span>
          </button>
          <button className={tab === 'past' ? 'act' : ''} role="tab" aria-selected={tab === 'past'} onClick={() => setTab('past')}>
            Past Visits <span className="count">{past.length}</span>
          </button>
        </div>

        {liveVisit && (
          <section className="live" aria-label="Visit in progress">
            <div className="lrow">
              <span className="pulse" />
              <span className="tag">VISIT IN PROGRESS</span>
            </div>
            <h2>
              {liveBooking?.auntieDisplayName ? `Auntie ${liveBooking.auntieDisplayName}` : 'Your Auntie'} is at your place
              {liveBooking?.kinNames.length ? ` with ${liveBooking.kinNames.join(', ')}` : ''}
            </h2>
            <p>
              {liveVisit.serviceType ?? liveBooking?.title ?? liveBooking?.serviceType ?? 'A visit'} in progress. You&rsquo;ll get a
              KinTale the moment {liveBooking?.auntieDisplayName ?? 'they'} wraps up.
            </p>
            {liveVisit.arrivedAtIso && <div className="laddr">{'\u{1F4CD}'} Arrived {isoTime(liveVisit.arrivedAtIso)}</div>}
            <div className="lwho">
              <div className="lav">{speciesEmoji(null)}</div>
              <div style={{ flex: '0 0 auto' }}>
                <b>{liveBooking?.kinNames[0] ?? 'Your kin'}</b>
                <small>{(liveVisit.serviceType ?? 'VISIT').toUpperCase()}</small>
              </div>
              <div className="track">
                <i />
              </div>
              <span className="statepill">
                <span className="pulse" />
                ARRIVED &middot; AT YOUR PLACE
              </span>
            </div>
            <div className="routemap-wrap">
              {breadcrumbs.length === 0 ? (
                <p className="sub" style={{ color: '#fff', opacity: 0.85 }}>
                  Waiting for the first GPS ping…
                </p>
              ) : (
                <RouteMap route={breadcrumbs} />
              )}
            </div>
          </section>
        )}

        <div className="cols">
          <div className="stack">
            {tab === 'upcoming' ? (
              <section className="glass card d1" aria-label="Upcoming bookings">
                <div className="sectlabel">Upcoming bookings</div>
                {bookings.isLoading ? (
                  <p className="sub">Loading your schedule…</p>
                ) : upcoming.length === 0 ? (
                  <div className="empty">
                    <div className="ring">{'\u{1F4C5}'}</div>
                    <b>No upcoming bookings</b>
                    <p>Nothing on the calendar yet. Request a booking and your Auntie will confirm a time.</p>
                  </div>
                ) : (
                  upcoming.map((b, i) => {
                    const tile = b.startTimeMs !== null ? calTile(b.startTimeMs) : { month: '—', day: '—' };
                    const chip = bookingChip(b.status);
                    return (
                      <div key={b.id}>
                        <div className={`visit ${visitVariant(i)}`}>
                          <div className="cal">
                            <div className="m">{tile.month}</div>
                            <div className="d">{tile.day}</div>
                          </div>
                          <div className="info">
                            <span className="svc">Service Type &middot; {b.serviceType ?? 'Visit'}</span>
                            <b>{b.title ?? b.serviceType ?? 'Visit'}</b>
                            <small>{visitSubtitle(b.startTimeMs, b.auntieDisplayName)}</small>
                          </div>
                          <div className="pet">{speciesEmoji(null)}</div>
                          <span className={`chip ${chip.tone}`}>{chip.label}</span>
                        </div>
                        {i < upcoming.length - 1 && <div className="rowdiv" />}
                      </div>
                    );
                  })
                )}
              </section>
            ) : (
              <section className="glass card d2" aria-label="Past visits">
                <div className="sectlabel">Past Visits</div>
                {bookings.isLoading ? (
                  <p className="sub">Loading your visit history…</p>
                ) : past.length === 0 ? (
                  <div className="empty">
                    <div className="ring">{'\u{1F4DD}'}</div>
                    <b>No past visits</b>
                    <p>Completed visits will live here, each with a Visit Replays photo and note from your Auntie.</p>
                  </div>
                ) : (
                  past.map((b, i) => {
                    const tile = b.startTimeMs !== null ? calTile(b.startTimeMs) : { month: '—', day: '—' };
                    const chip = bookingChip(b.status);
                    const visit = b.sessionId ? visitsBySession.get(b.sessionId) : undefined;
                    const route = visit?.gpsSummary?.route ?? [];
                    const isOpen = openReplayId === b.id;
                    return (
                      <div key={b.id}>
                        <div className={`visit ${visitVariant(i)}`}>
                          <div className="cal">
                            <div className="m">{tile.month}</div>
                            <div className="d">{tile.day}</div>
                          </div>
                          <div className="info">
                            <span className="svc">Service Type &middot; {b.serviceType ?? 'Visit'}</span>
                            <b>{b.title ?? b.serviceType ?? 'Visit'}</b>
                            <small>{visitSubtitle(b.startTimeMs, b.auntieDisplayName)}</small>
                          </div>
                          {route.length > 0 && (
                            <button
                              className={`replay ${isOpen ? 'open' : ''}`}
                              onClick={() => setOpenReplayId(isOpen ? null : b.id)}
                            >
                              <span className="dot" />
                              Visit Replays
                            </button>
                          )}
                          <span className={`chip ${chip.tone}`}>{chip.label}</span>
                        </div>
                        {isOpen && route.length > 0 && (
                          <div className="visit-replay-panel">
                            <RouteMap route={route} distanceMeters={visit?.gpsSummary?.distanceMeters} durationSeconds={visit?.gpsSummary?.durationSeconds} />
                          </div>
                        )}
                        {i < past.length - 1 && <div className="rowdiv" />}
                      </div>
                    );
                  })
                )}
              </section>
            )}
          </div>

          <div className="stack">
            <section className="glass card d3" aria-label="Schedule tips">
              <div className="sectlabel">
                Good to know <span className="sugtag">SUGGESTION</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <Link className="btn ghost block" to="/messages">
                  {'\u{1F4AC}'} Message your Auntie
                </Link>
                <Link className="btn ghost block" to="/schedule/book" search={{ weekly: true }}>
                  {'\u{1F504}'} Set up a recurring visit
                </Link>
              </div>
              <p className="sub" style={{ marginTop: 12 }}>
                Recurring visits are a non-contract add. Your Auntie confirms each week before it locks in.
              </p>
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
