import { Fragment, type ReactNode } from 'react';
import { serviceLabelOf, visitTitleOf } from '../lib/serviceLabel';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyBookings, getMyHome, getMyKinTales } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { LaunchError } from './LaunchError';
import { InstallAndAlerts } from '../components/InstallAndAlerts';
import { PortalNav } from '../components/PortalNav';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { viewOfQuery } from '../lib/queryState';
import { billingAccessOf } from '../lib/billingAccess';
import { usePortalIdentity } from '../lib/identity';
import {
  auntieName,
  bookingChip,
  bookingSubtitle,
  elapsedMinutes,
  greetingKick,
  pendingChangeLabel,
  relativeDay,
  resolveHomeLayout,
  speciesEmoji,
  visitTile,
  visitVariant,
} from '../lib/portalFormat';
import { BusinessFootnote } from '../components/BusinessFootnote';

/**
 * Home, ported from ui-ideas/mytribe-home-2026-05-31.html. `getMyHome` only
 * carries identity/config. The live sections come from two independent,
 * best-effort calls: getMyBookings, getMyKinTales. A failure in either
 * degrades that section only; only a failed getMyHome (identity) blocks the
 * whole screen.
 *
 * #1412 (operator ruling on #1295): Home is the dashboard. Quick Start sits at
 * the top, above the fold on a phone, and the kin roster lives on Tribe only
 * (TribeHub.tsx renders it), so `getMyKin` is no longer read here. The live
 * hero's kin names come from the booking itself (`liveVisit.kinNames`). An
 * operator `portal.home` config that still names `roster` is tolerated and
 * skipped: `sectionById` has no renderer for it.
 *
 * O-14 parity fix: the operator-configurable section layout
 * (`portal.home`, resolved via resolveHomeLayout — a direct port of
 * HomeScreen.kt's resolveHomeLayout) was previously ignored entirely on
 * web while Android already respected it. Empty config -> the same fixed
 * two-column layout as before (unchanged for every kinfolk until an
 * operator actually configures something); a non-empty config renders the
 * configured order/limits in a single column, exactly like the Kotlin
 * `custom` branch.
 *
 * Every branch reads lib/queryState.ts rather than `isLoading` plus a length.
 * A signal drop with the tab open pauses these queries: `isLoading` goes false
 * without `isError` going true, so this screen used to greet the household
 * "Hi , your tribe is in good hands." over sections claiming there was
 * nothing on the calendar and no KinTales. The gated queries make it worse
 * than most screens: while `home` is paused they are `enabled: false`, so they
 * never even reach 'paused' and sit at pending/idle. `gate: home` is what
 * makes them answer with home's reason instead of with silence.
 *
 * #1282: the section queries no longer WAIT for `home` (they used to be
 * `enabled: home.isSuccess`). That gate made the first paint two round trips
 * deep for no reason the data needed: neither reads anything out of `home`.
 * They now start alongside it, and `gate: home` still makes a failed or paused
 * `home` the reason every section reports.
 */
