import { Fragment, type ReactNode } from 'react';
import { serviceLabelOf, visitTitleOf } from '../lib/serviceLabel';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyHome, getMyKinTales } from '../api/portal';
import { useMyBookings } from '../lib/useMyBookings';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { LaunchError } from './LaunchError';
import { InstallAndAlerts } from '../components/InstallAndAlerts';
import { PortalNav } from '../components/PortalNav';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { viewOfQuery } from '../lib/queryState';
import { billingAccessOf } from '../lib/billingAccess';
import { formatCentsUsd } from '../lib/invoiceFormat';
import { usePortalIdentity } from '../lib/identity';
import {
  auntieName,
  bookingChip,
  bookingSubtitle,
  elapsedMinutes,
  greetingKick,
  liveVisitOf,
  pendingChangeLabel,
  relativeDay,
  homeLayoutMode,
  resolveHomeLayout,
  speciesEmoji,
  visitStageOf,
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
 * web while Android already respected it. #1987: the ORDER chooses the page.
 * The standard order keeps the two-column page, with any limits applied and
 * any switched-off card left out; an order the operator changed renders in a
 * single column, exactly like the Kotlin stacked branch. A Limit never
 * changes the page shape.
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
  const bookings = useMyBookings(kinfolkId);
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

  const liveVisit = liveVisitOf(bookings.data);
  const liveArrived = liveVisit !== null && visitStageOf(liveVisit) === 'active';
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
  // #1987: the order alone chooses the page shape. A Limit or a hidden card
  // never does (see `homeLayoutMode`).
  const stacked = homeLayoutMode(sections) === 'stacked';
  const shows = (id: string) => layout.some((s) => s.id === id);
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
            // #1832: the card opens the visit, and it says On the way while the
            // Auntie is on the way. It used to read "Checked in N minutes ago"
            // for that too, counted from the booked start.
            <section className="live" data-testid="live-visit">
              <Link className="live-open" to="/schedule/$visitId" params={{ visitId: liveVisit.id }}>
                <div className="lrow">
                  <span className="pulse" />
                  <span className="tag">{liveArrived ? 'LIVE NOW' : 'ON THE WAY'}</span>
                </div>
                <h2>
                  {auntieName(liveVisit.auntieDisplayName) ?? 'Your Auntie'} {liveArrived ? 'is with' : 'is on the way to'}{' '}
                  {liveVisit.kinNames.join(', ') || 'your kin'}
                </h2>
                {liveArrived ? (
                  <p>
                    {liveVisit.startTimeMs !== null ? `Checked in ${elapsedMinutes(liveVisit.startTimeMs)} minutes ago` : 'Checked in'} for{' '}
                    {visitTitleOf(liveVisit) ?? 'a visit'}. You&rsquo;ll get a KinTale the moment they wrap up.
                  </p>
                ) : (
                  <p>{visitTitleOf(liveVisit) ?? 'Your visit'} starts when they arrive.</p>
                )}
                <div className="lwho">
                  <div className="lav">{speciesEmoji(null)}</div>
                  <div style={{ flex: '0 0 auto' }}>
                    <b>{liveVisit.kinNames.join(', ') || 'Your kin'}</b>
                    <small>{(serviceLabelOf(liveVisit) ?? visitTitleOf(liveVisit) ?? 'Visit').toUpperCase()}</small>
                  </div>
                  <div className="track">
                    <i />
                  </div>
                  {liveArrived && liveVisit.startTimeMs !== null && (
                    <span className="chip" style={{ background: 'rgba(255,255,255,.22)', color: '#fff', flex: '0 0 auto' }}>
                      {elapsedMinutes(liveVisit.startTimeMs)} MIN IN
                    </span>
                  )}
                </div>
              </Link>
            </section>
          );

          const upNextSection = (
            <section className="glass card d2">
              {/* #1461: the heading itself opens Schedule; the separate "Full
                  schedule" link is gone. Still an h2, so it reads as a heading. */}
              <h2 className="sectlabel">
                <Link className="sect-head" to="/schedule">
                  Up next <span aria-hidden="true">&rsaquo;</span>
                </Link>
              </h2>
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
                  const chip = bookingChip(visitStageOf(b));
                  const change = pendingChangeLabel(b);
                  // #1461: each row opens that booking, the same route the
                  // Schedule rows use.
                  return (
                    <Link className={`visit ${visitVariant(i)}`} to="/schedule/$visitId" params={{ visitId: b.id }} key={b.id}>
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
                    </Link>
                  );
                })
              )}
            </section>
          );

          // #1462 (mobile map, #1295): with View invoices gone from Quick
          // Start, money owed gets one cue here, only when something is owed
          // and only for a member with billing access. It rides `home`, whose
          // wait the hero's spinner already shows, so it has no cue of its own.
          const balanceDueCents = home.data?.balanceDueCents ?? 0;
          const balanceDueSection =
            homeView.kind === 'data' && billingAccessOf(home.data) && balanceDueCents > 0 ? (
              <Link className="glass card balance-due" to="/invoices">
                <span className="label">Balance due</span> <b>{formatCentsUsd(balanceDueCents)}</b>
                <span aria-hidden="true">&rsaquo;</span>
              </Link>
            ) : null;

          const talesSection = (
            <section className="glass card d3">
              <h2 className="sectlabel">
                <Link className="sect-head" to="/kintales">
                  Recent KinTales <span aria-hidden="true">&rsaquo;</span>
                </Link>
              </h2>
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
                        {`FROM ${(auntieName(t.authorDisplayName) ?? 'Your Auntie').toUpperCase()}${t.sentAtMs !== null ? ` · ${relativeDay(t.sentAtMs).toUpperCase()}` : t.sentAtText ? ` · ${t.sentAtText}` : ''}`}
                      </div>
                    </div>
                  </Link>
                ))
              )}
            </section>
          );

          // #1412: first card on the page, so it carries the first stagger step.
          // #1460 (mobile map, #1295): one button. Messages is on the bar and
          // Invoices is in the avatar menu, so Home does not repeat them.
          const quickStartSection = (
            <section className="glass card d1">
              <div className="sectlabel">Quick start</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <Link className="btn grad block" to="/schedule/book" search={{ weekly: false }}>
                  {'\u{1F4C5}'} Book a visit
                </Link>
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

          // The standard order -> the two-column page. An order the operator
          // changed -> that order in a single column (a custom order can't be
          // meaningfully forced into two fixed columns), matching
          // HomeScreen.kt's stacked branch.
          if (stacked) {
            // The Balance due line follows Up next; with Up next switched off
            // it goes last, so a configured layout never hides money owed.
            // #1987: the cards between two live-visit slots share ONE `.stack`,
            // which is what puts the gap between them. Each used to sit in a
            // stack of its own and touch the card above.
            const groups: ReactNode[] = [];
            let run: ReactNode[] = [];
            const flush = (key: string) => {
              if (run.length === 0) return;
              groups.push(<div className="stack" key={key}>{run}</div>);
              run = [];
            };
            for (const sec of layout) {
              const el = sectionById[sec.id];
              if (!el) continue;
              if (sec.id === 'liveVisit') {
                flush(`before-${sec.id}`);
                groups.push(<Fragment key={sec.id}>{el}</Fragment>);
                continue;
              }
              run.push(<Fragment key={sec.id}>{el}</Fragment>);
              if (sec.id === 'upNext' && balanceDueSection) {
                run.push(<Fragment key="balanceDue">{balanceDueSection}</Fragment>);
              }
            }
            if (!shows('upNext') && balanceDueSection) {
              run.push(<Fragment key="balanceDue">{balanceDueSection}</Fragment>);
            }
            flush('last');
            return <div data-home-layout="stacked">{groups}</div>;
          }
          // Quick Start comes FIRST in the DOM so the phone's single column
          // (where `.cols` collapses in DOM order) puts it above Up next, above
          // the fold at 390px. On a wide screen `.cols > .aside { order: 2 }`
          // (base.css) moves it back to the right-hand column, so main stays
          // left at 1.6fr and the aside right at 1fr, the same split as
          // HomeScreen.kt's Row.
          return (
            <>
              {shows('liveVisit') && liveVisitSection}
              <div className="cols" data-home-layout="columns">
                <div className="stack aside">
                  {quickStartSection}
                </div>
                <div className="stack">
                  {shows('upNext') && upNextSection}
                  {balanceDueSection}
                  {shows('tales') && talesSection}
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
