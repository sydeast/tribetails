/**
 * #593: the retry half of the asynchronous video location strip.
 *
 * WHY RETRY AT ALL, when the trigger already runs on every upload.
 * The trigger's work is three network round trips to Cloudinary against a file
 * of up to 50 MB. The realistic failures are transient — a 5xx from the Admin
 * API, a download that stalls, a cold instance that times out — and a
 * transient failure that is never retried leaves a video with its coordinates
 * intact for good. That is the same leak #593 is about, arriving by a
 * different door.
 *
 * WHY IT IS BOUNDED. The job is idempotent (stripping an already-stripped
 * video neutralises nothing and verifies clean), so retrying is safe, but
 * retrying forever is not useful: the same error six times means a broken
 * asset or a wrong assumption, and re-downloading it every ten minutes hides
 * that instead of surfacing it. After `MAX_STRIP_ATTEMPTS` the doc keeps
 * `gpsStripStatus: 'FAILED'` and stops being picked up. It stays queryable,
 * the admin UIs show it, and the asset stays tagged `needs-gps-strip` at
 * Cloudinary. Nothing is swept under the rug; the retrying just stops.
 *
 * THIS IS ALSO THE CATCH-UP PATH for a video whose doc was written while the
 * trigger was failing to deploy or its secrets were unset.
 *
 * IT IS NOT A BACKFILL. Videos uploaded before #593 carry no
 * `gpsStripStatus` field at all and this query does not match them: it asks
 * for PENDING or FAILED, both of which only the post-#593 clients write.
 * Historical assets are out of scope by the issue's own terms.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import {
  GPS_STRIP_STATUS,
  MAX_STRIP_ATTEMPTS,
  MediaFileDoc,
  stripVideoLocationForMedia,
} from '../lib/stripVideoLocationJob';

const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY = defineSecret('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = defineSecret('CLOUDINARY_API_SECRET');

/** Videos processed per run. Each one is a multi-megabyte download, a full
 *  upload and a verification download, so the batch is deliberately small:
 *  the sweep is a safety net, not a throughput path. */
const BATCH_SIZE = 5;

export async function videoGpsStripSweepHandler(): Promise<void> {
  const cloudName = CLOUDINARY_CLOUD_NAME.value();
  const apiKey = CLOUDINARY_API_KEY.value();
  const apiSecret = CLOUDINARY_API_SECRET.value();
  if (!cloudName || !apiKey || !apiSecret) {
    logEvent({
      severity: 'error',
      function: 'videoGpsStripSweep',
      event: 'media.video.gps_strip_not_configured',
    });
    return;
  }

  const snap = await db()
    .collection('media_files')
    .where('gpsStripStatus', 'in', [GPS_STRIP_STATUS.pending, GPS_STRIP_STATUS.failed])
    .where('gpsStripAttempts', '<', MAX_STRIP_ATTEMPTS)
    .limit(BATCH_SIZE)
    .get();

  if (snap.empty) return;

  let stripped = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const outcome = await stripVideoLocationForMedia(doc.id, doc.data() as MediaFileDoc, {
      db: db(),
      creds: { cloudName, apiKey, apiSecret },
    });
    if (outcome.kind === 'stripped') stripped += 1;
    else if (outcome.kind === 'failed') failed += 1;
  }

  logEvent({
    severity: failed > 0 ? 'warn' : 'info',
    function: 'videoGpsStripSweep',
    event: 'media.video.gps_strip_sweep',
    extra: { considered: snap.size, stripped, failed },
  });
}

export const videoGpsStripSweep = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: 'us-central1',
    memory: '1GiB',
    timeoutSeconds: 540,
    secrets: [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, 'SENTRY_DSN'],
  },
  wrapScheduled('videoGpsStripSweep', videoGpsStripSweepHandler),
);
