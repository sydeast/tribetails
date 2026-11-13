import { useState } from 'react';
import { serviceEyebrowOf, serviceLabelOf, visitTitleOf } from '../lib/serviceLabel';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyVisits } from '../api/portal';
import { useMyBookings } from '../lib/useMyBookings';
import { PAST_VISITS_LIMIT, myVisitsKey } from '../lib/portalQueryKeys';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { useBreadcrumbs } from '../lib/breadcrumbs';
import { RouteMap } from '../components/RouteMap';
import { PortalNav } from '../components/PortalNav';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { LaunchError } from './LaunchError';
import { countLabel, countOfQuery, viewOfQuery } from '../lib/queryState';
import { auntieName, bookingChip, bookingSubtitle, fullDateKick, isoTime, liveVisitOf, pendingChangeLabel, speciesEmoji, visitStageOf, visitTile, visitVariant } from '../lib/portalFormat';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

type Tab = 'upcoming' | 'past';

/**
 * Schedule, ported from ui-ideas/mytribe-schedule-2026-05-31.html.
 * Upcoming/Past is a client-side tab toggle over one getMyBookings call.
 *
 * #1832: the live card is getMyBookings' `liveVisit`, the same visit Home's
 * card shows. It used to be found a second way, by looking for an ARRIVED row
 * in getMyVisits and then hunting for its booking, which is why the card had
 * no Kin to name, could not be opened, said nothing while the Auntie was on
 * the way, and was still up after she left. getMyVisits now only adds what the
 * booking does not carry: the arrival time, and the replay routes for Past
 * Visits. It is best-effort: a failure there drops those and nothing else.
 *
 * Every branch below goes through lib/queryState.ts rather than reading
 * `isLoading` and a list length. A signal drop with the tab open PAUSES these
 * queries, which leaves `isLoading` false, `isError` false and `data`
 * undefined, and this screen used to answer that with "No upcoming bookings.
 * Nothing on the calendar yet. Request a booking and your Auntie will confirm a
 * time." Households booked the same visit twice off that sentence.
 */
