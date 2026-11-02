import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyKin } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { FallbackImage } from '../components/FallbackImage';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { viewOfQuery } from '../lib/queryState';
import { speciesEmoji } from '../lib/portalFormat';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

const FALLBACK = 'Not set';

/**
 * Kin detail, ported from ui-ideas/mytribe-kin-detail-2026-05-31.html.
 * There's no dedicated getKinById callable — getMyKin already returns every
 * detail field, so this screen reads the same ['myKin'] cache as Home/Kin
 * and finds the row by id. The Vet line is the free-text `vetInfo` the admin
 * also keeps on the pet (#1310), not a clinic-directory link. Edit (O-17) links to the KinEdit form at
 * /kin/$kinId/edit, mirroring Compose's AddEditKinDialog.
 *
 * #1311: this page reads only. The mockup's Memorial card (and its SUGGESTION
 * badge) is gone by ruling; "Mark No Longer With Us" and "Restore as Active"
 * live at the bottom of KinEdit behind a confirm step. The "In our hearts"
 * band in the hero stays.
 */
export function KinDetail() {
  const { kinId } = useParams({ from: '/kin/$kinId' });

  const kinfolkId = getActiveKinfolkId();
  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });

  const { signOut, signingOut } = useSignOut();

  if (kin.isError) {
    return <LaunchError onRetry={() => void kin.refetch()} retrying={kin.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  // Paused, this gate used to be false and the screen fell through to the
  // `!found` card below: "we couldn't find that Kin", about a roster nobody
  // ever read.
  const kinView = viewOfQuery(kin);
  if (kinView.kind === 'offline') {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <section className="glass card">
            <OfflineNotice what="this profile" />
          </section>
        </div>
      </>
    );
  }
  if (kinView.kind !== 'data') {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <p className="sub">Loading profile…</p>
        </div>
      </>
    );
  }

  const found = kin.data?.kin.find((k) => k.id === kinId) ?? null;

  if (!found) {
    return (
      <>
        <PortalNav active="tribe" />
        <div className="wrap">
          <div className="crumbrow">
            <Link className="backlink" to="/kin">
              {'←'} Back to Kin
            </Link>
          </div>
          <section className="glass card">
            <h3 className="title">We couldn&rsquo;t find that profile.</h3>
            <p className="sub">It may have been removed. Head back to The Kin to see the current roster.</p>
          </section>
        </div>
      </>
    );
  }

  const memorial = found.status === 'noLongerWithUs';

  return (
    <>
      <PortalNav active="tribe" />

      <div className="wrap">
        <div className="crumbrow">
          <Link className="backlink" to="/kin">
            {'←'} Back to Kin
          </Link>
          <div className="seg">
            <span className="page">Profile</span>
            <Link className="btn grad" to="/kin/$kinId/edit" params={{ kinId }}>
              {'✎'} Edit
            </Link>
          </div>
        </div>

        <section className="glass kinhero">
          <div className="bigpic">
            <FallbackImage
              src={found.photoUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fallback={speciesEmoji(found.species)}
            />
          </div>
          <div className="htext">
            <h1>{found.name ?? 'Unnamed Kin'}</h1>
            <div className="hmeta">
              <span className="speciechip">
                {speciesEmoji(found.species)} {found.species ?? 'Kin'}
              </span>
              {memorial && <span className="memband">{'\u{1F494}'} In our hearts</span>}
            </div>
          </div>
        </section>

        <div className="cols">
          <div className="stack">
            <section className="glass card d1">
              <div className="sectlabel">About</div>
              <h3 className="title">The basics</h3>
              <div className="facts">
                <div className="fact">
                  <div className="k">Species</div>
                  <div className="v">{found.species ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Breed</div>
                  <div className="v">{found.breed ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Age</div>
                  <div className="v">{found.ageYears !== null ? `${found.ageYears} yrs` : FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Sex</div>
                  <div className="v">{found.sex ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Weight</div>
                  <div className="v">{found.weight ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Color / markings</div>
                  <div className="v">{found.colorMarkings ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Spayed / neutered</div>
                  <div className="v">{found.spayedNeutered ? 'Yes' : 'No'}</div>
                </div>
              </div>
            </section>

            <section className="glass card d2">
              <div className="sectlabel">Care</div>
              <h3 className="title">Daily routine and needs</h3>
              <div className="facts">
                <div className="fact">
                  <div className="k">Feeding</div>
                  <div className="v">{found.feedingInstructions ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Walking</div>
                  <div className="v">{found.walkingInstructions ?? FALLBACK}</div>
                </div>
                <div className="fact">
                  <div className="k">Medications</div>
                  <div className="v">{found.medications ?? 'None'}</div>
                </div>
                <div className="fact">
                  <div className="k">Allergies</div>
                  <div className="v">{found.allergies ?? 'None'}</div>
                </div>
                <div className="fact">
                  <div className="k">Vet</div>
                  <div className="v">{found.vetInfo ?? FALLBACK}</div>
                </div>
              </div>
            </section>
          </div>

          <div className="stack">
            <section className="glass card d3">
              <div className="sectlabel">Sitter Notes</div>
              <h3 className="title">Good to know</h3>
              <p className="note">{found.sitterNotes ?? 'No notes yet.'}</p>
            </section>

            <section className="glass card emergency d4">
              <div className="sectlabel">Emergency Notes</div>
              <h3 className="title">{'⚠'} In case of emergency</h3>
              <p className="note">{found.emergencyNotes ?? 'No emergency notes on file.'}</p>
            </section>
          </div>
        </div>

        <SettingsBusinessFootnote />
      </div>
    </>
  );
}
