import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getMyKin } from '../api/portal';
import { getMyKinPhotos, type KinPhotoDto } from '../api/kinTalesApi';
import { getMyTribeProfile } from '../api/tribeApi';
import { GALLERY_CARD_PAGE, tribeHubPhotosKey, tribeProfileKey } from '../lib/portalQueryKeys';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { FallbackImage, PHOTO_UNAVAILABLE_GLYPH } from '../components/FallbackImage';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { viewOfQuery } from '../lib/queryState';
import { speciesEmoji } from '../lib/portalFormat';
import { BusyLabel, LoadingLine } from '../components/Loading';
import { formatPhone } from '../lib/phone';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

const KIN_VARIANTS = ['k1', 'k2', 'k3', 'k4'] as const;

/**
 * #1463: the Gallery card reads the same first page the Gallery screen reads
 * (Gallery.tsx PAGE_SIZE). `limit` counts KinTales, not pictures, so a smaller
 * page could come back with no photos for a household that has plenty, and the
 * card would wrongly say there are none. The card draws at most
 * GALLERY_CARD_THUMBS of what comes back. Same numbers as TribeHubScreen.kt.
 */
// GALLERY_CARD_PAGE lives in lib/portalQueryKeys.ts (#1282: the warm-up reads
// the same page without pulling this screen's chunk in) and is re-exported
// here for the test and for readers who come looking for it.
export { GALLERY_CARD_PAGE };
export const GALLERY_CARD_THUMBS = 8;

type CardThumb =
  | { kind: 'photo'; key: string; photo: KinPhotoDto }
  | { kind: 'portrait'; key: string; url: string; name: string };

/**
 * Tribe hub: a read-only "family base" dashboard, distinct from the Tribe
 * Profile editor (TribeProfile.tsx) and from the full Kin roster (Kin.tsx).
 * Ported structurally from TribeHubScreen.kt (src/commonMain/kotlin/com/
 * kinfolk/portal/screens/tribe/TribeHubScreen.kt) — calls getMyKin,
 * getMyKinPhotos (first page), getMyTribeProfile, same three best-effort loads.
 *
 * NOTE ON THE MOCKUP: ui-ideas/mytribe-tribe-2026-05-31.html is entirely the
 * Tribe Profile *editor* (Family/Home Information/Vet Clinic edit cards) —
 * it has no hub/dashboard markup at all. This screen's layout is therefore
 * assembled from the shared design-system primitives already extracted into
 * base.css/kindetail.css (.hero-greet, .glass.card, .sectlabel, .kinrow,
 * .tale, .footnote) using TribeHubScreen.kt as the structural spec, the same
 * way Home.tsx already renders "Your tribe" (.kinrow) and "Recent KinTales"
 * (.tale) cards. "All photos" opens Gallery.tsx (#399 item 1), which is built
 * from the same shared primitives as this card for the same reason.
 *
 * #1463 (operator, 2026-11-02): "KinTales have media taken for the visit. but
 * Gallery is the collection of all media over time." The Gallery card is
 * always drawn and shows the newest KinTale media plus the Kin portraits, not
 * just the roster's faces. The KinTales section that used to sit here is gone;
 * it repeated the Tales tab.
 */
