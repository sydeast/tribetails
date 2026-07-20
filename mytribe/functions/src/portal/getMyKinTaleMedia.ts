import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  kinfolkId: z.string().optional(),
  taleId: z.string().min(1),
});

interface MediaItem { id: string; url: string; contentType: string | null; }
interface GetMediaResult { taleId: string; media: MediaItem[]; }

/**
 * Returns Cloudinary CDN URLs for a KinTale's mediaFileIds.
 * Source: kin_care_reports/{taleId}.mediaFileIds → media_files/{id}.storageUrl
 * Cloudinary CDN, no signing required.
 */
export async function getMyKinTaleMediaHandler(
  req: CallableRequest<unknown>,
): Promise<GetMediaResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'getMyKinTaleMedia');

  const taleSnap = await db().doc(`kin_care_reports/${args.taleId}`).get();
  if (!taleSnap.exists) throw new HttpsError('not-found', 'KinTale not found.');
  const taleData = taleSnap.data() as Record<string, unknown>;
  if (taleData['kinfolkId'] !== kinfolkId) throw new HttpsError('not-found', 'KinTale not found.');

  const mediaFileIds = Array.isArray(taleData['mediaFileIds'])
    ? (taleData['mediaFileIds'] as string[])
    : [];
  if (mediaFileIds.length === 0) return { taleId: args.taleId, media: [] };

  const mediaItems: MediaItem[] = await Promise.all(
    mediaFileIds.map(async (id) => {
      const snap = await db().doc(`media_files/${id}`).get();
      if (!snap.exists) return null;
      const d = snap.data() as Record<string, unknown>;
      const url = typeof d['storageUrl'] === 'string' ? (d['storageUrl'] as string) : '';
      if (!url) return null;
      return {
        id,
        url,
        contentType: typeof d['mimeType'] === 'string' ? (d['mimeType'] as string) : null,
      };
    }),
  ).then((items) => items.filter((m): m is MediaItem => m !== null));

  logEvent({
    severity: 'info',
    function: 'getMyKinTaleMedia',
    event: 'portal.kintale.media.resolved',
    uid,
    extra: { kinfolkId, taleId: args.taleId, count: mediaItems.length },
  });

  return { taleId: args.taleId, media: mediaItems };
}

export const getMyKinTaleMedia = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyKinTaleMedia', getMyKinTaleMediaHandler),
);
