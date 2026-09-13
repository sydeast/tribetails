import { Fragment, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyBookings, getMyHome, getMyKin, getMyKinTales } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { LaunchError } from './LaunchError';
import { InstallAndAlerts } from '../components/InstallAndAlerts';
import { PortalNav } from '../components/PortalNav';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { viewOfQuery } from '../lib/queryState';
import {
  bookingChip,
  calTile,
  elapsedMinutes,
  greetingKick,
  kinVariant,
  relativeDay,
  resolveHomeLayout,
  speciesEmoji,
  visitSubtitle,
  visitVariant,
} from '../lib/portalFormat';

/**
 * Home, ported from ui-ideas/mytribe-home-2026-05-31.html. `getMyHome` only
 * carries identity/config. The live sections come from three independent,
 * best-effort calls: getMyBookings, getMyKinTales, getMyKin. A failure in any
 * one of those degrades that section only; only a failed getMyHome (identity)
 * blocks the whole screen.
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
 * "Hi , your tribe is in good hands." over three sections claiming there was
 * nothing on the calendar, no KinTales and no kin. The three gated queries make
 * it worse than most screens: while `home` is paused they are `enabled: false`,
 * so they never even reach 'paused' and sit at pending/idle. `gate: home` is
 * what makes them answer with home's reason instead of with silence.
 */
