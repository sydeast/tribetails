import { useCallback, useEffect, useState } from 'react';
import { KINTALES_QUERY, type KinTaleEntry } from '../api/kinTales';
import { KIN_QUERY, type Kin } from '../api/directory';
import {
  kinTaleHousehold,
  kinTaleState,
  kinTaleStateInfo,
  kinTaleWhen,
  sentViaLabel,
} from '../lib/kinTaleFormat';
import {
  getKinTaleComments,
  addKinTaleComment,
  getKinTaleReaction,
  toggleKinTaleLove,
  getMyKinTaleMedia,
  createShareLink,
  type KinTaleComment,
  type KinTaleReaction,
  type KinTaleMediaItem,
} from '../api/kinTaleDetail';
import {
  commentAuthorLabel,
  commentWhen,
  commentMachineTime,
  loveSummaryLabel,
  kinTaleMediaKindOf,
  buildCommentThread,
  shareLinkPreflightError,
  kinfolkPreviewHeadline,
  kinfolkPreviewBody,
} from '../lib/kinTaleDetailFormat';
import { useCollection } from '../lib/firestore';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel, EmptyHint, ServicePill } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import './KinTaleDetail.css';

/**
 * KinTale DETAIL: one report, its comment thread, and its love/react toggle.
 * The surface `KinTales.tsx` deferred (its own doc comment names
 * `KinTaleReportScreen.kt` as "the not-yet-built single-report detail"); this
 * is that screen.
 *
 * WHAT THIS SCREEN RENDERS, matching the Android
 * (`android/.../ui/kintales/KinTaleReportScreen.kt`) and wasm
 * (`web/composeApp/.../screens/kintales/KinTaleReportScreen.kt`) admins field
 * for field: the recap body (title/bodyCopy), the household/kin/session context
 * it belongs to, photo thumbnails (`getMyKinTaleMedia`), status/sent info, the
 * love/react toggle (`getKinTaleReaction`/`toggleKinTaleLove`), the threaded
 * comment thread with a per-comment Reply
 * (`getKinTaleComments`/`addKinTaleComment`), and the "Share with kinfolk"
 * panel: a read-only view-as-kinfolk preview plus a `createShareLink` action
 * (issue #397 items S4, S5 and S6, which closed the last three gaps between
 * this screen and the other two admins).
 *
 * THE PREVIEW IS DELIBERATELY NARROW. It renders the headline, the narrative
 * and the photos, and nothing else, because that is the whole of what a kinfolk
 * can see. Dossiers and 411 notes are ADMIN-ONLY (standing ruling) and never
 * appear here; nor does this screen read them at all. The same three fields are
 * what `share/createShareLink.ts` puts in its own scrubbed share payload, so
 * the preview and the shared page agree by construction.
 *
 * READ PATH: the report itself is NOT re-fetched here. It reuses the same
 * bounded `KINTALES_QUERY` stream `KinTales.tsx`/`KinTaleCompose.tsx` already
 * open (find-by-id over the already-streamed rows), so this screen opens no
 * second listener class for data the app is already watching. Kin names are
 * resolved the same way, off the existing bounded `KIN_QUERY` mirror
 * (`api/directory.ts`), never a fabricated name for an id that doesn't
 * resolve (that id renders in `<code>` instead, an honest "record not found"
 * rather than a guess).
 */

export interface KinTaleDetailProps {
  kinTaleId: string;
  /**
   * Opens the compose/edit surface for this report. Omit to render Edit as a
   * static, non-interactive control (the `Buttons.tsx` `ControlShell`
   * convention: no live no-op).
   */
  onEdit?: (kinTaleId: string) => void;
  onClose: () => void;
}

export function KinTaleDetail({ kinTaleId, onEdit, onClose }: KinTaleDetailProps) {
  const reports = useCollection<KinTaleEntry>(KINTALES_QUERY);
  const kin = useCollection<Kin>(KIN_QUERY);

  return (
    <div className="screen kintale-detail">
      <DenScreenHeading
        // The last step stays "KinTale detail" rather than the report's title:
        // the report is resolved inside the AsyncRegion below, so a title-shaped
        // crumb here would have to render blank, or a placeholder, for as long
        // as the read takes. `onClose` already drops `?kinTaleId=` on the way
        // out, which a route link to /kintales would not.
        crumbs={[{ label: 'KinTales', onSelect: onClose }, { label: 'KinTale detail' }]}
        title="KinTale"
        accentTail="detail."
        subtitle="The recap, the comment thread, and the reaction, all in one place."
        trailing={<GhostButton label="Close" onClick={onClose} />}
      />
      <AsyncRegion state={reports} what="the KinTale" isEmpty={() => false} empty={null}>
        {(data) => {
          const entry = data.find((r) => r._id === kinTaleId);
          if (!entry) {
            return <EmptyHint>No KinTale found with id &ldquo;{kinTaleId}&rdquo;.</EmptyHint>;
          }
          return <KinTaleDetailBody entry={entry} kin={kin} {...(onEdit ? { onEdit } : {})} />;
        }}
      </AsyncRegion>
    </div>
  );
}

