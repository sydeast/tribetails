import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyKinTales } from '../api/portal';
import type { KinTaleDto } from '../api/types';
import {
  addKinTaleComment,
  commentAuthorLabel,
  commentAvatarVariant,
  commentBadge,
  filterTales,
  getKinTaleReaction,
  getMyKinTaleComments,
  getMyKinTaleMedia,
  initialOf,
  loveLine,
  nextTalesCursor,
  shortTimestamp,
  taleMetaLabel,
  threadComments,
  toggleKinTaleLove,
  type KinTaleCommentDto,
  type KinTalesFilter,
} from '../api/kinTalesApi';
import { useAuth, useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { isoTime } from '../lib/portalFormat';
import { PortalNav } from '../components/PortalNav';
import { ShareKinTaleDialog } from '../components/ShareKinTaleDialog';
import { LaunchError } from './LaunchError';
import { RouteMap } from '../components/RouteMap';

const PAGE_SIZE = 20;
const GALLERY_VARIANTS = ['g1', 'g2', 'g3', 'g4'] as const;
const STRIP_VARIANTS = ['s1', 's2', 's3'] as const;
const STRIP_MAX_TILES = 8;
/** Distinguishes a video tile from a failed-to-load photo tile — never the gallery's camera glyph. */
const PLAY_GLYPH = '\u{25B6}\u{FE0F}';

function isImageThumb(contentType: string | null): boolean {
  return contentType === null || contentType.startsWith('image/');
}

const FILTER_TABS: { id: KinTalesFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'lore', label: 'Lore' },
  { id: 'gallery', label: 'Gallery' },
];

/**
 * KinTales feed, ported from ui-ideas/mytribe-kintales-2026-05-31.html
 * (feature banner + gallery grid + comment thread). Data flow mirrors
 * KinTalesScreen.kt rather than the mockup's exact chrome: every tale
 * (not just the first) gets a full, eagerly-loaded comment thread + post
 * box, and photo grids are fetched on demand when a kinfolk opens them
 * (getMyKinTaleMedia per tale, matching the Kotlin screen's expand-to-load
 * gallery instead of front-loading every card's photos). The first tale
 * in the current filter gets the mockup's fancy `.feature` banner
 * treatment; the rest render as compact `.talecard`s — visual-only split,
 * same underlying gallery/comment behavior for both.
 *
 * Reactions (the mockup's "You and 2 others loved this" heart line) are
 * live for every tale (not just featured), same eager-load convention as
 * comments — S4 backend delta, see kinTaleEngagement.ts's toggleKinTaleLove.
 *
 * Share (B3, punchlist item) opens ShareKinTaleDialog (expiry/passcode/
 * revoke controls, P2 ruling) and lives only on the featured card, matching
 * where the mockup put it. "Reply to Auntie" still has no backing callable
 * (messaging land is S5's territory) and stays an inert button, same
 * convention as Home's Invoices quick-start.
 */
