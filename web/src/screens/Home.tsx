import { Fragment, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyBookings, getMyHome, getMyKin, getMyKinTales } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { LaunchError } from './LaunchError';
import { AddToHomeScreen } from '../components/AddToHomeScreen';
import { PushPrompt } from '../components/PushPrompt';
import { PortalNav } from '../components/PortalNav';
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
            {home.isLoading ? (
              'Fetching your tribe…'
            ) : (
              <>
                Hi {displayName}, your <span>tribe</span> is in good hands.
              </>
            )}
          </h1>
        </header>

        {(() => {
          const liveVisitSection = liveVisit && (
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
              {bookings.isLoading ? (
                <p className="sub">Loading your schedule…</p>
              ) : upcoming.length === 0 ? (
                <p className="sub">Nothing on the calendar yet.</p>
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
              {kinTales.isLoading ? (
                <p className="sub">Loading recent KinTales…</p>
              ) : tales.length === 0 ? (
                <p className="sub">Your first KinTale will show up here after a visit.</p>
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
              {kin.isLoading ? (
                <p className="sub">Loading your kin…</p>
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

        <PushPrompt />
        <AddToHomeScreen />

        <p className="footnote">
          Cared for by <b>{home.data?.businessName || 'Tribe Tails Pet Care'}</b>
        </p>
      </div>
    </>
  );
}
