/**
 * #593: the asynchronous video location strip, as one runnable job.
 *
 * Shared by the `media_files` create trigger (the normal path) and the
 * scheduled sweep (the retry / catch-up path), so there is exactly one
 * description of what stripping a video means.
 *
 * THE SEQUENCE, and why each step is there:
 *
 *   1. Resolve the public id. From `cloudinaryPublicId` when the writer
 *      stamped one, else parsed back out of `storageUrl`. Refuse rather than
 *      guess: overwriting the wrong public id would destroy someone else's
 *      video.
 *   2. Ask Cloudinary for the STORED ORIGINAL's `secure_url`. The doc's own
 *      `storageUrl` is a transformed delivery URL on two of the three writers,
 *      and stripping a derivative would leave the original untouched.
 *   3. Download it, strip it, and VERIFY the stripped bytes are clean before
 *      anything is uploaded. A strip that missed something must never be
 *      written back as if it had worked.
 *   4. Overwrite the original in place, with CDN invalidation.
 *   5. Download what is now stored and verify THAT. Step 3 proves our bytes
 *      were clean; step 5 proves the bytes Cloudinary is actually serving are
 *      the ones we sent. Only after this does the doc say STRIPPED.
 *
 * FAILURE IS LOUD AND LEAVES THE ASSET ALONE. Any error short of a verified
 * success records `gpsStripStatus: 'FAILED'` with the message and the attempt
 * count, logs at error severity with the media id and the public id, and does
 * not touch the Cloudinary asset. The original keeps working; it just still
 * has its coordinates, and it is now findable in two independent places — the
 * Firestore field, and the `needs-gps-strip` tag the upload signer put on the
 * asset, which only a successful strip removes.
 */

import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { logEvent } from './logger';
import { stripAndVerify, findLocationMetadata } from './videoLocationMetadata';
import {
  CloudinaryCredentials,
  downloadAsset,
  fetchVideoResource,
  hasTransformation,
  overwriteVideoAsset,
  publicIdFromVideoUrl,
} from './cloudinaryVideoAsset';

export const GPS_STRIP_STATUS = {
  /** Uploaded, not yet processed. Written by the clients on every video. */
  pending: 'PENDING',
  /** Verified: the stored original carries no location metadata. */
  stripped: 'STRIPPED',
  /** Tried and did not succeed. The asset still has its coordinates. */
  failed: 'FAILED',
} as const;

/** Attempts before the sweep stops retrying. Beyond this a human is needed:
 *  the same error six times is a broken asset or a broken assumption, and
 *  re-downloading it every five minutes forever just hides that. The doc keeps
 *  status FAILED and stays queryable. */
export const MAX_STRIP_ATTEMPTS = 6;

export interface MediaFileDoc {
  fileType?: string;
  storageUrl?: string;
  cloudinaryPublicId?: string;
  originalFileName?: string;
  gpsStripStatus?: string;
  gpsStripAttempts?: number;
}

export interface StripJobDeps {
  db: Firestore;
  creds: CloudinaryCredentials;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export type StripOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'stripped'; publicId: string; secureUrl: string; neutralised: string[] }
  | { kind: 'failed'; publicId: string; error: string; attempts: number };

/** True when this doc describes a video that still needs stripping. */
export function needsStrip(media: MediaFileDoc | undefined): boolean {
  if (!media) return false;
  if ((media.fileType ?? '').toUpperCase() !== 'VIDEO') return false;
  const status = (media.gpsStripStatus ?? '').toUpperCase();
  return status !== GPS_STRIP_STATUS.stripped;
}

/** The public id to operate on, or null when it cannot be established. */
export function resolvePublicId(media: MediaFileDoc, cloudName: string): string | null {
  const stamped = (media.cloudinaryPublicId ?? '').trim();
  if (stamped !== '') return stamped;
  const url = (media.storageUrl ?? '').trim();
  if (url === '') return null;
  return publicIdFromVideoUrl(url, cloudName);
}

/**
 * Runs the strip for one `media_files` document. Never throws: every outcome
 * is recorded on the doc and returned, because a throwing trigger would be
 * retried by the platform on its own schedule, outside the attempt counter
 * this job keeps.
 */
