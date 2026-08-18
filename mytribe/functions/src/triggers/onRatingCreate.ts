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
 *
 * The body is a named export, the `onKinTaleCommentCreate` convention, so the
 * dispatch payload can be asserted without standing up a Firestore trigger.
 */
export async function onRatingCreateHandler(event: any): Promise<void> {
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
        // THE DOC ID IS THE VISIT ID. `submitRating` writes this rating at
        // `families/{kinfolkId}/ratings/{visitId}`, so `ratingId` IS the visit
        // being rated and this fallback is a fact, not a guess. That callable
        // now also writes `bookingId` explicitly, which is what the left half
        // reads; the fallback is what makes every rating ALREADY in the
        // collection deep-link correctly too, rather than only the ones
        // written from here on. Before either, this was always null, the
        // dispatcher's `resolveTargetRef` fell through to the household, and
        // a rating notification's Open landed on the household profile
        // instead of the visit (issue #389).
        bookingId: rating.bookingId ?? ratingId,
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
}

export const onRatingCreate = onDocumentCreated(
  {
    document: 'families/{kinfolkId}/ratings/{ratingId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onRatingCreate', onRatingCreateHandler),
);
