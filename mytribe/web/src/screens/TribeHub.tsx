import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyKin, getMyKinTales } from '../api/portal';
import { getMyTribeProfile } from '../api/tribeApi';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import { relativeDay, speciesEmoji } from '../lib/portalFormat';

const KIN_VARIANTS = ['k1', 'k2', 'k3', 'k4'] as const;

/**
 * Tribe hub: a read-only "family base" dashboard, distinct from the Tribe
 * Profile editor (TribeProfile.tsx) and from the full Kin roster (Kin.tsx).
 * Ported structurally from TribeHubScreen.kt (src/commonMain/kotlin/com/
 * kinfolk/portal/screens/tribe/TribeHubScreen.kt) — calls getMyKin,
 * getMyKinTales(limit=4), getMyTribeProfile, same three best-effort loads.
 *
 * NOTE ON THE MOCKUP: ui-ideas/mytribe-tribe-2026-05-31.html is entirely the
 * Tribe Profile *editor* (Family/Home Information/Vet Clinic edit cards) —
 * it has no hub/dashboard markup at all. This screen's layout is therefore
 * assembled from the shared design-system primitives already extracted into
 * base.css/kindetail.css (.hero-greet, .glass.card, .sectlabel, .kinrow,
 * .tale, .footnote) using TribeHubScreen.kt as the structural spec, the same
 * way Home.tsx already renders "Your tribe" (.kinrow) and "Recent KinTales"
 * (.tale) cards. Neither "All photos" nor "All tales" has a dedicated view in
 * ui-ideas; both now go somewhere anyway. "All tales" opens the KinTales
 * screen, and "All photos" opens Gallery.tsx (#399 item 1), which is built
 * from the same shared primitives as this card for the same reason.
 */
export function TribeHub() {
  const kinfolkId = getActiveKinfolkId();

  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });
  const tales = useQuery({
    queryKey: ['myKinTales', 'tribe-hub', kinfolkId],
    queryFn: () => getMyKinTales(kinfolkId, { limit: 4 }),
  });
  const profile = useQuery({ queryKey: ['tribeProfile', kinfolkId], queryFn: () => getMyTribeProfile(kinfolkId) });

  const { signOut, signingOut } = useSignOut();

  if (kin.isError) {
    return <LaunchError onRetry={() => void kin.refetch()} retrying={kin.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  const roster = kin.data?.kin.filter((k) => k.status === 'active') ?? [];
  const gallery = roster.filter((k) => k.photoUrl);
  const recentTales = (tales.data?.tales ?? []).slice(0, 3);
  const displayName = profile.data?.profile.displayName ?? '';

  const homeFacts: string[] = [];
  if (profile.data) {
    const { homeAccess, profile: p } = profile.data;
    if (homeAccess.gateCode) homeFacts.push('Gate / door code on file');
    if (homeAccess.keyLocation) homeFacts.push('Key location on file');
    if (homeAccess.wifiPassword) homeFacts.push('Wi-Fi on file');
    const vet = p.customFields.find((f) => f.key === 'vetClinicName' && f.value.trim().length > 0);
    if (vet) homeFacts.push(`Vet: ${vet.value}`);
  }

  return (
    <>
      <PortalNav active="tribe" displayName={displayName} />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">Your family base</div>
          <h1>{profile.isLoading ? 'Loading your tribe…' : displayName || 'Your Tribe'}</h1>
        </header>

        <Link className="btn ghost" to="/tribe/edit" style={{ marginBottom: 24 }}>
          {'✎'} Edit Tribe Profile
        </Link>

        <div className="stack">
          <section className="glass card d1">
            <div className="sectlabel">
              Your Kin <Link to="/kin">Manage</Link>
            </div>
            {kin.isLoading ? (
              <p className="sub">Loading your kin…</p>
            ) : roster.length === 0 ? (
              <p className="sub">No Kin yet. Add them from Manage.</p>
            ) : (
              roster.map((k, i) => (
                <Link className={`kinrow ${KIN_VARIANTS[i % KIN_VARIANTS.length]}`} to="/kin/$kinId" params={{ kinId: k.id }} key={k.id}>
                  <div className="pic">
                    {k.photoUrl ? <img src={k.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : speciesEmoji(k.species)}
                  </div>
                  <div>
                    <b>{k.name ?? 'Unnamed Kin'}</b>
                    <small>{[k.breed, k.ageYears !== null ? `${k.ageYears} yrs` : null].filter(Boolean).join(', ').toUpperCase()}</small>
                  </div>
                </Link>
              ))
            )}
          </section>

          {gallery.length > 0 && (
            <section className="glass card d2">
              <div className="sectlabel">
                Gallery <Link to="/gallery">All photos</Link>
              </div>
              <div className="gallery-row">
                {gallery.map((k) => (
                  <div className="gallery-thumb" key={k.id} title={k.name ?? undefined}>
                    <img src={k.photoUrl ?? ''} alt="" />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="glass card d3">
            <div className="sectlabel">
              KinTales <Link to="/kintales">All tales</Link>
            </div>
            {tales.isLoading ? (
              <p className="sub">Loading recent KinTales…</p>
            ) : tales.isError ? (
              <p className="sub">KinTales unavailable right now.</p>
            ) : recentTales.length === 0 ? (
              <p className="sub">After each visit, your Auntie&rsquo;s KinTale lands here.</p>
            ) : (
              recentTales.map((t, i) => (
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

          <section className="glass card d4">
            <div className="sectlabel">
              Home Information <Link to="/tribe/edit">Edit</Link>
            </div>
            {profile.isLoading ? (
              <p className="sub">Loading home details…</p>
            ) : profile.isError ? (
              <p className="sub">Home details unavailable right now.</p>
            ) : homeFacts.length === 0 ? (
              <p className="sub">No home details yet. Add gate codes, key location, and your vet.</p>
            ) : (
              <ul className="homefacts">
                {homeFacts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}
