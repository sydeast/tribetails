import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { logEvent } from '../lib/logger';
import { enqueueNotification } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';

const MARKETING_KEYS = ['newsletter.announcement', 'survey.event', 'marketing.optin'] as const;
type MarketingKey = (typeof MARKETING_KEYS)[number];

const Args = z.object({
  key: z.enum(MARKETING_KEYS),
  fireAtMs: z.number().int().positive(),
  audienceUids: z.array(z.string().min(1)).min(1).max(5000),
  data: z.record(z.unknown()),
});

/**
 * Admin-only callable. Schedules a marketing-class notification (newsletter /
 * survey / marketing.optin) to every uid in audienceUids at fireAtMs.
 *
 * One scheduled notification per audience uid. Sweep promotes at fire time.
 * Each recipient still passes through their marketingOptIn[<category>] check
 * via prefs/resolveChannels, opted-out users are suppressed by dispatcher.
 */
export async function scheduleMarketingBlastHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; key: MarketingKey; dispatched: number; suppressed: number }> {
  const args = Args.parse(req.data);
  if (args.fireAtMs < Date.now() - 60_000) {
    throw new HttpsError('invalid-argument', 'fireAtMs is in the past');
  }

  let dispatched = 0;
  let suppressed = 0;
  for (const uid of args.audienceUids) {
    try {
      const ids = await enqueueNotification({
        key: args.key,
        recipientUid: uid,
        data: { ...args.data, audienceUid: uid },
        fireAtMs: args.fireAtMs,
        actorUid: req.auth?.uid,
      });
      if (ids.length === 0) suppressed += 1;
      else dispatched += 1;
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'scheduleMarketingBlast',
        event: 'notification.dispatch.failed',
        extra: { key: args.key, uid, err: (err as Error)?.message },
      });
    }
  }

  // Verify Firestore reachable + audit trail (skip on dry run is N/A).
  await db().collection('marketingBlasts').add({
    key: args.key,
    fireAtMs: args.fireAtMs,
    audienceCount: args.audienceUids.length,
    dispatched,
    suppressed,
    scheduledByUid: req.auth?.uid ?? null,
    createdAt: new Date(),
  });

  return { ok: true, key: args.key, dispatched, suppressed };
}

export const scheduleMarketingBlast = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('scheduleMarketingBlast', scheduleMarketingBlastHandler),
);
