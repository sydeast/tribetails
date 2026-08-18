import { Link } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getMyKinPhotos, type KinPhotoDto } from '../api/kinTalesApi';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { relativeDay } from '../lib/portalFormat';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import '../styles/gallery.css';

const PAGE_SIZE = 12;
const TILE_VARIANTS = ['g1', 'g2', 'g3', 'g4'] as const;

/**
 * Every photo of a household's Kin, in one place (issue #399, item 1).
 *
 * This is the screen behind the Tribe hub's "All photos", which was an inert
 * span with a "Coming soon" title until now, because there was no portal media
 * callable that could answer "all of it" at all.
 *
 * Two kinds of picture, kept apart because they are not the same thing.
 * PORTRAITS are the one current photo per Kin, the same image the roster and
 * the Kin detail screen show, overwritten in place on every upload with no
 * history kept anywhere. PHOTOS are the archive: every image an Auntie has
 * attached to a KinTale, newest first, older ones fetched a page at a time.
 *
 * A video attached to a tale is NOT drawn as a photo tile with a broken image
 * in it. `contentType` is the server's word for what the file is, and an
 * `<img>` pointed at an mp4 renders as a broken-image glyph, which a household
 * reads as a picture that failed to load rather than as a clip.
 */
export function Gallery() {
  const kinfolkId = getActiveKinfolkId();
  const { signOut, signingOut } = useSignOut();

  const photos = useInfiniteQuery({
    queryKey: ['myKinPhotos', kinfolkId],
    queryFn: ({ pageParam }) =>
      getMyKinPhotos(kinfolkId, { limit: PAGE_SIZE, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore && last.nextBefore !== null ? last.nextBefore : undefined),
  });

  if (photos.isError) {
    return (
      <LaunchError
        onRetry={() => void photos.refetch()}
        retrying={photos.isRefetching}
        onSignOut={signOut}
        signingOut={signingOut}
      />
    );
  }

  // Portraits ride on the first page only, which is why this reads page 0
  // rather than flattening every page.
  const portraits = photos.data?.pages[0]?.portraits ?? [];
  const tiles = (photos.data?.pages ?? []).flatMap((p) => p.photos);
  const loading = photos.isLoading;

  return (
    <>
      <PortalNav active="tribe" />

      <div className="wrap">
        <div className="crumbrow">
          <Link className="backlink" to="/tribe">
            {'←'} Back to your Tribe
          </Link>
        </div>

        <header className="hero-greet">
          <div className="kick">Every picture we have of your Kin</div>
          <h1>The Gallery</h1>
        </header>

        <div className="stack">
          {portraits.length > 0 && (
            <section className="glass card d1">
              <div className="sectlabel">
                Your Kin <Link to="/kin">Manage</Link>
              </div>
              <div className="gallery-row">
                {portraits.map((p) => (
                  <Link
                    className="gallery-thumb"
                    to="/kin/$kinId"
                    params={{ kinId: p.kinId }}
                    key={p.kinId}
                    title={p.kinName}
                  >
                    <img src={p.url} alt={p.kinName} />
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="glass card d2">
            <div className="sectlabel">
              From your KinTales <Link to="/kintales">All tales</Link>
            </div>

            {loading ? (
              <p className="sub" data-testid="gallery-loading">
                Loading your photos…
              </p>
            ) : tiles.length === 0 ? (
              <p className="sub" data-testid="gallery-empty">
                No photos yet. Every KinTale your Auntie sends brings its pictures here.
              </p>
            ) : (
              <div className="gallery-grid" data-testid="gallery-grid">
                {tiles.map((photo, i) => (
                  <GalleryTile key={photo.id} photo={photo} variant={TILE_VARIANTS[i % TILE_VARIANTS.length] ?? 'g1'} />
                ))}
              </div>
            )}

            {photos.hasNextPage && (
              <button
                className="btn ghost block"
                type="button"
                style={{ marginTop: 16 }}
                onClick={() => void photos.fetchNextPage()}
                disabled={photos.isFetchingNextPage}
              >
                {photos.isFetchingNextPage ? 'Loading…' : 'Show older photos'}
              </button>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function isImage(contentType: string | null): boolean {
  return contentType === null || contentType.startsWith('image/');
}

function GalleryTile({ photo, variant }: { photo: KinPhotoDto; variant: string }) {
  const caption = photo.taleTitle || (photo.takenAtMs !== null ? relativeDay(photo.takenAtMs) : 'A KinTale');
  return (
    // Links to the KinTales feed rather than to one tale: the feed route takes
    // no search params today, and inventing one here would be a second thing to
    // get wrong on a screen whose job is showing pictures.
    <Link className={`gallery-tile ${variant}`} to="/kintales" title={caption}>
      {isImage(photo.contentType) ? (
        <img src={photo.url} alt={caption} loading="lazy" />
      ) : (
        // A video, drawn as a video. An <img> pointed at an mp4 renders as a
        // broken-image glyph, which reads as a photo that failed to load.
        <span className="gallery-tile__video" aria-hidden="true">
          {'\u{25B6}\u{FE0F}'}
        </span>
      )}
      <span className="gallery-tile__caption">{caption}</span>
    </Link>
  );
}
