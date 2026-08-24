import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyKin } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { FallbackImage } from '../components/FallbackImage';
import { LaunchError } from './LaunchError';
import { speciesEmoji } from '../lib/portalFormat';

const CARD_VARIANTS = ['p1', 'p2', 'p3', 'p4'] as const;

/** The Kin roster grid, ported from ui-ideas/mytribe-kin-2026-05-31.html. */
export function Kin() {
  const kinfolkId = getActiveKinfolkId();
  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });

  const { signOut, signingOut } = useSignOut();

  if (kin.isError) {
    return <LaunchError onRetry={() => void kin.refetch()} retrying={kin.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  const roster = kin.data?.kin ?? [];

  return (
    <>
      <PortalNav active="tribe" />

      <div className="wrap">
        <div className="titlerow">
          <div>
            <h2>The Kin</h2>
            <div className="sub">Everyone who shares your home. Tap a card to open the full profile.</div>
          </div>
          <Link className="btn grad" to="/kin/new">
            + Add New
          </Link>
        </div>

        {kin.isLoading ? (
          <p className="sub">Loading your kin…</p>
        ) : roster.length === 0 ? (
          <section className="glass card emptystate">
            <div className="ehug">{'\u{1F43E}'}</div>
            <h3>No Kin added yet</h3>
            <p>Add the Kin in your home, names, breeds, photos, care details. Tap each card for full profile.</p>
            <Link className="btn grad" style={{ marginTop: 20 }} to="/kin/new">
              + Add New
            </Link>
          </section>
        ) : (
          <div className="kingrid">
            {roster.map((k, i) => {
              const memorial = k.status === 'noLongerWithUs';
              return (
                <Link
                  className={`glass petcard ${memorial ? 'memorial' : CARD_VARIANTS[i % CARD_VARIANTS.length]}`}
                  to="/kin/$kinId"
                  params={{ kinId: k.id }}
                  key={k.id}
                >
                  {memorial && (
                    <span className="mlabel">
                      {'❤'} In our hearts
                    </span>
                  )}
                  <div className="pphoto">
                    <FallbackImage
                      src={k.photoUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      fallback={speciesEmoji(k.species)}
                    />
                  </div>
                  <div className="pname">{k.name ?? 'Unnamed Kin'}</div>
                  <div className="pbreed">{k.breed ?? k.species ?? ''}</div>
                  <div className="page">{memorial ? 'No Longer With Us' : k.ageYears !== null ? `${k.ageYears} yrs` : 'Age not set'}</div>
                </Link>
              );
            })}

            <Link className="petcard addcard" to="/kin/new">
              <div className="plus">+</div>
              <b>Add New</b>
              <small>NEW KIN PROFILE</small>
            </Link>
          </div>
        )}

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}