export function TribeHub() {
  const kinfolkId = getActiveKinfolkId();

  const kin = useQuery({ queryKey: ['myKin', kinfolkId], queryFn: () => getMyKin(kinfolkId) });
  // Its own cache key: Gallery.tsx keeps an infinite query under
  // ['myKinPhotos', kinfolkId], and a plain query in that slot would be the
  // wrong shape for it.
  const media = useQuery({
    queryKey: tribeHubPhotosKey(kinfolkId),
    queryFn: () => getMyKinPhotos(kinfolkId, { limit: GALLERY_CARD_PAGE }),
  });
  const profile = useQuery({ queryKey: tribeProfileKey(kinfolkId), queryFn: () => getMyTribeProfile(kinfolkId) });

  const { signOut, signingOut, error: signOutError } = useSignOut();

  if (kin.isError) {
    return <LaunchError onRetry={() => void kin.refetch()} retrying={kin.isRefetching} onSignOut={signOut} signingOut={signingOut} signOutError={signOutError} />;
  }

  const kinView = viewOfQuery(kin, { isEmpty: (d) => d.kin.filter((k) => k.status === 'active').length === 0 });
  const mediaView = viewOfQuery(media, { isEmpty: (d) => d.photos.length === 0 && d.portraits.length === 0 });
  const profileView = viewOfQuery(profile);
  const roster = kin.data?.kin.filter((k) => k.status === 'active') ?? [];
  // Newest KinTale media first, then the Kin portraits. Same order on Android.
  const thumbs: CardThumb[] = [
    ...(media.data?.photos ?? []).map((photo): CardThumb => ({ kind: 'photo', key: `p-${photo.id}`, photo })),
    ...(media.data?.portraits ?? []).map((p): CardThumb => ({ kind: 'portrait', key: `k-${p.kinId}`, url: p.url, name: p.kinName })),
  ].slice(0, GALLERY_CARD_THUMBS);
  const displayName = profile.data?.profile.displayName ?? '';

  const homeFacts: string[] = [];
  if (profile.data) {
    const { homeAccess, profile: p } = profile.data;
    if (homeAccess.gateCode) homeFacts.push('Gate / door code on file');
    if (homeAccess.keyLocation) homeFacts.push('Key location on file');
    if (homeAccess.wifiPassword) homeFacts.push('Wi-Fi on file');
    // #1325: the clinic the household picked, resolved by the server from its
    // `vetClinicId`. The old `vetClinicName` row is only what a household saved
    // before the picker, so it is the fallback and never wins over a pick.
    const vet = profile.data.vetClinic;
    const legacyVet = p.customFields.find((f) => f.key === 'vetClinicName' && f.value.trim().length > 0);
    if (vet) {
      homeFacts.push(`Vet: ${[vet.name, vet.address, formatPhone(vet.phone)].filter(Boolean).join(' · ')}`);
    } else if (legacyVet) {
      homeFacts.push(`Vet: ${legacyVet.value}`);
    }
  }

  return (
    <>
      <PortalNav active="tribe" />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">Your family base</div>
          <h1>
            {profileView.kind === 'offline'
              ? 'We can\u2019t reach your tribe right now.'
              : profileView.kind !== 'data'
                ? <BusyLabel>Loading your tribe…</BusyLabel>
                : displayName || 'Your Tribe'}
          </h1>
        </header>

        <div className="stack">
          <section className="glass card d1">
            <div className="sectlabel">
              Your Kin <Link to="/kin">Manage</Link>
            </div>
            {kinView.kind === 'offline' ? (
              <OfflineNotice what="your kin" />
            ) : kinView.kind === 'empty' ? (
              <p className="sub">No Kin yet. Add them from Manage.</p>
            ) : kinView.kind !== 'data' ? (
              <p className="sub">Loading your kin…</p>
            ) : (
              roster.map((k, i) => (
                <Link className={`kinrow ${KIN_VARIANTS[i % KIN_VARIANTS.length]}`} to="/kin/$kinId" params={{ kinId: k.id }} key={k.id}>
                  <div className="pic">
                    <FallbackImage
                      src={k.photoUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      fallback={speciesEmoji(k.species)}
                    />
                  </div>
                  <div>
                    <b>{k.name ?? 'Unnamed Kin'}</b>
                    <small>{[k.breed, k.ageYears !== null ? `${k.ageYears} yrs` : null].filter(Boolean).join(', ').toUpperCase()}</small>
                  </div>
                </Link>
              ))
            )}
          </section>

          <section className="glass card d2" data-testid="tribe-gallery">
            <div className="sectlabel">
              Gallery <Link to="/gallery">All photos</Link>
            </div>
            {mediaView.kind === 'offline' ? (
              <OfflineNotice what="your photos" />
            ) : mediaView.kind === 'error' ? (
              <p className="sub">Photos unavailable right now.</p>
            ) : mediaView.kind === 'empty' ? (
              // The page counts KinTales, so a household whose newest tales
              // carry no pictures can still have older ones behind it.
              <p className="sub" data-testid="tribe-gallery-empty">
                {media.data?.hasMore ? 'No recent photos. Older ones are in All photos.' : 'No photos yet.'}
              </p>
            ) : mediaView.kind !== 'data' ? (
              <LoadingLine what="your photos" retry={() => void media.refetch()}>
                Loading your photos…
              </LoadingLine>
            ) : (
              <div className="gallery-row">
                {thumbs.map((t) => (
                  <GalleryCardThumb thumb={t} key={t.key} />
                ))}
              </div>
            )}
          </section>

          <section className="glass card d3">
            <div className="sectlabel">
              Home Information <Link to="/tribe/edit">Edit</Link>
            </div>
            {profileView.kind === 'offline' ? (
              <OfflineNotice what="your home details" />
            ) : profileView.kind === 'error' ? (
              <p className="sub">Home details unavailable right now.</p>
            ) : profileView.kind !== 'data' ? (
              <p className="sub">Loading home details…</p>
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

        {/* #1454 (operator ruling on #1295): on wide web the page keeps its own
            Edit Tribe Profile button, after the last card instead of under the
            heading. At phone width base.css hides `.tribehub-edit` under the
            same media query that swaps `.navlinks` for `.tabbar`, so the avatar
            menu's entry is the only one, the same as Android. The Home
            Information card's "Edit" link above is that card's own and stays. */}
        <Link className="btn ghost tribehub-edit" to="/tribe/edit">
          {'✎'} Edit Tribe Profile
        </Link>

        <SettingsBusinessFootnote />
      </div>
    </>
  );
}

function GalleryCardThumb({ thumb }: { thumb: CardThumb }) {
  if (thumb.kind === 'portrait') {
    return (
      <div className="gallery-thumb" title={thumb.name}>
        <FallbackImage src={thumb.url} alt={thumb.name} fallback={<span aria-hidden="true">{'\u{1F43E}'}</span>} />
      </div>
    );
  }
  const { photo } = thumb;
  const name = photo.taleTitle || 'A KinTale';
  const isImage = photo.contentType === null || photo.contentType.startsWith('image/');
  return (
    <div className="gallery-thumb" title={name}>
      {isImage ? (
        <FallbackImage src={photo.url} alt={name} fallback={<span aria-hidden="true">{PHOTO_UNAVAILABLE_GLYPH}</span>} />
      ) : (
        // A video is drawn as a video, the same as the Gallery screen's tiles:
        // an <img> pointed at an mp4 shows as a broken picture.
        <span role="img" aria-label={name}>
          {'\u{25B6}\u{FE0F}'}
        </span>
      )}
    </div>
  );
}
