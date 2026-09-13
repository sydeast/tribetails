import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyBookings, getMyVisits } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { RouteMap } from '../components/RouteMap';
import { PortalNav } from '../components/PortalNav';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { LaunchError } from './LaunchError';
import { countLabel, countOfQuery, viewOfQuery } from '../lib/queryState';
import { bookingChip, calTile, fullDateKick, isoTime, speciesEmoji, visitSubtitle, visitVariant } from '../lib/portalFormat';
import type { GetMyBookingsResult, GetMyBookingsResultLiveVisit } from '../contracts/bookingContracts.generated';

type Tab = 'upcoming' | 'past';

function findBookingBySessionId(
  result: GetMyBookingsResult | undefined,
  sessionId: string,
): GetMyBookingsResultLiveVisit | null {
  if (!result) return null;
  const all = [result.liveVisit, ...result.upcoming, ...result.recent].filter(
    (b): b is GetMyBookingsResultLiveVisit => b !== null,
  );
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
 *
 * Every branch below goes through lib/queryState.ts rather than reading
 * `isLoading` and a list length. A signal drop with the tab open PAUSES these
 * queries, which leaves `isLoading` false, `isError` false and `data`
 * undefined, and this screen used to answer that with "No upcoming bookings.
 * Nothing on the calendar yet. Request a booking and your Auntie will confirm a
 * time." Households booked the same visit twice off that sentence.
 */
export function Schedule() {
  const [tab, setTab] = useState<Tab>('upcoming');
  const [openReplayId, setOpenReplayId] = useState<string | null>(null);

  const kinfolkId = getActiveKinfolkId();
  const bookings = useQuery({ queryKey: ['myBookings', kinfolkId], queryFn: () => getMyBookings(kinfolkId) });
  const visits = useQuery({ queryKey: ['myVisits', kinfolkId], queryFn: () => getMyVisits(kinfolkId, 20), retry: false });

  const liveVisit = visits.data?.visits.find((v) => v.status.toLowerCase() === 'arrived') ?? null;
  const liveBooking = liveVisit ? findBookingBySessionId(bookings.data, liveVisit.id) : null;
  const { points: breadcrumbs, error: breadcrumbsError } = useBreadcrumbs(liveVisit?.id ?? null);

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

  // `bookings.isError` is answered by the early return above and these queries
  // are not gated, so 'error' and 'idle' are unreachable in the branches below;
  // they fall in with loading rather than being given copy that cannot show.
  const upcomingView = viewOfQuery(bookings, { isEmpty: (d) => d.upcoming.length === 0 });
  const pastView = viewOfQuery(bookings, { isEmpty: (d) => d.recent.length === 0 });
  const upcomingCount = countLabel(countOfQuery(bookings, (d) => d.upcoming.length));
  const pastCount = countLabel(countOfQuery(bookings, (d) => d.recent.length));
  const visitsView = viewOfQuery(visits);
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
            Upcoming{' '}
            <span className="count" title={upcomingCount.hint ?? undefined} aria-label={upcomingCount.hint ?? undefined}>
              {upcomingCount.text}
            </span>
          </button>
          <button className={tab === 'past' ? 'act' : ''} role="tab" aria-selected={tab === 'past'} onClick={() => setTab('past')}>
            Past Visits{' '}
            <span className="count" title={pastCount.hint ?? undefined} aria-label={pastCount.hint ?? undefined}>
              {pastCount.text}
            </span>
          </button>
        </div>

        {/*
          The hero used to appear out of nothing: `visits.isLoading` was never
          read, so between mount and the answer landing there was no sign the
          screen was still deciding, and while paused there never would be one.
          A compact line rather than a second full panel, because the card below
          already carries the offline panel for the same outage.
        */}
        {!liveVisit && visitsView.kind === 'offline' && <OfflineNotice compact what="whether a visit is under way" />}
        {!liveVisit && visitsView.kind === 'loading' && (
          <LoadingLine what="whether a visit is under way" retry={() => void visits.refetch()}>
            Checking whether a visit is under way&hellip;
          </LoadingLine>
        )}
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
              {breadcrumbsError !== null ? (
                // A dead subscription must not read as a visit that has not
                // started moving. This branch used to be unreachable: the hook
                // returned only an array, so a permission-denied showed the
                // "waiting" copy below forever.
                <p className="sub" style={{ color: '#fff', opacity: 0.95 }}>
                  Live tracking is unavailable right now. Your Auntie is still on the visit.
                </p>
              ) : breadcrumbs.length === 0 ? (
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
                {upcomingView.kind === 'offline' ? (
                  <OfflineNotice what="your schedule" />
                ) : upcomingView.kind === 'empty' ? (
                  <div className="empty">
                    <div className="ring">{'\u{1F4C5}'}</div>
                    <b>No upcoming bookings</b>
                    <p>Nothing on the calendar yet. Request a booking and your Auntie will confirm a time.</p>
                  </div>
                ) : upcomingView.kind !== 'data' ? (
                  <LoadingLine what="your schedule" retry={() => void bookings.refetch()}>
                    Loading your schedule…
                  </LoadingLine>
                ) : (
                  upcomingView.data.upcoming.map((b, i) => {
                    const tile = b.startTimeMs !== null ? calTile(b.startTimeMs) : { month: '—', day: '—' };
                    const chip = bookingChip(b.status);
                    return (
                      <div key={b.id}>
                        <Link className={`visit ${visitVariant(i)}`} to="/schedule/$visitId" params={{ visitId: b.id }}>
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
                        </Link>
                        {i < upcomingView.data.upcoming.length - 1 && <div className="rowdiv" />}
                      </div>
                    );
                  })
                )}
              </section>
            ) : (
              <section className="glass card d2" aria-label="Past visits">
                <div className="sectlabel">Past Visits</div>
                {pastView.kind === 'offline' ? (
                  <OfflineNotice what="your visit history" />
                ) : pastView.kind === 'empty' ? (
                  <div className="empty">
                    <div className="ring">{'\u{1F4DD}'}</div>
                    <b>No past visits</b>
                    <p>Completed visits will live here, each with a Visit Replays photo and note from your Auntie.</p>
                  </div>
                ) : pastView.kind !== 'data' ? (
                  <LoadingLine what="your visit history" retry={() => void bookings.refetch()}>
                    Loading your visit history…
                  </LoadingLine>
                ) : (
                  pastView.data.recent.map((b, i) => {
                    const tile = b.startTimeMs !== null ? calTile(b.startTimeMs) : { month: '—', day: '—' };
                    const chip = bookingChip(b.status);
                    const visit = b.sessionId ? visitsBySession.get(b.sessionId) : undefined;
                    const route = visit?.gpsSummary?.route ?? [];
                    const isOpen = openReplayId === b.id;
                    return (
                      <div key={b.id}>
                        <Link className={`visit ${visitVariant(i)}`} to="/schedule/$visitId" params={{ visitId: b.id }}>
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
                              onClick={(e) => {
                                // The replay toggle lives inside the now-clickable
                                // `.visit` row (it navigates to the drill-in
                                // route); stop the click there so opening the
                                // replay panel doesn't also navigate away.
                                e.preventDefault();
                                e.stopPropagation();
                                setOpenReplayId(isOpen ? null : b.id);
                              }}
                            >
                              <span className="dot" />
                              Visit Replays
                            </button>
                          )}
                          <span className={`chip ${chip.tone}`}>{chip.label}</span>
                        </Link>
                        {isOpen && route.length > 0 && (
                          <div className="visit-replay-panel">
                            <RouteMap route={route} distanceMeters={visit?.gpsSummary?.distanceMeters} durationSeconds={visit?.gpsSummary?.durationSeconds} />
                          </div>
                        )}
                        {i < pastView.data.recent.length - 1 && <div className="rowdiv" />}
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
