/**
 * #593: strips location metadata from every uploaded video, asynchronously.
 *
 * WHY A FIRESTORE TRIGGER AND NOT AN UPLOAD-TIME TRANSFORMATION.
 * The photo fix (#583/PR #590) strips inside the upload itself, by signing
 * `fl_force_strip` as an incoming transformation. That flag is image-only, and
 * the video equivalent would mean re-encoding the whole file inside the upload
 * request. Operator ruling on #593: strip asynchronously after the upload, and
 * accept a window where the stored original still holds coordinates.
 *
 * WHY `media_files` IS THE RIGHT HOOK. Every video upload path in the product
 * writes a `media_files` row: the React admin gallery/media dialog, the
 * Android `ImageAndVideo` picker, Android KinTale, the desktop JVM uploader,
 * and Tribal Intel attachments on both web and Android (which write a
 * `media_files` row alongside the `training_documents.attachments[]` entry,
 * for the same Cloudinary asset — so stripping the asset covers both). The
 * kinfolk portal cannot upload video at all: its signer binds
 * `allowed_formats=jpg,png,webp,gif` into the signature and its confirm side
 * rejects any URL that is not `/image/upload/`.
 *
 * SO THE COVERAGE CLAIM IS: everything a viewer or a share link can reach is
 * reachable only through a persisted doc, and every persisted video doc passes
 * through here. An upload that reached Cloudinary and then died before its doc
 * was written is NOT covered by this trigger — nothing references it, so no
 * viewer and no share link can reach it, but it does sit in the account. That
 * is what the `needs-gps-strip` tag is for: the upload signer binds it into
 * the signature, so Cloudinary carries it on every video from the instant it
 * lands, and only a successful strip takes it off. Orphans stay listed under
 * that tag in the Admin API.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { MediaFileDoc, needsStrip, stripVideoLocationForMedia } from '../lib/stripVideoLocationJob';

const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY = defineSecret('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = defineSecret('CLOUDINARY_API_SECRET');

export async function onMediaFileVideoStripHandler(event: any): Promise<void> {
  const mediaFileId = event.params.mediaFileId as string;
  const media = event.data?.data() as MediaFileDoc | undefined;

  // Images are the overwhelming majority of this collection and the photo path
  // already strips at upload. Leave immediately rather than reading secrets.
  if (!needsStrip(media)) return;

  const cloudName = CLOUDINARY_CLOUD_NAME.value();
  const apiKey = CLOUDINARY_API_KEY.value();
  const apiSecret = CLOUDINARY_API_SECRET.value();
  if (!cloudName || !apiKey || !apiSecret) {
    // Loud, not silent: a misconfigured deploy that quietly stopped stripping
    // would reopen #593 with nothing in the logs to say so.
    logEvent({
      severity: 'error',
      function: 'onMediaFileVideoStrip',
      event: 'media.video.gps_strip_not_configured',
      extra: { mediaFileId },
    });
    return;
  }

  await stripVideoLocationForMedia(mediaFileId, media as MediaFileDoc, {
    db: db(),
    creds: { cloudName, apiKey, apiSecret },
  });
}

export const onMediaFileVideoStrip = onDocumentCreated(
  {
    document: 'media_files/{mediaFileId}',
    region: 'us-central1',
    // The job buffers the whole video twice (downloaded original, stripped
    // copy) against a 50 MB client-side upload cap, and does three round trips
    // to Cloudinary. The v2 defaults (256 MiB / 60 s) are not enough.
    memory: '1GiB',
    timeoutSeconds: 540,
    secrets: [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, 'SENTRY_DSN'],
  },
  wrapTrigger('onMediaFileVideoStrip', onMediaFileVideoStripHandler),
);
