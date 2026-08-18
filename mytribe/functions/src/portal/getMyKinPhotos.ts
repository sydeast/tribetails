import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { mediaDocToThumb } from '../lib/kinTaleThumbs';
import { isPortalHiddenKinStatus } from '../lib/kinStatus';
import { validateResponse } from '../lib/callableResponse';

/**
 * Every photo a household's Kin appear in, in one place (issue #399, item 1).
 *
 * The portal's Tribe hub has had a "Gallery" card with an inert "All photos"
 * label since it was built, because there was no portal media callable at all:
 * `getMyKinTaleMedia` resolves the media of ONE tale the caller already knows
 * the id of, and nothing could answer "show me all of it".
 *
 * WHERE A HOUSEHOLD'S PHOTOS ACTUALLY LIVE, which is the thing that shapes
 * this response. There are exactly two places, and they are not the same kind
 * of thing:
 *
 *  1. KinTale media. `kin_care_reports/{taleId}.mediaFileIds` points at
 *     `media_files/{id}`, whose `storageUrl` is a Cloudinary CDN URL. This is
 *     the real archive: every photo an Auntie has ever sent the household.
 *  2. Kin portraits. `families/{kinfolkId}/kin/{kinId}.photoUrl`, ONE per Kin,
 *     overwritten in place on every upload (`confirmKinPhotoUpload`), with no
 *     history kept anywhere.
 *
 * `media_files` carries no reliable per-Kin key — `kinId` appears only on
 * legacy and sandbox documents, `taggedKinIds` is written by one admin surface
 * only, and `entityType` casing is inconsistent in production. So this does
 * NOT offer a per-Kin filter it could not honour; it returns the household's
 * photos, which is what the Gallery card asks for.
 *
 * PAGINATION IS BY TALE, not by photo, and the response says so. A tale can
 * carry twenty photos or none, so a photo-count page size would either split a
 * visit across two pages or need a second cursor inside one. `nextBefore` is
 * the `sentAtMs` of the last tale read, the same opaque cursor
 * `getMyKinTales` already uses, so the two paginate identically.
 *
 * Portraits ride along on the FIRST page only. They are a fixed handful, they
 * have no timestamp to sort into the archive by, and repeating them under
 * every scroll would show the same faces over and over.
 */
export const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  /** Tales to read per page. Photos returned is whatever those tales carry. */
  limit: z.number().int().min(1).max(50).optional(),
  /** `nextBefore` from the previous page: the last tale's `sentAtMs`. */
  before: z.number().int().positive().optional(),
});

export const PhotoDtoSchema = z
  .object({
    /** The `media_files` document id. Stable, and unique within a page. */
    id: z.string().min(1),
    url: z.string().min(1),
    /** MIME type of the file, e.g. 'image/jpeg'. Null when the record never carried one. */
    contentType: z.string().nullable(),
    /** The KinTale this came from, so a tile can link back to the story. */
    taleId: z.string().min(1),
    taleTitle: z.string(),
    /** When the tale was sent. Null when the tale carries no readable sent time. */
    takenAtMs: z.number().int().nullable(),
  })
  .strict();

export const PortraitDtoSchema = z
  .object({
    kinId: z.string().min(1),
    kinName: z.string(),
    url: z.string().min(1),
  })
  .strict();

export const Result = z
  .object({
    photos: z.array(PhotoDtoSchema),
    /** Current Kin portraits. Populated on the first page only; empty after that. */
    portraits: z.array(PortraitDtoSchema),
    hasMore: z.boolean(),
    /** Cursor for the next page, or null at the end of the archive. */
    nextBefore: z.number().int().nullable(),
  })
  .strict();

const DEFAULT_LIMIT = 12;

