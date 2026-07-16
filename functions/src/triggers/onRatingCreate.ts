import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { enqueueNotification } from '../notifications/dispatcher';

type RatingDoc = {
  bookingId?: string;
  score?: number;
  comment?: string | null;
  submittedByUid?: string;
};

const BAD_THRESHOLD = 3;

/**
 * Watches `families/{kinfolkId}/ratings/{ratingId}`.
 * Branches on score:
 *   score <= 3 -> rating.submitted.bad (urgent business alert)
 *   score >= 4 -> rating.submitted.good
 */
export const onRatingCreate = onDocumentCreated(
  {
    document: 'families/{kinfolkId}/ratings/{ratingId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onRatingCreate', async (event) => {
    const rating = event.data?.data() as RatingDoc | undefined;
    if (!rating) return;
    if (typeof rating.score !== 'number') return;

    const kinfolkId = event.params.kinfolkId as string;
    const ratingId = event.params.ratingId as string;
    const key = rating.score <= BAD_THRESHOLD ? 'rating.submitted.bad' : 'rating.submitted.good';

    try {
      await enqueueNotification({
        key,
        data: {
          kinfolkId,
          ratingId,
          bookingId: rating.bookingId ?? null,
          score: rating.score,
          comment: rating.comment ?? null,
          submittedByUid: rating.submittedByUid ?? null,
        },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'onRatingCreate',
        event: 'notification.dispatch.failed',
        extra: { kinfolkId, ratingId, key, err: (err as Error)?.message },
      });
    }
  }),
);