// ── body ─────────────────────────────────────────────────────────────────

interface KinTaleDetailBodyProps {
  entry: KinTaleEntry;
  kin: Async<Kin[]>;
  onEdit?: (kinTaleId: string) => void;
}

type DetailBanner = { tone: 'error' | 'success'; text: string };

function KinTaleDetailBody({ entry, kin, onEdit }: KinTaleDetailBodyProps) {
  // Every read off `entry` is defaulted. KinTaleEntry is a CAST over raw
  // Firestore data, not a validation of it: `title` is absent on 89 of the 92
  // live kin_care_reports, and reading one blind throws through React's error
  // boundary and blanks the whole detail screen over a single legacy row
  // (2026-07-20). Same treatment KinTales.tsx already applies to its own rows.
  const state = kinTaleState(entry.status ?? '');
  const info = kinTaleStateInfo(state);
  const household = kinTaleHousehold(entry.kinfolkName ?? '');
  // kinTaleWhen takes all four date fields as required strings; hand it a
  // fully-defaulted view rather than the raw entry.
  const when = kinTaleWhen({
    visitDate: entry.visitDate ?? '',
    arrivedAt: entry.arrivedAt ?? '',
    sentAt: entry.sentAt ?? '',
    createdAt: entry.createdAt ?? '',
  });
  const serviceType = entry.serviceType ?? '';
  const authorDisplayName = entry.authorDisplayName ?? '';
  const title = entry.title ?? '';
  const bodyCopy = entry.bodyCopy ?? '';
  const kinIds = entry.kinIds ?? [];
  const sentVia = entry.sentVia ?? '';
  // Only a dispatched row carries a real channel; a draft's blank sentVia would
  // otherwise read as sentViaLabel's misleading "imported" default.
  const channel = sentVia.trim() !== '' ? sentViaLabel(sentVia) : null;

  // ── comments ─────────────────────────────────────────────────────────
  const [comments, setComments] = useState<Async<KinTaleComment[]>>({ status: 'loading' });

  // Hoisted so a failed load AND a successful post can both re-run it, same
  // shape as Inbox.tsx's own load().
  const loadComments = useCallback(() => {
    let live = true;
    setComments({ status: 'loading' });
    getKinTaleComments(entry._id)
      .then((data) => live && setComments({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setComments({
            status: 'error',
            message: `getKinTaleComments failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: loadComments,
          }),
      );
    return () => {
      live = false;
    };
  }, [entry._id]);
  useEffect(() => loadComments(), [loadComments]);

  const [commentBody, setCommentBody] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [commentBanner, setCommentBanner] = useState<DetailBanner | null>(null);
  // Id of the comment this draft answers, or null for a root-level comment.
  // Same single piece of state Android (`replyTargetId`) and the wasm admin
  // (`KinTaleReportViewModel.replyTargetId`) each carry: one compose box that
  // changes what it is answering, not a second inline form per row.
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);

  async function handlePostComment() {
    const body = commentBody.trim();
    if (body === '' || isPosting) return;
    setIsPosting(true);
    setCommentBanner(null);
    try {
      await addKinTaleComment({
        taleId: entry._id,
        body,
        ...(replyTargetId !== null ? { parentCommentId: replyTargetId } : {}),
      });
      setCommentBody('');
      setReplyTargetId(null);
      setCommentBanner({ tone: 'success', text: replyTargetId !== null ? 'Reply posted.' : 'Comment posted.' });
      // Re-reads the thread for the authoritative new row (this callable's
      // own response carries only the new commentId, never a fabricated
      // local comment, see api/kinTaleDetail.ts#addKinTaleComment).
      loadComments();
    } catch (err) {
      setCommentBanner({
        tone: 'error',
        text: `Couldn't post comment: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    } finally {
      setIsPosting(false);
    }
  }

  // ── reaction ─────────────────────────────────────────────────────────
  const [reaction, setReaction] = useState<Async<KinTaleReaction>>({ status: 'loading' });

  const loadReaction = useCallback(() => {
    let live = true;
    setReaction({ status: 'loading' });
    getKinTaleReaction(entry._id)
      .then((data) => live && setReaction({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setReaction({
            status: 'error',
            message: `getKinTaleReaction failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: loadReaction,
          }),
      );
    return () => {
      live = false;
    };
  }, [entry._id]);
  useEffect(() => loadReaction(), [loadReaction]);

  const [isToggling, setIsToggling] = useState(false);
  const [reactionError, setReactionError] = useState<string | null>(null);

  async function handleToggleLove() {
    if (isToggling) return;
    setIsToggling(true);
    setReactionError(null);
    try {
      // The authoritative post-toggle state, computed server-side; never
      // derived locally (api/kinTaleDetail.ts#toggleKinTaleLove's doc comment).
      const next = await toggleKinTaleLove(entry._id);
      setReaction({ status: 'ready', data: next });
    } catch (err) {
      setReactionError(`Couldn't update your reaction: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setIsToggling(false);
    }
  }

  // ── media ────────────────────────────────────────────────────────────
  const [media, setMedia] = useState<Async<KinTaleMediaItem[]>>({ status: 'loading' });
  const mediaCount = (entry.mediaFileIds ?? []).length;
  const kinfolkId = entry.kinfolkId ?? '';

  const loadMedia = useCallback(() => {
    // A report with no mediaFileIds genuinely has no photos, a known fact
    // straight off the already-streamed report doc, so this skips the network
    // round-trip entirely rather than calling out for an empty result.
    if (mediaCount === 0) {
      setMedia({ status: 'ready', data: [] });
      return undefined;
    }
    let live = true;
    setMedia({ status: 'loading' });
    getMyKinTaleMedia(entry._id, kinfolkId)
      .then((data) => live && setMedia({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setMedia({
            status: 'error',
            message: `getMyKinTaleMedia failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: loadMedia,
          }),
      );
    return () => {
      live = false;
    };
  }, [entry._id, kinfolkId, mediaCount]);
  useEffect(() => loadMedia(), [loadMedia]);

  // ── share with kinfolk: preview + share link ─────────────────────────
  const [viewAsKinfolk, setViewAsKinfolk] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  async function handleShare() {
    if (isSharing) return;
    // The same three preflight refusals Android and the wasm admin each make
    // before calling out: a draft, an unsaved report, or a report with no
    // household to route the link to. Each maps to a real server-side refusal;
    // catching them here means a sentence instead of a callable error code.
    const problem = shareLinkPreflightError({ id: entry._id, status: entry.status ?? '', kinfolkId });
    if (problem !== null) {
      setShareError(problem);
      setShareUrl(null);
      return;
    }
    setIsSharing(true);
    setShareError(null);
    setShareUrl(null);
    setShareCopied(false);
    try {
      // includePhotos: the wasm admin and the kinfolk portal's own share dialog
      // both send true. Photos are the point of sharing a recap, and the server
      // resolves them into the scrubbed payload itself.
      const result = await createShareLink(entry._id, kinfolkId, true);
      setShareUrl(result.shareUrl);
    } catch (err) {
      setShareError(`Couldn't create a share link: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setIsSharing(false);
    }
  }

  // Who the open reply answers. Resolved off the loaded thread so the compose
  // box names a real author; an id that no longer resolves (the thread reloaded
  // without it) degrades to the neutral line rather than naming the wrong
  // person. Clearing the target is always one click away either way.
  const replyTarget =
    replyTargetId !== null && comments.status === 'ready'
      ? comments.data.find((c) => c.id === replyTargetId)
      : undefined;
  const replyTargetLine =
    replyTarget !== undefined ? `Replying to ${commentAuthorLabel(replyTarget)}.` : 'Replying to a comment.';

  async function handleCopyShareUrl() {
    if (shareUrl === null) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
    } catch {
      // Clipboard access can be denied (permissions, an insecure context). The
      // url stays on screen and selectable, so this is a lost convenience, not
      // a failed action worth its own error banner. Same call the kinfolk
      // portal's ShareKinTaleDialog makes.
      setShareCopied(false);
    }
  }

  return (
    <>
      <DenPanel
        title="The tale"
        subtitle={when}
        trailing={onEdit ? <GhostButton label="Edit" onClick={() => onEdit(entry._id)} /> : undefined}
      >
        <div className="kintale-detail__tale-head">
          <span className="kintale-detail__household">{household}</span>
          {serviceType.trim() !== '' ? <ServicePill serviceType={serviceType} /> : null}
          <span className={`kintale-detail__chip kintale-detail__chip--${info.cssClass}`}>{info.chipLabel}</span>
        </div>
        {(authorDisplayName.trim() !== '' || channel) && (
          <p className="kintale-detail__meta-line">
            {authorDisplayName.trim() !== '' ? `by ${authorDisplayName}` : null}
            {channel ? ` · sent via ${channel}` : null}
          </p>
        )}
        {title.trim() !== '' && <h2 className="kintale-detail__title">{title}</h2>}
        <p className="kintale-detail__body">{bodyCopy.trim() !== '' ? bodyCopy : '(empty body)'}</p>
      </DenPanel>

      <DenPanel
        title="Share with kinfolk"
        subtitle="Preview how the kinfolk reads this update, or create a link to share it."
      >
        <div className="kintale-detail__share-actions">
          <GhostButton
            label={viewAsKinfolk ? 'Hide kinfolk view' : 'View as kinfolk'}
            onClick={() => setViewAsKinfolk((on) => !on)}
          />
          <PrimaryButton
            label={isSharing ? 'Creating…' : 'Share link'}
            onClick={() => void handleShare()}
            disabled={isSharing}
            busy={isSharing}
          />
        </div>

        {shareError && <Banner tone="error">{shareError}</Banner>}

        {shareUrl !== null && (
          <div className="kintale-detail__share-result">
            <span className="kintale-detail__label">Share link</span>
            {/* Readonly rather than plain text: the url stays selectable and
                copyable by hand when the clipboard API is unavailable. */}
            <input
              className="kintale-detail__share-url"
              type="text"
              readOnly
              value={shareUrl}
              aria-label="Share link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="kintale-detail__share-copy">
              <GhostButton label={shareCopied ? 'Copied' : 'Copy link'} onClick={() => void handleCopyShareUrl()} />
            </div>
          </div>
        )}

        {viewAsKinfolk && (
          // The kinfolk-facing read of this recap: headline, narrative, photos.
          // No Edit, no Send, no reaction control, and no admin-only record of
          // any kind. Dossiers and 411 notes are admin-only, and are neither
          // read nor rendered anywhere on this screen.
          <section className="kintale-detail__preview" aria-label="Kinfolk view">
            <p className="kintale-detail__preview-eyebrow">KINFOLK VIEW</p>
            <h3 className="kintale-detail__preview-headline">
              {kinfolkPreviewHeadline({ title, bodyCopy, authorDisplayName, kinfolkName: entry.kinfolkName ?? '' })}
            </h3>
            <p className="kintale-detail__preview-body">{kinfolkPreviewBody({ bodyCopy })}</p>
            {media.status === 'ready' && media.data.length > 0 && (
              <ul className="kintale-detail__media-grid">
                {media.data.map((item) => (
                  <li key={item.id} className="kintale-detail__media-tile">
                    {kinTaleMediaKindOf(item.contentType) === 'image' ? (
                      <img src={item.url} alt="KinTale attachment" loading="lazy" className="kintale-detail__media-img" />
                    ) : (
                      <a href={item.url} target="_blank" rel="noreferrer" className="kintale-detail__media-link">
                        View attachment
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </DenPanel>

      <DenPanel title="Who this covers" subtitle="Household, session, and kin this recap belongs to.">
        <dl className="kintale-detail__who">
          <div className="kintale-detail__who-row">
            <dt>Household</dt>
            <dd>{household}</dd>
          </div>
          <div className="kintale-detail__who-row">
            <dt>Session</dt>
            <dd>
              <code>{entry.sessionId}</code>
            </dd>
          </div>
        </dl>
        {kinIds.length > 0 ? (
          <AsyncRegion
            state={kin}
            what="kin"
            isEmpty={() => false}
            empty={null}
            loading={<p className="kintale-detail__hint">Loading kin&hellip;</p>}
          >
            {(kinData) => (
              <ul className="kintale-detail__kin-list">
                {kinIds.map((kinId) => {
                  const found = kinData.find((k) => k._id === kinId);
                  // `Kin` is the same kind of cast over raw document data as
                  // KinTaleEntry: a resolved kin doc can still be missing
                  // name/species, which must degrade to the existing
                  // 'Unnamed kin' / no-species rendering, never throw.
                  const foundName = found?.name ?? '';
                  const foundSpecies = found?.species ?? '';
                  return (
                    <li key={kinId} className="kintale-detail__kin-chip">
                      {found ? (
                        <>
                          {foundName.trim() !== '' ? foundName : 'Unnamed kin'}
                          {foundSpecies.trim() !== '' ? ` (${foundSpecies})` : ''}
                        </>
                      ) : (
                        <code>{kinId}</code>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </AsyncRegion>
        ) : (
          <EmptyHint>No kin recorded on this recap.</EmptyHint>
        )}
      </DenPanel>

      {mediaCount > 0 && (
        <DenPanel title="Photos" subtitle={`${mediaCount} attached.`}>
          <AsyncRegion
            state={media}
            what="photos"
            isEmpty={(data) => data.length === 0}
            empty={<EmptyHint>No photos could be resolved for this recap.</EmptyHint>}
          >
            {(data) => (
              <ul className="kintale-detail__media-grid">
                {data.map((item) => (
                  <li key={item.id} className="kintale-detail__media-tile">
                    {kinTaleMediaKindOf(item.contentType) === 'image' ? (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        <img
                          src={item.url}
                          alt="KinTale attachment"
                          loading="lazy"
                          className="kintale-detail__media-img"
                        />
                      </a>
                    ) : (
                      <a href={item.url} target="_blank" rel="noreferrer" className="kintale-detail__media-link">
                        View attachment
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </AsyncRegion>
        </DenPanel>
      )}

      <DenPanel title="Reaction">
        <AsyncRegion state={reaction} what="the reaction" isEmpty={() => false} empty={null}>
          {(data) => (
            <div className="kintale-detail__reaction-row">
              <PrimaryButton
                label={data.loved ? 'Loved' : 'Love this'}
                onClick={() => void handleToggleLove()}
                disabled={isToggling}
                busy={isToggling}
              />
              <span className="kintale-detail__reaction-summary">{loveSummaryLabel(data.loved, data.loveCount)}</span>
            </div>
          )}
        </AsyncRegion>
        {reactionError && <Banner tone="error">{reactionError}</Banner>}
      </DenPanel>

      <DenPanel title="Comments">
        <AsyncRegion
          state={comments}
          what="comments"
          isEmpty={(data) => data.length === 0}
          empty={<EmptyHint>No comments yet.</EmptyHint>}
        >
          {(data) => (
            <ul className="kintale-detail__comment-list">
              {/* One level of nesting, the depth both other admins render and
                  the only depth their Reply affordance can create. */}
              {buildCommentThread(data).map(({ comment: c, isReply }) => (
                <li
                  key={c.id}
                  className={`kintale-detail__comment-row${isReply ? ' kintale-detail__comment-row--reply' : ''}`}
                  data-reply={isReply ? 'true' : 'false'}
                  data-reply-target={replyTargetId === c.id ? 'true' : 'false'}
                >
                  <span className="kintale-detail__comment-head">
                    <span className="kintale-detail__comment-author">{commentAuthorLabel(c)}</span>
                    <time className="kintale-detail__comment-when" dateTime={commentMachineTime(c.createdAtMs)}>
                      {commentWhen(c.createdAtMs)}
                    </time>
                    <span className="kintale-detail__comment-reply">
                      <GhostButton
                        label={replyTargetId === c.id ? 'Replying' : 'Reply'}
                        onClick={() => setReplyTargetId(c.id)}
                        disabled={isPosting}
                      />
                    </span>
                  </span>
                  <p className="kintale-detail__comment-body">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
        </AsyncRegion>

        <div className="kintale-detail__add-comment" data-replying-to={replyTargetId ?? ''}>
          {replyTargetId !== null && (
            <div className="kintale-detail__reply-target">
              <span>{replyTargetLine}</span>
              <GhostButton label="Cancel reply" onClick={() => setReplyTargetId(null)} disabled={isPosting} />
            </div>
          )}
          <label className="kintale-detail__field">
            <span className="kintale-detail__label">{replyTargetId !== null ? 'Your reply' : 'Add a comment'}</span>
            <textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Say something back…"
              className="kintale-detail__textarea"
              rows={3}
              disabled={isPosting}
            />
          </label>
          {commentBanner && <Banner tone={commentBanner.tone}>{commentBanner.text}</Banner>}
          <div className="kintale-detail__add-comment-actions">
            <PrimaryButton
              label={isPosting ? 'Posting…' : replyTargetId !== null ? 'Post reply' : 'Post comment'}
              onClick={() => void handlePostComment()}
              disabled={commentBody.trim() === '' || isPosting}
              busy={isPosting}
            />
          </div>
        </div>
      </DenPanel>
    </>
  );
}