export async function getMyKinPhotosHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getMyKinPhotos validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'getMyKinPhotos',
  );
  const firestore = db();
  const limit = args.limit ?? DEFAULT_LIMIT;

  // Same query `getMyKinTales` runs, including `sentAt > ''` to keep DRAFTs
  // out: a photo attached to a tale the Auntie has not sent yet is not the
  // household's to see.
  let q = firestore
    .collection('kin_care_reports')
    .where('kinfolkId', '==', kinfolkId)
    .where('sentAt', '>', '')
    .orderBy('sentAt', 'desc')
    .limit(limit + 1);
  if (args.before !== undefined) {
    q = q.startAfter(new Date(args.before).toISOString());
  }
  const snap = await q.get();
  const hasMore = snap.docs.length > limit;
  const pageDocs = snap.docs.slice(0, limit);

  // Every media id on the page, resolved in ONE batched read rather than one
  // per tale. `getAll` refuses an empty argument list, so the empty page
  // short-circuits.
  const perTale = pageDocs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const sentAtRaw = data['sentAt'];
    const sentAtMs =
      typeof sentAtRaw === 'string' && sentAtRaw.length > 0 && !isNaN(new Date(sentAtRaw).getTime())
        ? new Date(sentAtRaw).getTime()
        : null;
    return {
      taleId: d.id,
      taleTitle: typeof data['title'] === 'string' ? (data['title'] as string) : '',
      sentAtMs,
      mediaIds: Array.isArray(data['mediaFileIds']) ? (data['mediaFileIds'] as string[]) : [],
    };
  });

  const allIds = [...new Set(perTale.flatMap((t) => t.mediaIds))];
  const byId = new Map<string, Record<string, unknown>>();
  if (allIds.length > 0) {
    const snaps = await firestore.getAll(...allIds.map((id) => firestore.doc(`media_files/${id}`)));
    snaps.forEach((s) => {
      if (s.exists) byId.set(s.id, s.data() as Record<string, unknown>);
    });
  }

  const photos: z.infer<typeof PhotoDtoSchema>[] = [];
  const seen = new Set<string>();
  for (const tale of perTale) {
    for (const mediaId of tale.mediaIds) {
      // The same media file can be attached to two tales. A gallery that shows
      // it twice reads as a duplicate upload, so the first (most recent) wins.
      if (seen.has(mediaId)) continue;
      const thumb = mediaDocToThumb(mediaId, byId.get(mediaId));
      // A media doc that is missing or carries no storageUrl is simply absent,
      // never a placeholder tile. Same rule `computeThumbs` follows.
      if (!thumb) continue;
      seen.add(mediaId);
      photos.push({
        id: thumb.id,
        url: thumb.url,
        contentType: thumb.contentType,
        taleId: tale.taleId,
        taleTitle: tale.taleTitle,
        takenAtMs: tale.sentAtMs,
      });
    }
  }

  const portraits = args.before === undefined ? await loadPortraits(firestore, kinfolkId) : [];

  const lastTale = perTale[perTale.length - 1];
  const nextBefore = hasMore && lastTale?.sentAtMs != null ? lastTale.sentAtMs : null;

  logEvent({
    severity: 'info',
    function: 'getMyKinPhotos',
    event: 'portal.gallery.read',
    uid,
    extra: { kinfolkId, tales: perTale.length, photos: photos.length, portraits: portraits.length },
  });

  return validateResponse('getMyKinPhotos', Result, {
    photos,
    portraits,
    hasMore,
    nextBefore,
  });
}

/** Current Kin portraits, one per active Kin, in roster order. */
async function loadPortraits(
  firestore: FirebaseFirestore.Firestore,
  kinfolkId: string,
): Promise<z.infer<typeof PortraitDtoSchema>[]> {
  const snap = await firestore.collection(`families/${kinfolkId}/kin`).get();
  const out: z.infer<typeof PortraitDtoSchema>[] = [];
  snap.docs.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    // The same roster filter `getMyKin` applies, through the same helper, so a
    // Kin the household no longer sees on its roster does not reappear here.
    if (isPortalHiddenKinStatus(data['status'])) return;
    const url = typeof data['photoUrl'] === 'string' ? (data['photoUrl'] as string) : '';
    if (!url) return;
    out.push({
      kinId: d.id,
      kinName: typeof data['name'] === 'string' ? (data['name'] as string) : '',
      url,
    });
  });
  return out;
}

export const getMyKinPhotos = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyKinPhotos', getMyKinPhotosHandler),
);