export function Home() {
  const kinfolkId = getActiveKinfolkId();
  const home = useQuery({ queryKey: ['myHome', kinfolkId], queryFn: () => getMyHome(kinfolkId) });
  const bookings = useQuery({ queryKey: ['myBookings', kinfolkId], queryFn: () => getMyBookings(kinfolkId) });
  const kinTales = useQuery({
    queryKey: ['myKinTales', 'home-preview', kinfolkId],
    queryFn: () => getMyKinTales(kinfolkId, { limit: 3 }),
  });

  // #1290: a first-name greeting off the signed-in person, not the household's
  // (often upper-case) name. Until the account answers, the heading keeps the
  // loading cue rather than greeting a name that is about to change.
  const identity = usePortalIdentity();

  const { signOut, signingOut } = useSignOut();

  if (home.isError) {
    return (
      <LaunchError
        onRetry={() => void home.refetch()}
        retrying={home.isRefetching}
        onSignOut={signOut} signingOut={signingOut}
      />
    );
  }

  const liveVisit = bookings.data?.liveVisit ?? null;
  // `home.isError` is answered by the early return above, and `home` is not
  // gated, so homeView is only ever data / offline / loading. The other two
  // are best-effort (see the header): each can fail on its own while the rest of
  // the screen is fine, so each gets its own error arm below. Folding an error
  // into the loading arm would swap the old false-empty for a false spinner
  // that never ends, which is the same lie wearing a different hat.
  const homeView = viewOfQuery(home);
  const bookingsView = viewOfQuery(bookings, { isEmpty: (d) => d.upcoming.length === 0, gate: home });
  const talesView = viewOfQuery(kinTales, { isEmpty: (d) => d.tales.length === 0, gate: home });

  const sections = home.data?.portal.home ?? [];
  const layout = resolveHomeLayout(sections);
  const custom = sections.length > 0;
  function sectionLimit(id: string, fallback: number): number {
    const configured = layout.find((s) => s.id === id)?.limit ?? 0;
    return configured > 0 ? configured : fallback;
  }

  // Fallbacks match HomeScreen.kt's resolveHomeLayout defaults exactly
  // (upNext 5, tales 3) — parity, not arbitrary web-specific values.
  const upcoming = (bookings.data?.upcoming ?? []).slice(0, sectionLimit('upNext', 5));
  const tales = (kinTales.data?.tales ?? []).slice(0, sectionLimit('tales', 3));

  return (
    <>
      <PortalNav active="home" />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">{greetingKick()}</div>
          <h1>
            {homeView.kind === 'offline' ? (
              // Not "Hi , your tribe is in good hands." We do not know whose
              // tribe this is right now, so we do not claim to.
              <>We can&rsquo;t reach your tribe right now.</>
            ) : homeView.kind !== 'data' || !identity.settled ? (
              // The bare ring rather than a LoadingLine: this wait lives inside
              // an <h1>, where a <div role="status"> is not allowed, and the
              // heading text is already the sentence. The escalation for the
              // same outage is carried by the sections below, which have room
              // for it -- the hero would be offering a second Sync button for
              // a read three other regions are also waiting on.
              <>
                <span className="loading-spinner loading-spinner--inline" aria-hidden="true" />
                Fetching your tribe…
              </>
            ) : (
              <>
                Hi {identity.firstName || 'there'}, your <span>tribe</span> is in good hands.
              </>
            )}
          </h1>
        </header>

        {(() => {
          // No loading cue in this slot, unlike Schedule's. There the hero comes
          // from `getMyVisits` while the lists come from `getMyBookings`, so it
          // needs to speak for itself; here the Up next card below is fed by
          // this same query and already says what is happening.
          const liveVisitSection = !liveVisit ? (
            bookingsView.kind === 'offline' ? <OfflineNotice compact what="whether a visit is under way" /> : null
          ) : (
            <section className="live">
              <div className="lrow">
                <span className="pulse" />
                <span className="tag">LIVE NOW</span>
              </div>
              <h2>
                {auntieName(liveVisit.auntieDisplayName) ?? 'Your Auntie'} is with{' '}
                {liveVisit.kinNames.join(', ') || 'your kin'}
              </h2>
              <p>
                {liveVisit.startTimeMs !== null ? `Checked in ${elapsedMinutes(liveVisit.startTimeMs)} minutes ago` : 'Checked in'} for{' '}
                {visitTitleOf(liveVisit) ?? 'a visit'}. You&rsquo;ll get a KinTale the moment they wrap up.
              </p>
              <div className="lwho">
                <div className="lav">{speciesEmoji(null)}</div>
                <div style={{ flex: '0 0 auto' }}>
                  <b>{liveVisit.kinNames[0] ?? 'Your kin'}</b>
                  <small>{(serviceLabelOf(liveVisit) ?? visitTitleOf(liveVisit) ?? 'Visit').toUpperCase()}</small>
                </div>
                <div className="track">
                  <i />
                </div>
                {liveVisit.startTimeMs !== null && (
                  <span className="chip" style={{ background: 'rgba(255,255,255,.22)', color: '#fff', flex: '0 0 auto' }}>
                    {elapsedMinutes(liveVisit.startTimeMs)} MIN IN
                  </span>
                )}
              </div>
            </section>
          );

          const upNextSection = (
            <section className="glass card d2">
              <div className="sectlabel">
                Up next <Link to="/schedule">Full schedule</Link>
              </div>
              {bookingsView.kind === 'offline' ? (
                <OfflineNotice what="your schedule" />
              ) : bookingsView.kind === 'empty' ? (
                <p className="sub">Nothing on the calendar yet.</p>
              ) : bookingsView.kind === 'error' ? (
                <p className="sub">Your schedule is unavailable right now.</p>
              ) : bookingsView.kind !== 'data' ? (
                <LoadingLine what="your schedule" retry={() => void bookings.refetch()}>
                  Loading your schedule…
                </LoadingLine>
              ) : (
                upcoming.map((b, i) => {
                  const tile = visitTile(b);
                  const chip = bookingChip(b.status);
                  const change = pendingChangeLabel(b);
                  return (
                    <div className={`visit ${visitVariant(i)}`} key={b.id}>
                      <div className="cal">
                        <div className="m">{tile.month}</div>
                        <div className="d">{tile.day}</div>
                      </div>
                      <div className="info">
                        <b>{visitTitleOf(b) ?? 'Visit'}</b>
                        <small>{bookingSubtitle(b)}</small>
                        {change && <small className="pending-change" data-testid="pending-change">{change}</small>}
                      </div>
                      <div className="pet">{speciesEmoji(null)}</div>
                      <span className={`chip ${chip.tone}`}>{chip.label}</span>
                    </div>
                  );
                })
              )}
            </section>
          );

          const talesSection = (
            <section className="glass card d3">
              <div className="sectlabel">Recent KinTales</div>
              {talesView.kind === 'offline' ? (
                <OfflineNotice what="your KinTales" />
              ) : talesView.kind === 'empty' ? (
                <p className="sub">Your first KinTale will show up here after a visit.</p>
              ) : talesView.kind === 'error' ? (
                <p className="sub">KinTales unavailable right now.</p>
              ) : talesView.kind !== 'data' ? (
                <LoadingLine what="your KinTales" retry={() => void kinTales.refetch()}>
                  Loading recent KinTales…
                </LoadingLine>
              ) : (
                tales.map((t, i) => (
                  <Link className={`tale a${(i % 3) + 1}`} to="/kintales" search={{ tale: t.id }} key={t.id}>
                    <div className="photo">{'\u{1F43E}'}</div>
                    <div className="tb">
                      <b>{t.title || t.body.slice(0, 60)}</b>
                      <p>{t.body}</p>
                      <div className="meta">
                        {`FROM ${(auntieName(t.authorDisplayName) ?? 'Your Auntie').toUpperCase()}${t.sentAtMs !== null ? ` · ${relativeDay(t.sentAtMs).toUpperCase()}` : ''}`}
                      </div>
                    </div>
                  </Link>
                ))
              )}
            </section>
          );

          // #1412: first card on the page, so it carries the first stagger step.
          const quickStartSection = (
            <section className="glass card d1">
              <div className="sectlabel">Quick start</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <Link className="btn grad block" to="/schedule/book" search={{ weekly: false }}>
                  {'\u{1F4C5}'} Book a visit
                </Link>
                <Link className="btn ghost block" to="/messages">
                  {'\u{1F4AC}'} Message your Auntie
                </Link>
                {billingAccessOf(home.data) && (
                  <Link className="btn ghost block" to="/invoices">
                    {'\u{1F4B0}'} View invoices
                  </Link>
                )}
              </div>
            </section>
          );

          const sectionById: Record<string, ReactNode> = {
            liveVisit: liveVisitSection,
            upNext: upNextSection,
            tales: talesSection,
            // No `roster`: the kin list is Tribe's (#1412). A config row that
            // still names it falls through `if (!el)` below and is skipped.
            quickStart: quickStartSection,
          };

          // Empty operator config -> the fixed two-column layout. A configured
          // layout -> the configured order/limits in a single column (a custom
          // order can't be meaningfully forced into two fixed columns) —
          // matches HomeScreen.kt's `custom` branch.
          if (custom) {
            return (
              <>
                {layout.map((sec) => {
                  const el = sectionById[sec.id];
                  if (!el) return null;
                  return sec.id === 'liveVisit' ? (
                    <Fragment key={sec.id}>{el}</Fragment>
                  ) : (
                    <div className="stack" key={sec.id}>
                      {el}
                    </div>
                  );
                })}
              </>
            );
          }

          // Quick Start comes FIRST in the DOM so the phone's single column
          // (where `.cols` collapses in DOM order) puts it above Up next, above
          // the fold at 390px. On a wide screen `.cols > .aside { order: 2 }`
          // (base.css) moves it back to the right-hand column, so main stays
          // left at 1.6fr and the aside right at 1fr, the same split as
          // HomeScreen.kt's Row.
          return (
            <>
              {liveVisitSection}
              <div className="cols">
                <div className="stack aside">
                  {quickStartSection}
                </div>
                <div className="stack">
                  {upNextSection}
                  {talesSection}
                </div>
              </div>
            </>
          );
        })()}

        {/* Which of the two banners shows, and in what order, is a decision
            of its own on iOS. See components/InstallAndAlerts.tsx. */}
        <InstallAndAlerts />

        <BusinessFootnote name={home.data?.businessName} />
      </div>
    </>
  );
}