export function Schedule() {
  // #1304: the tab is in the URL (`?tab=past`), not in component state, so the
  // browser's back button from a visit returns to the tab it left. Switching
  // tabs REPLACES the entry rather than pushing one: back from a visit should
  // be one step, not a walk through every tab the household flicked between.
  const search = useSearch({ from: '/schedule' });
  const navigate = useNavigate();
  const tab: Tab = search.tab === 'past' ? 'past' : 'upcoming';
  const setTab = (next: Tab) =>
    void navigate({ to: '/schedule', search: next === 'past' ? { tab: 'past' } : {}, replace: true });
  const [openReplayId, setOpenReplayId] = useState<string | null>(null);

  const kinfolkId = getActiveKinfolkId();
  const bookings = useMyBookings(kinfolkId);
  const visits = useQuery({ queryKey: myVisitsKey(kinfolkId), queryFn: () => getMyVisits(kinfolkId, PAST_VISITS_LIMIT), retry: false });

  const live = liveVisitOf(bookings.data);
  // On the way has no map yet: the breadcrumbs are the visit's own walk, and
  // they start when the Auntie arrives.
  const arrived = live !== null && visitStageOf(live) === 'active';
  const { points: breadcrumbs, error: breadcrumbsError } = useBreadcrumbs(arrived ? (live.sessionId ?? null) : null);

  const { signOut, signingOut, error: signOutError } = useSignOut();

  if (bookings.isError) {
    return (
      <LaunchError
        onRetry={() => void bookings.refetch()}
        retrying={bookings.isRefetching}
        onSignOut={signOut} signingOut={signingOut}
        signOutError={signOutError}
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
  // The live card is fed by `bookings`, so its check is that query's wait.
  const liveCheckView = viewOfQuery(bookings);
  const visitsBySession = new Map((visits.data?.visits ?? []).map((v) => [v.id, v]));
  const liveSession = live?.sessionId ? visitsBySession.get(live.sessionId) : undefined;
  const liveAuntie = auntieName(live?.auntieDisplayName) ?? 'Your Auntie';
  const liveKin = live?.kinNames.length ? live.kinNames.join(', ') : null;
  const liveService = live ? (serviceLabelOf(live) ?? visitTitleOf(live)) : null;

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

        {/*
          slot that is always there. It used to be its own row above the lists:
          it showed on load, then vanished when the answer arrived and pulled
          everything up ~10px, so a tap aimed at a row landed on the gap. The
          slot keeps its height whether it is saying something or not, so the
          answer arriving moves nothing. (A live visit still adds its hero,
          which is content arriving, not a line leaving.)
          The hero used to appear out of nothing: no wait was read, so between
          mount and the answer landing there was no sign the screen was still
          deciding, and while paused there never would be one.
          A compact line rather than a second full panel, because the card
          below already carries the offline panel for the same outage.
        */}
        <div className="sched-tabbar">
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
          <div className="livecheck">
            {!live && liveCheckView.kind === 'offline' && <OfflineNotice compact what="whether a visit is under way" />}
            {!live && liveCheckView.kind === 'loading' && (
              <LoadingLine what="whether a visit is under way" retry={() => void bookings.refetch()}>
                Checking whether a visit is under way&hellip;
              </LoadingLine>
            )}
          </div>
        </div>
        {live && (
          <section
            className="live"
            aria-label={arrived ? 'Visit in progress' : 'Your Auntie is on the way'}
            data-testid="live-visit"
          >
            {/* #1832: the card opens the visit. The map below stays outside the
                link, so dragging it does not leave the page. */}
            <Link className="live-open" to="/schedule/$visitId" params={{ visitId: live.id }}>
              <div className="lrow">
                <span className="pulse" />
                <span className="tag">{arrived ? 'VISIT IN PROGRESS' : 'ON THE WAY'}</span>
              </div>
              <h2>
                {arrived
                  ? `${liveAuntie} is at your place${liveKin ? ` with ${liveKin}` : ''}`
                  : `${liveAuntie} is on the way${liveKin ? ` to ${liveKin}` : ''}`}
              </h2>
              <p>
                {arrived
                  ? `${liveService ?? 'A visit'} in progress. You’ll get a KinTale the moment ${live.auntieDisplayName ?? 'they'} wraps up.`
                  : `${liveService ?? 'Your visit'} starts when ${live.auntieDisplayName ?? 'your Auntie'} arrives.`}
              </p>
              {arrived && liveSession?.arrivedAtIso && (
                <div className="laddr">{'\u{1F4CD}'} Arrived {isoTime(liveSession.arrivedAtIso)}</div>
              )}
              <div className="lwho">
                <div className="lav">{speciesEmoji(null)}</div>
                <div style={{ flex: '0 0 auto' }}>
                  <b>{liveKin ?? 'Your kin'}</b>
                  <small>{(liveService ?? 'Visit').toUpperCase()}</small>
                </div>
                <div className="track">
                  <i />
                </div>
                <span className="statepill">
                  <span className="pulse" />
                  {arrived ? <>ARRIVED &middot; AT YOUR PLACE</> : 'ON THE WAY'}
                </span>
              </div>
            </Link>
            {arrived && (
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
            )}
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
                    const tile = visitTile(b);
                    const chip = bookingChip(visitStageOf(b));
                    return (
                      <div key={b.id}>
                        <Link className={`visit ${visitVariant(i)}`} to="/schedule/$visitId" params={{ visitId: b.id }}>
                          <div className="cal">
                            <div className="m">{tile.month}</div>
                            <div className="d">{tile.day}</div>
                          </div>
                          <div className="info">
                            {serviceEyebrowOf(b) && <span className="svc">{serviceEyebrowOf(b)}</span>}
                            <b>{visitTitleOf(b) ?? 'Visit'}</b>
                            <small>{bookingSubtitle(b)}</small>
                            {pendingChangeLabel(b) && (
                              <small className="pending-change" data-testid="pending-change">{pendingChangeLabel(b)}</small>
                            )}
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
                    const tile = visitTile(b);
                    const chip = bookingChip(visitStageOf(b));
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
                            {serviceEyebrowOf(b) && <span className="svc">{serviceEyebrowOf(b)}</span>}
                            <b>{visitTitleOf(b) ?? 'Visit'}</b>
                            <small>{bookingSubtitle(b)}</small>
                            {pendingChangeLabel(b) && (
                              <small className="pending-change" data-testid="pending-change">{pendingChangeLabel(b)}</small>
                            )}
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

        <SettingsBusinessFootnote />
      </div>
    </>
  );
}