export function Home() {
  const kinfolkId = getActiveKinfolkId();
  const home = useQuery({ queryKey: ['myHome', kinfolkId], queryFn: () => getMyHome(kinfolkId) });
  const bookings = useQuery({ queryKey: ['myBookings', kinfolkId], queryFn: () => getMyBookings(kinfolkId), enabled: home.isSuccess });
  const kinTales = useQuery({
    queryKey: ['myKinTales', 'home-preview', kinfolkId],
    queryFn: () => getMyKinTales(kinfolkId, { limit: 3 }),
    enabled: home.isSuccess,
  });
  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId), enabled: home.isSuccess });

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

  const displayName = home.data?.displayName ?? '';
  const liveVisit = bookings.data?.liveVisit ?? null;
  // `home.isError` is answered by the early return above, and `home` is not
  // gated, so homeView is only ever data / offline / loading. The other three
  // are best-effort (see the header): each can fail on its own while the rest of
  // the screen is fine, so each gets its own error arm below. Folding an error
  // into the loading arm would swap the old false-empty for a false spinner
  // that never ends, which is the same lie wearing a different hat.
  const homeView = viewOfQuery(home);
  const bookingsView = viewOfQuery(bookings, { isEmpty: (d) => d.upcoming.length === 0, gate: home });
  const talesView = viewOfQuery(kinTales, { isEmpty: (d) => d.tales.length === 0, gate: home });
  // The roster has no empty state to protect: it always ends with the Add Kin
  // row, which reads correctly whether or not there is anybody above it.
  const kinView = viewOfQuery(kin, { gate: home });

  const sections = home.data?.portal.home ?? [];
  const layout = resolveHomeLayout(sections);
  const custom = sections.length > 0;
  function sectionLimit(id: string, fallback: number): number {
    const configured = layout.find((s) => s.id === id)?.limit ?? 0;
    return configured > 0 ? configured : fallback;
  }

  // Fallbacks match HomeScreen.kt's resolveHomeLayout defaults exactly
  // (upNext 5, tales 3, roster 4) — parity, not arbitrary web-specific values.
  const upcoming = (bookings.data?.upcoming ?? []).slice(0, sectionLimit('upNext', 5));
  const tales = (kinTales.data?.tales ?? []).slice(0, sectionLimit('tales', 3));
  const activeKin = (kin.data?.kin ?? []).filter((k) => k.status === 'active').slice(0, sectionLimit('roster', 4));

  return (
    <>
      <PortalNav active="home" displayName={displayName} />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">{greetingKick()}</div>
          <h1>
            {homeView.kind === 'offline' ? (
              // Not "Hi , your tribe is in good hands." We do not know whose
              // tribe this is right now, so we do not claim to.
              <>We can&rsquo;t reach your tribe right now.</>
            ) : homeView.kind !== 'data' ? (
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
                Hi {displayName}, your <span>tribe</span> is in good hands.
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
                {liveVisit.auntieDisplayName ? `Auntie ${liveVisit.auntieDisplayName}` : 'Your Auntie'} is with{' '}
                {liveVisit.kinNames.join(', ') || 'your kin'}
              </h2>
              <p>
                {liveVisit.startTimeMs !== null ? `Checked in ${elapsedMinutes(liveVisit.startTimeMs)} minutes ago` : 'Checked in'} for{' '}
                {liveVisit.title ?? liveVisit.serviceType ?? 'a visit'}. You&rsquo;ll get a KinTale the moment they wrap up.
              </p>
              <div className="lwho">
                <div className="lav">{speciesEmoji(null)}</div>
                <div style={{ flex: '0 0 auto' }}>
                  <b>{liveVisit.kinNames[0] ?? 'Your kin'}</b>
                  <small>{(liveVisit.serviceType ?? liveVisit.title ?? 'VISIT').toUpperCase()}</small>
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
            <section className="glass card d1">
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
                  const tile = b.startTimeMs !== null ? calTile(b.startTimeMs) : { month: '—', day: '—' };
                  const chip = bookingChip(b.status);
                  return (
                    <div className={`visit ${visitVariant(i)}`} key={b.id}>
                      <div className="cal">
                        <div className="m">{tile.month}</div>
                        <div className="d">{tile.day}</div>
                      </div>
                      <div className="info">
                        <b>{b.title ?? b.serviceType ?? 'Visit'}</b>
                        <small>{visitSubtitle(b.startTimeMs, b.auntieDisplayName)}</small>
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
            <section className="glass card d2">
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
                  <div className={`tale a${(i % 3) + 1}`} key={t.id}>
                    <div className="photo">{'\u{1F43E}'}</div>
                    <div className="tb">
                      <b>{t.title || t.body.slice(0, 60)}</b>
                      <p>{t.body}</p>
                      <div className="meta">
                        {`FROM AUNTIE ${t.authorDisplayName.toUpperCase()}${t.sentAtMs !== null ? ` · ${relativeDay(t.sentAtMs).toUpperCase()}` : ''}`}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </section>
          );

          const rosterSection = (
            <section className="glass card d3">
              <div className="sectlabel">
                Your tribe <Link to="/kin">The Kin</Link>
              </div>
              {kinView.kind === 'offline' ? (
                <OfflineNotice what="your kin" />
              ) : kinView.kind === 'error' ? (
                <p className="sub">Your kin list is unavailable right now.</p>
              ) : kinView.kind !== 'data' ? (
                <LoadingLine what="your kin" retry={() => void kin.refetch()}>
                  Loading your kin…
                </LoadingLine>
              ) : (
                activeKin.map((k, i) => (
                  <Link className={`kinrow ${kinVariant(i)}`} to="/kin/$kinId" params={{ kinId: k.id }} key={k.id}>
                    <div className="pic">{speciesEmoji(k.species)}</div>
                    <div>
                      <b>{k.name ?? 'Unnamed Kin'}</b>
                      <small>{[k.breed, k.ageYears !== null ? `${k.ageYears} yrs` : null].filter(Boolean).join(', ').toUpperCase()}</small>
                    </div>
                  </Link>
                ))
              )}
              <Link className="kinrow add" to="/kin">
                <div className="pic">+</div>
                <div>
                  <b>Add Kin</b>
                  <small>NEW PROFILE</small>
                </div>
              </Link>
            </section>
          );

          const quickStartSection = (
            <section className="glass card d4">
              <div className="sectlabel">Quick start</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <Link className="btn grad block" to="/schedule/book" search={{ weekly: false }}>
                  {'\u{1F4C5}'} Book a visit
                </Link>
                <Link className="btn ghost block" to="/messages">
                  {'\u{1F4AC}'} Message your Auntie
                </Link>
                <Link className="btn ghost block" to="/invoices">
                  {'\u{1F4B0}'} View invoices
                </Link>
              </div>
            </section>
          );

          const sectionById: Record<string, ReactNode> = {
            liveVisit: liveVisitSection,
            upNext: upNextSection,
            tales: talesSection,
            roster: rosterSection,
            quickStart: quickStartSection,
          };

          // Empty operator config -> the same fixed two-column layout as
          // always. A configured layout -> the configured order/limits in a
          // single column (a custom order can't be meaningfully forced into
          // two fixed columns) — matches HomeScreen.kt's `custom` branch.
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

          return (
            <>
              {liveVisitSection}
              <div className="cols">
                <div className="stack">
                  {upNextSection}
                  {talesSection}
                </div>
                <div className="stack">
                  {rosterSection}
                  {quickStartSection}
                </div>
              </div>
            </>
          );
        })()}

        {/* Which of the two banners shows, and in what order, is a decision
            of its own on iOS. See components/InstallAndAlerts.tsx. */}
        <InstallAndAlerts />

        <p className="footnote">
          Cared for by <b>{home.data?.businessName || 'Tribe Tails Pet Care'}</b>
        </p>
      </div>
    </>
  );
}
