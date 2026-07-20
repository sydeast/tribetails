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
 * IN SCOPE, per the wasm `KinTaleReportScreen.kt` reference: the recap body
 * (title/bodyCopy), the household/kin/session context it belongs to, photo
 * thumbnails (`getMyKinTaleMedia`), status/sent info, the comment thread
 * (`getKinTaleComments`/`addKinTaleComment`), and the love/react toggle
 * (`getKinTaleReaction`/`toggleKinTaleLove`).
 *
 * OUT OF SCOPE, flagged rather than silently dropped:
 *  - The share-link affordance (`KinTaleReportScreen.kt`'s "copy share link").
 *    No such callable exists in MyTribe/functions/src today; building one is a
 *    separate backend + wiring slice, not a UI-only gap.
 *  - "View as kinfolk" preview mode. A separate, not-yet-built surface.
 *  - Per-comment reply-to threading UI. `addKinTaleComment` accepts a
 *    `parentCommentId` end-to-end (see `api/kinTaleDetail.ts`), but this
 *    screen's own add-comment form only composes ROOT-level comments; a
 *    "Reply" affordance on an individual comment row is a separate surface.
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
        kicker="The Den · KinTales"
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
  const state = kinTaleState(entry.status);
  const info = kinTaleStateInfo(state);
  const household = kinTaleHousehold(entry.kinfolkName);
  const when = kinTaleWhen(entry);
  const channel = entry.sentVia.trim() !== '' ? sentViaLabel(entry.sentVia) : null;

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

  async function handlePostComment() {
    const body = commentBody.trim();
    if (body === '' || isPosting) return;
    setIsPosting(true);
    setCommentBanner(null);
    try {
      await addKinTaleComment({ taleId: entry._id, body });
      setCommentBody('');
      setCommentBanner({ tone: 'success', text: 'Comment posted.' });
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
  const mediaCount = entry.mediaFileIds.length;

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
    getMyKinTaleMedia(entry._id, entry.kinfolkId)
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
  }, [entry._id, entry.kinfolkId, mediaCount]);
  useEffect(() => loadMedia(), [loadMedia]);

  return (
    <>
      <DenPanel
        title="The tale"
        subtitle={when}
        trailing={onEdit ? <GhostButton label="Edit" onClick={() => onEdit(entry._id)} /> : undefined}
      >
        <div className="kintale-detail__tale-head">
          <span className="kintale-detail__household">{household}</span>
          {entry.serviceType.trim() !== '' ? <ServicePill serviceType={entry.serviceType} /> : null}
          <span className={`kintale-detail__chip kintale-detail__chip--${info.cssClass}`}>{info.chipLabel}</span>
        </div>
        {(entry.authorDisplayName.trim() !== '' || channel) && (
          <p className="kintale-detail__meta-line">
            {entry.authorDisplayName.trim() !== '' ? `by ${entry.authorDisplayName}` : null}
            {channel ? ` · sent via ${channel}` : null}
          </p>
        )}
        {entry.title.trim() !== '' && <h2 className="kintale-detail__title">{entry.title}</h2>}
        <p className="kintale-detail__body">{entry.bodyCopy.trim() !== '' ? entry.bodyCopy : '(empty body)'}</p>
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
        {entry.kinIds.length > 0 ? (
          <AsyncRegion
            state={kin}
            what="kin"
            isEmpty={() => false}
            empty={null}
            loading={<p className="kintale-detail__hint">Loading kin&hellip;</p>}
          >
            {(kinData) => (
              <ul className="kintale-detail__kin-list">
                {entry.kinIds.map((kinId) => {
                  const found = kinData.find((k) => k._id === kinId);
                  return (
                    <li key={kinId} className="kintale-detail__kin-chip">
                      {found ? (
                        <>
                          {found.name.trim() !== '' ? found.name : 'Unnamed kin'}
                          {found.species.trim() !== '' ? ` (${found.species})` : ''}
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
              {data.map((c) => (
                <li key={c.id} className="kintale-detail__comment-row">
                  <span className="kintale-detail__comment-head">
                    <span className="kintale-detail__comment-author">{commentAuthorLabel(c)}</span>
                    <time className="kintale-detail__comment-when" dateTime={commentMachineTime(c.createdAtMs)}>
                      {commentWhen(c.createdAtMs)}
                    </time>
                  </span>
                  <p className="kintale-detail__comment-body">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
        </AsyncRegion>

        <div className="kintale-detail__add-comment">
          <label className="kintale-detail__field">
            <span className="kintale-detail__label">Add a comment</span>
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
              label={isPosting ? 'Posting…' : 'Post comment'}
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
