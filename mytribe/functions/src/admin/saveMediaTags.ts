import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Issue #447: the server-bound writer for `media_files/{id}.taggedKinIds`, the
 * "which Kin are in this photo" list the Gallery's tag dialog edits.
 *
 * THIS FIELD HAD NO SERVER WRITER AT ALL until this callable. Android wrote it
 * straight to Firestore (`AuntieRepository.updateMediaTags`, a bare
 * `.update("taggedKinIds", ids)`), and so did the superseded Compose web admin
 * (`platformUpdateMediaTags`). Two clients, two copies of the rules that were
 * never written down, and nothing validating that a tagged kin existed or even
 * belonged to the household whose photo it is: a typo'd id, or a kin from a
 * completely different family, was a legal write. `firestore.rules` now REFUSES
 * any client update that touches `taggedKinIds`, so this callable is the only
 * way in and the two can no longer disagree.
 *
 * WHAT AUTHORISATION MEANS HERE, in two layers:
 *   1. WHO   `wrapAdminCallable` — the `admin` custom claim, the same gate
 *            every other admin callable uses. Tagging is an admin action:
 *            kinfolk never reach this (their portal reads photos through
 *            `portal/getMyKinPhotos.ts`, which deliberately offers no per-Kin
 *            filter precisely because this field was unreliable).
 *   2. WHAT  the media doc's own `kinfolkId` bounds which Kin may be tagged in
 *            it, porting Android's `taggableKin` (domain/GalleryFilters.kt)
 *            from a client-side picker filter into an enforced rule. Media
 *            attached to a household accepts only that household's Kin; media
 *            with no household (company/unattached uploads, operator ruling
 *            2026-07-31) accepts any Kin on file. Either way every id must
 *            resolve to a real `kin/{id}` document.
 *
 * The write is a `merge` of the ONE field. It never rebuilds the document:
 * `media_files` docs carry ~20 fields written by three different upload
 * pipelines, and a rebuilt doc would silently drop whichever of them this
 * callable does not know about.
 */

/**
 * A generous ceiling, not a design limit: a photo of a whole household's pets
 * is a handful of Kin, and the biggest roster this admin will read is capped
 * at 500. It exists so a malformed client cannot post an unbounded array that
 * turns into 10,000 document reads below.
 */
export const MAX_TAGGED_KIN = 50;

export const Args = z.object({
  mediaFileId: z.string().min(1).max(120),
  /** The COMPLETE tag list after the edit, not a delta. An empty array clears every tag. */
  taggedKinIds: z.array(z.string().min(1).max(120)).max(MAX_TAGGED_KIN),
});

export interface SaveMediaTagsResult {
  ok: true;
  mediaFileId: string;
  /** The list as stored: de-duplicated, in first-seen order. */
  taggedKinIds: string[];
}

/** De-duplicates while keeping first-seen order, so the stored list is stable across a re-save. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function saveMediaTagsHandler(
  req: CallableRequest<unknown>,
): Promise<SaveMediaTagsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'saveMediaTags validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const taggedKinIds = dedupe(args.taggedKinIds);

  const mediaRef = db().doc(`media_files/${args.mediaFileId}`);
  const mediaSnap = await mediaRef.get();
  if (!mediaSnap.exists) {
    throw new HttpsError(
      'not-found',
      `Media file '${args.mediaFileId}' no longer exists. Refresh the gallery and try again.`,
    );
  }
  const media = mediaSnap.data() as
    | { kinfolkId?: string; taggedKinIds?: unknown }
    | undefined;
  const mediaKinfolkId = (media?.kinfolkId ?? '').trim();

  // Every id must resolve, and (when the photo belongs to a household) must
  // belong to THAT household. One getAll, not N gets, so a 50-tag save is one
  // round trip.
  if (taggedKinIds.length > 0) {
    const snaps = await db().getAll(...taggedKinIds.map((id) => db().doc(`kin/${id}`)));

    const unknown = taggedKinIds.filter((_, i) => !snaps[i]?.exists);
    if (unknown.length > 0) {
      throw new HttpsError(
        'not-found',
        `No kin on file for ${unknown.length === 1 ? 'id' : 'ids'} ${unknown.join(', ')}. ` +
          `Refresh the household roster and try again.`,
      );
    }

    if (mediaKinfolkId !== '') {
      const foreign = taggedKinIds.filter((_, i) => {
        const kin = snaps[i]?.data() as { kinfolkId?: string } | undefined;
        return (kin?.kinfolkId ?? '').trim() !== mediaKinfolkId;
      });
      if (foreign.length > 0) {
        throw new HttpsError(
          'failed-precondition',
          `${foreign.join(', ')} ${foreign.length === 1 ? 'is not a kin' : 'are not kin'} of ` +
            `household '${mediaKinfolkId}', which this photo belongs to. Only that household's kin can be tagged in it.`,
        );
      }
    }
  }

  const previous = Array.isArray(media?.taggedKinIds)
    ? (media.taggedKinIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  // Field-scoped merge: the ONE key this callable owns. Never a rebuilt doc.
  await mediaRef.set({ taggedKinIds }, { merge: true });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.MEDIA_TAGS_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      mediaFileId: args.mediaFileId,
      kinfolkId: mediaKinfolkId,
      taggedKinIds,
      previousTaggedKinIds: previous,
    },
  });

  logEvent({
    severity: 'info',
    function: 'saveMediaTags',
    event: 'admin.media.tagsSaved',
    uid,
    extra: { mediaFileId: args.mediaFileId, tagCount: taggedKinIds.length },
  });

  return { ok: true, mediaFileId: args.mediaFileId, taggedKinIds };
}

export const saveMediaTags = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveMediaTags', saveMediaTagsHandler),
);