export function KinTales() {
  const kinfolkId = getActiveKinfolkId();

  const [filter, setFilter] = useState<KinTalesFilter>('all');
  const [extraPages, setExtraPages] = useState<KinTaleDto[]>([]);
  const [hasMoreOverride, setHasMoreOverride] = useState<boolean | null>(null);

  const firstPage = useQuery({
    queryKey: ['myKinTales', 'full', kinfolkId],
    queryFn: () => getMyKinTales(kinfolkId, { limit: PAGE_SIZE }),
  });

  const loadMore = useMutation({
    mutationFn: (before: number) => getMyKinTales(kinfolkId, { limit: PAGE_SIZE, before }),
    onSuccess: (res) => {
      setExtraPages((prev) => [...prev, ...res.tales]);
      setHasMoreOverride(res.hasMore);
    },
  });

  const { signOut, signingOut } = useSignOut();

  if (firstPage.isError) {
    return (
      <LaunchError
        onRetry={() => void firstPage.refetch()}
        retrying={firstPage.isRefetching}
        onSignOut={signOut} signingOut={signingOut}
      />
    );
  }

  const allTales = [...(firstPage.data?.tales ?? []), ...extraPages];
  const filtered = filterTales(allTales, filter);
  const hasMore = hasMoreOverride ?? firstPage.data?.hasMore ?? false;
  const cursor = nextTalesCursor(allTales);
  const [featuredTale, ...restTales] = filtered;

  return (
    <>
      <PortalNav active="kintales" />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">From your Aunties</div>
          <h1>
            Your <span>KinTales</span>
          </h1>
        </header>

        <div className="tabs" role="tablist">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              className={filter === tab.id ? 'on' : ''}
              onClick={() => setFilter(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {firstPage.isLoading ? (
          <p className="sub">Loading your KinTales…</p>
        ) : !featuredTale ? (
          <section className="glass card emptystate">
            <div className="ehug">{'\u{1F4DD}'}</div>
            <h3>No KinTales yet</h3>
            <p>
              {filter === 'all'
                ? "Your Auntie's daily updates and photos from visits will appear here."
                : `Nothing in ${FILTER_TABS.find((t) => t.id === filter)?.label ?? filter} yet.`}
            </p>
          </section>
        ) : (
          <>
            <TaleCard tale={featuredTale} kinfolkId={kinfolkId} featured />

            {restTales.length > 0 && (
              <div className="sectlabel" style={{ marginTop: 30 }}>
                More from your Aunties
              </div>
            )}

            <div className="stack">
              {restTales.map((t, i) => (
                <TaleCard key={t.id} tale={t} kinfolkId={kinfolkId} featured={false} index={i} />
              ))}
            </div>
          </>
        )}

        {hasMore && !firstPage.isLoading && (
          <div className="loadmore">
            <button
              className="btn ghost"
              disabled={loadMore.isPending || cursor === undefined}
              onClick={() => cursor !== undefined && loadMore.mutate(cursor)}
            >
              {loadMore.isPending ? 'Loading…' : 'Load More'}
            </button>
            {loadMore.isError && <p className="sub">Couldn&rsquo;t load more. Try again.</p>}
          </div>
        )}

        <p className="footnote">
          Cared for by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}

function TaleCard(props: { tale: KinTaleDto; kinfolkId: string | undefined; featured: boolean; index?: number }) {
  const { tale, kinfolkId, featured, index = 0 } = props;
  const [galleryOpen, setGalleryOpen] = useState(false);

  const media = useQuery({
    queryKey: ['kinTaleMedia', kinfolkId, tale.id],
    queryFn: () => getMyKinTaleMedia(tale.id, kinfolkId),
    enabled: galleryOpen && tale.mediaIds.length > 0,
  });

  const headline = tale.title || tale.body.slice(0, featured ? 90 : 70);
  const meta = taleMetaLabel(tale);
  const paragraphs = tale.body.split(/\n+/).filter((p) => p.length > 0);

  // "View N photos" (the mockup's control) is the one full-gallery button —
  // relabeled to "View Gallery" because a tale can carry video too, and
  // "photos" would misdescribe it (operator directive 2026-08-06).
  const galleryBlock = tale.mediaIds.length > 0 && (
    <div className="gallery">
      <div className="glabel">
        Captured Moments
        <button
          type="button"
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '5px 12px', fontSize: 12 }}
          onClick={() => setGalleryOpen((v) => !v)}
        >
          {galleryOpen ? 'Hide' : 'View Gallery'}
        </button>
      </div>
      {galleryOpen &&
        (media.isLoading ? (
          <p className="sub">Loading photos…</p>
        ) : media.isError ? (
          <p className="sub">Couldn&rsquo;t load photos.</p>
        ) : (media.data?.media.length ?? 0) === 0 ? (
          <p className="sub">Photos no longer available. They may have expired.</p>
        ) : (
          <div className="grid">
            {media.data!.media.map((m, i) => (
              <div className={`shot ${GALLERY_VARIANTS[i % GALLERY_VARIANTS.length]}`} key={m.id}>
                {isImageThumb(m.contentType) ? (
                  <img src={m.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  '\u{1F4F7}'
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );

  // Photo-first preview strip (task-24, P3): up to 8 tiles from the list
  // response's `thumbs`, so the card shows media at feed-render time without
  // a getMyKinTaleMedia round trip per card. Non-featured cards only — the
  // featured card's photo-first treatment is its banner avatar, below.
  // `thumbs` is optional (an older deployed function may omit it) — treated
  // as "no thumbnails", not a crash.
  const thumbs = tale.thumbs ?? [];
  const stripBlock = !featured && thumbs.length > 0 && (
    <div className="tcstrip">
      {thumbs.slice(0, STRIP_MAX_TILES).map((thumb, i) => (
        <div className={`sm ${STRIP_VARIANTS[i % STRIP_VARIANTS.length]}`} key={thumb.id}>
          {isImageThumb(thumb.contentType) ? (
            <img src={thumb.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            PLAY_GLYPH
          )}
        </div>
      ))}
    </div>
  );

  const gpsBlock = tale.gpsRoute && tale.gpsRoute.length > 0 && (
    <div style={{ marginTop: 22 }}>
      <RouteMap route={tale.gpsRoute} distanceMeters={tale.gpsSummary?.distanceMeters} durationSeconds={tale.gpsSummary?.durationSeconds} />
    </div>
  );

  // Visit facts (task-25, P4): when the Auntie arrived / departed, in the
  // kinfolk's own local time (isoTime — the same helper Schedule.tsx already
  // uses for a visit's arrival). Either half can be missing (a departure
  // that was never stamped is common); a missing half is simply omitted,
  // never a fabricated "12:00 AM" or the current clock. Neither recorded
  // means no line at all, matching gpsBlock's "renders nothing" convention.
  const arrivedLabel = isoTime(tale.arrivedAtIso);
  const departedLabel = isoTime(tale.departedAtIso);
  const visitFactsParts = [
    arrivedLabel ? `Arrived ${arrivedLabel}` : null,
    departedLabel ? `Departed ${departedLabel}` : null,
  ].filter((p): p is string => p !== null);
  const visitFactsBlock = visitFactsParts.length > 0 && (
    <div className="visitfacts">{visitFactsParts.join(' · ')}</div>
  );

  // Task checklist (task-25, P4): checked items only. `tale.checklist`
  // already carries only what the Auntie's app recorded as done — this
  // component does not, and cannot, infer what was left undone (see
  // getMyKinTales.ts's own doc comment); it just renders what's there.
  const checklist = tale.checklist ?? [];
  const checklistBlock = checklist.length > 0 && (
    <div className="tasksblock">
      <div className="taskslabel">Care tasks done this visit</div>
      <div className="taskschips">
        {checklist.map((item) => (
          <span className="badge done" key={item.key}>
            {item.text}
          </span>
        ))}
      </div>
    </div>
  );

  if (featured) {
    // Photo-first treatment for the banner's byline avatar: the first
    // *image* thumbnail (a video can't stand in for a poster we don't
    // have), or unchanged (today's paw glyph) when the tale has no photo.
    const featuredPhoto = thumbs.find((t) => isImageThumb(t.contentType));
    return (
      <section className="glass feature">
        <div className="banner">
          <div className="kick">Featured KinTale</div>
          <h2>{headline}</h2>
          <div className="byline">
            <div className="bav">
              {featuredPhoto ? (
                <img src={featuredPhoto.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                '\u{1F43E}'
              )}
            </div>
            <div>
              <b>From Auntie {tale.authorDisplayName}</b>
              {meta && <small>{meta}</small>}
            </div>
          </div>
        </div>

        <div className="body">
          <div className="narrative">
            {paragraphs.length > 0 ? paragraphs.map((p, i) => <p key={i}>{p}</p>) : <p>{tale.body}</p>}
          </div>
          {visitFactsBlock}
          {checklistBlock}
          {galleryBlock}
          {gpsBlock}
        </div>

        <div className="actions">
          <TaleShare taleId={tale.id} kinfolkId={kinfolkId} />
          <span className="btn ghost navlink-inert" title="Coming soon">
            {'\u{1F4AC}'} Reply to Auntie {tale.authorDisplayName}
          </span>
          <TaleReaction taleId={tale.id} kinfolkId={kinfolkId} />
        </div>

        <TaleComments taleId={tale.id} kinfolkId={kinfolkId} />
      </section>
    );
  }

  return (
    <section className={`glass talecard t${(index % 2) + 1}`}>
      <div className="tchead">
        <div className="tcphoto">{'\u{1F43E}'}</div>
        <div style={{ flex: 1 }}>
          <h3 className="title">{headline}</h3>
          <div className="meta">{`FROM AUNTIE ${tale.authorDisplayName.toUpperCase()}${meta ? ` · ${meta}` : ''}`}</div>
        </div>
      </div>
      <div className="tcbody">{tale.body}</div>
      {visitFactsBlock}
      {checklistBlock}
      {stripBlock}
      {galleryBlock}
      {gpsBlock}
      <div className="tcfoot">
        <span className="ct">
          {tale.mediaIds.length > 0 ? `${tale.mediaIds.length} Captured Moment${tale.mediaIds.length === 1 ? '' : 's'}` : 'No photos this visit'}
        </span>
        <TaleReaction taleId={tale.id} kinfolkId={kinfolkId} />
      </div>
      <TaleComments taleId={tale.id} kinfolkId={kinfolkId} />
    </section>
  );
}

/**
 * The mockup's "Share" button (B3, punchlist item), made real: opens
 * ShareKinTaleDialog (expiry/passcode/revoke controls, P2 ruling) instead of
 * minting a link with the server defaults on click. The dialog owns the
 * createShareLink/revokeShareLink mutations and their error rendering now;
 * this component only owns showing/hiding it and the one error the dialog
 * can never reach — `kinfolkId` (the server's `familyId`, the requirePrimary
 * anchor) being unresolved, which must fail loud before a dialog requiring a
 * non-null familyId prop can even open. That's the same
 * `share.isError`-style inline message the mutation used to render here,
 * moved rather than lost.
 */
function TaleShare(props: { taleId: string; kinfolkId: string | undefined }) {
  const { taleId, kinfolkId } = props;
  const [open, setOpen] = useState(false);
  const [tribeIdMissing, setTribeIdMissing] = useState(false);

  function handleOpen() {
    if (!kinfolkId) {
      setTribeIdMissing(true);
      return;
    }
    setTribeIdMissing(false);
    setOpen(true);
  }

  return (
    <div>
      <button type="button" className="btn grad" onClick={handleOpen}>
        {'\u{1F517}'} Share
      </button>
      {tribeIdMissing && (
        <div style={{ color: 'var(--coral)', fontSize: 12.5, marginTop: 6 }}>
          Could not tell which tribe this is. Reload the page and try again.
        </div>
      )}
      {open && kinfolkId && <ShareKinTaleDialog taleId={taleId} familyId={kinfolkId} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The mockup's heart + "You and 2 others loved this" line
 * (ui-ideas/mytribe-kintales-2026-05-31.html:348), made clickable to toggle
 * the caller's own reaction. Optimistic update on click (flip loved +/-1
 * count immediately) with a rollback + re-fetch on failure, since a "like"
 * button feeling laggy is a worse UX bug than an occasional wrong-then-
 * corrected count.
 */
function TaleReaction(props: { taleId: string; kinfolkId: string | undefined }) {
  const { taleId, kinfolkId } = props;
  const queryClient = useQueryClient();
  const queryKey = ['kinTaleReaction', kinfolkId, taleId];

  const reactionQuery = useQuery({
    queryKey,
    queryFn: () => getKinTaleReaction(taleId, kinfolkId),
  });

  const toggle = useMutation({
    mutationFn: () => toggleKinTaleLove(taleId, kinfolkId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<{ loved: boolean; loveCount: number }>(queryKey);
      if (previous) {
        queryClient.setQueryData(queryKey, {
          loved: !previous.loved,
          loveCount: previous.loved ? previous.loveCount - 1 : previous.loveCount + 1,
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (reactionQuery.isLoading || !reactionQuery.data) {
    return null;
  }

  const { loved } = reactionQuery.data;
  return (
    <button
      type="button"
      className="react"
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
      aria-pressed={loved}
    >
      <span className="heart">{loved ? '❤️' : '\u{1F90D}'}</span> {loveLine(reactionQuery.data)}
    </button>
  );
}

function TaleComments(props: { taleId: string; kinfolkId: string | undefined }) {
  const { taleId, kinfolkId } = props;
  const authState = useAuth();
  const currentUid = authState.status === 'signedIn' ? authState.user.uid : null;
  const myInitial = initialOf(authState.status === 'signedIn' ? authState.user.email ?? 'M' : 'M');
  const queryClient = useQueryClient();

  const commentsQuery = useQuery({
    queryKey: ['kinTaleComments', kinfolkId, taleId],
    queryFn: () => getMyKinTaleComments(taleId, kinfolkId),
  });

  const [topInput, setTopInput] = useState('');
  const [topError, setTopError] = useState<string | null>(null);
  const [replyParentId, setReplyParentId] = useState<string | null>(null);
  const [replyInput, setReplyInput] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);

  const post = useMutation({
    mutationFn: (args: { body: string; parentCommentId?: string }) =>
      addKinTaleComment(taleId, args.body, {
        ...(args.parentCommentId !== undefined ? { parentCommentId: args.parentCommentId } : {}),
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kinTaleComments', kinfolkId, taleId] });
    },
  });

  function submitTop() {
    const body = topInput.trim();
    if (!body) {
      setTopError('Comment cannot be empty.');
      return;
    }
    setTopError(null);
    post.mutate(
      { body },
      {
        onSuccess: () => setTopInput(''),
        onError: (err) => setTopError(err instanceof Error ? err.message : 'Could not post your comment. Try again.'),
      },
    );
  }

  function submitReply(parentId: string) {
    const body = replyInput.trim();
    if (!body) {
      setReplyError('Reply cannot be empty.');
      return;
    }
    setReplyError(null);
    post.mutate(
      { body, parentCommentId: parentId },
      {
        onSuccess: () => {
          setReplyInput('');
          setReplyParentId(null);
        },
        onError: (err) => setReplyError(err instanceof Error ? err.message : 'Could not post your reply. Try again.'),
      },
    );
  }

  const comments = commentsQuery.data?.comments ?? [];
  const { topLevel, repliesByParent } = threadComments(comments);

  return (
    <div className="thread">
      <div className="thlabel">Comments {'·'} {comments.length}</div>

      {commentsQuery.isLoading ? (
        <p className="sub">Loading comments…</p>
      ) : commentsQuery.isError ? (
        <p className="sub">Couldn&rsquo;t load comments.</p>
      ) : topLevel.length === 0 ? (
        <p className="empty-cmt">Be the first to say something nice.</p>
      ) : (
        topLevel.map((c, i) => (
          <div key={c.id}>
            <CommentRow
              comment={c}
              avatarIndex={i}
              currentUid={currentUid}
              onReply={() => {
                setReplyParentId(c.id);
                setReplyInput('');
                setReplyError(null);
              }}
            />
            {(repliesByParent[c.id] ?? []).map((r, j) => (
              <CommentRow key={r.id} comment={r} avatarIndex={i + j + 1} currentUid={currentUid} nested />
            ))}
            {replyParentId === c.id && (
              <div className="postbox" style={{ marginLeft: 55, borderTop: 'none', paddingTop: 0 }}>
                <div className="cav">{initialOf('Reply')}</div>
                <div className="field">
                  <textarea
                    value={replyInput}
                    onChange={(e) => setReplyInput(e.target.value)}
                    placeholder="Write a reply…"
                    disabled={post.isPending}
                  />
                  <div className="frow">
                    <button className="btn grad" disabled={post.isPending} onClick={() => submitReply(c.id)}>
                      {post.isPending ? 'Posting…' : 'Reply'}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={post.isPending}
                      onClick={() => {
                        setReplyParentId(null);
                        setReplyInput('');
                        setReplyError(null);
                      }}
                    >
                      Cancel
                    </button>
                    {replyError && <span className="hint err">{replyError}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))
      )}

      <div className="postbox">
        <div className="cav">{myInitial}</div>
        <div className="field">
          <textarea
            value={topInput}
            onChange={(e) => setTopInput(e.target.value)}
            placeholder="Say something nice..."
            disabled={post.isPending}
          />
          <div className="frow">
            <button className="btn grad" disabled={post.isPending} onClick={submitTop}>
              {post.isPending ? 'Posting…' : 'Post Comment'}
            </button>
            {topError ? <span className="hint err">{topError}</span> : <span className="hint ok">Be kind, your Aunties read these.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentRow(props: { comment: KinTaleCommentDto; avatarIndex: number; currentUid: string | null; nested?: boolean; onReply?: () => void }) {
  const { comment, avatarIndex, currentUid, nested = false, onReply } = props;
  const label = commentAuthorLabel(comment, currentUid);
  const badge = commentBadge(comment);

  return (
    <div className={`cmt${nested ? ' nested' : ''}`}>
      <div className={`cav ${commentAvatarVariant(avatarIndex)}`}>{initialOf(label)}</div>
      <div className="cbody">
        <div className="chead">
          <b>{label}</b>
          <span className={`badge ${badge.tone}`}>{badge.label}</span>
          {comment.createdAtMs !== null && <time>{shortTimestamp(comment.createdAtMs)}</time>}
        </div>
        <div className="ctext">{comment.body}</div>
        {onReply && (
          <div className="creply">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onReply();
              }}
            >
              Reply
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