export async function stripVideoLocationForMedia(
  mediaFileId: string,
  media: MediaFileDoc,
  deps: StripJobDeps,
): Promise<StripOutcome> {
  const { db, creds } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ref = db.doc(`media_files/${mediaFileId}`);
  const attempts = (media.gpsStripAttempts ?? 0) + 1;

  if (!needsStrip(media)) {
    return { kind: 'skipped', reason: 'not a video needing a strip' };
  }

  const publicId = resolvePublicId(media, creds.cloudName);
  if (publicId === null) {
    const error = 'No cloudinaryPublicId on the doc and none recoverable from storageUrl.';
    await recordFailure(ref, attempts, error);
    logFailure(mediaFileId, '(unknown)', error, attempts);
    return { kind: 'failed', publicId: '(unknown)', error, attempts };
  }

  try {
    const resource = await fetchVideoResource(creds, publicId, fetchImpl);
    const original = await downloadAsset(resource.secureUrl, fetchImpl);

    const before = findLocationMetadata(original);
    const { buffer, neutralised } = stripAndVerify(original);

    const filename = fileNameFor(media, resource.format);
    const written = await overwriteVideoAsset(creds, publicId, buffer, filename, fetchImpl);

    // Read back what Cloudinary is now serving and verify THAT, not what we
    // hoped we sent. This is the only check that speaks to the property the
    // issue asks for: nothing a viewer can reach carries coordinates.
    const storedNow = await downloadAsset(written.secureUrl, fetchImpl);
    const after = findLocationMetadata(storedNow);
    if (after.length > 0) {
      throw new Error(`Stored original still reports location metadata: ${after.join(', ')}`);
    }

    // The overwrite bumps the Cloudinary version, and pointing the doc at the
    // new versioned URL means viewers stop being served the CDN's cached copy
    // of the old bytes the moment the doc updates, instead of waiting out the
    // invalidation.
    //
    // BUT ONLY WHEN THE DOC ALREADY HELD AN UNTRANSFORMED URL. The three
    // writers disagree: the web admin stores Cloudinary's raw `secure_url`,
    // while Android and the desktop uploader store a TRANSFORMED delivery URL
    // (`du_15.0,q_auto,f_auto`) — and that transformation is what enforces the
    // 15-second clip cap and the delivery optimisation at view time. Replacing
    // it with the original's URL would quietly turn a capped, optimised clip
    // into the full-length unoptimised original. Those rows keep their URL and
    // pick the new bytes up through `invalidate=true` instead, which costs them
    // the CDN's propagation delay and nothing else.
    const repointsUrl = !hasTransformation(media.storageUrl ?? '', creds.cloudName);
    await ref.set(
      {
        gpsStripStatus: GPS_STRIP_STATUS.stripped,
        gpsStripAttempts: attempts,
        gpsStripError: '',
        gpsStripAt: FieldValue.serverTimestamp(),
        ...(repointsUrl ? { storageUrl: written.secureUrl } : {}),
      },
      { merge: true },
    );

    logEvent({
      severity: 'info',
      function: 'stripVideoLocation',
      event: 'media.video.gps_stripped',
      extra: {
        mediaFileId,
        publicId,
        attempts,
        foundBefore: before,
        neutralised,
        bytesBefore: original.length,
        bytesAfter: written.bytes,
        repointedStorageUrl: repointsUrl,
      },
    });
    return { kind: 'stripped', publicId, secureUrl: written.secureUrl, neutralised };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    await recordFailure(ref, attempts, error);
    logFailure(mediaFileId, publicId, error, attempts);
    return { kind: 'failed', publicId, error, attempts };
  }
}

function fileNameFor(media: MediaFileDoc, format: string): string {
  const name = (media.originalFileName ?? '').trim();
  if (name !== '') return name;
  return `video.${format !== '' ? format : 'mp4'}`;
}

async function recordFailure(
  ref: FirebaseFirestore.DocumentReference,
  attempts: number,
  error: string,
): Promise<void> {
  await ref.set(
    {
      gpsStripStatus: GPS_STRIP_STATUS.failed,
      gpsStripAttempts: attempts,
      // Bounded: a Cloudinary error body can be long, and this field is read
      // by two UIs.
      gpsStripError: error.slice(0, 500),
      gpsStripAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

function logFailure(mediaFileId: string, publicId: string, error: string, attempts: number): void {
  logEvent({
    severity: 'error',
    function: 'stripVideoLocation',
    event: 'media.video.gps_strip_failed',
    extra: { mediaFileId, publicId, attempts, error, maxAttempts: MAX_STRIP_ATTEMPTS },
  });
}
