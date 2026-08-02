import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { wrapScheduled } from '../lib/wrapScheduled';
import { SERIAL } from '../lib/runtimeOptions';

const DAILY_DIGEST_PAGE_SIZE = 1000;

export interface ErrorDailyDigestResult {
  sent: boolean;
  total: number;
  truncated: boolean;
}

/**
 * Summarizes the last 24h of failed activity_log entries and emails them to
 * AUNTIE_NOTIFY_EMAIL. Extracted from the schedule wrapper so its query is
 * unit-testable, the same shape as cleanupExpiredShareLinksCore.
 *
 * This queried `auditLog` (severity in [warn, critical], field `event`) since
 * it shipped. The only writer, writeAuditEntry.ts, has never written that
 * collection or those fields: it writes `activity_log` with `actionType` and
 * `status`, so the digest never matched a document. `status` (not `severity`)
 * is the writer's actual failure marker: SECRETS_TRIBEPIN_SET is `severity:
 * 'warn'` for admin visibility even though it succeeded (status SUCCESS), so
 * a severity-based filter sweeps in successes right along with failures.
 */
export async function errorDailyDigestCore(now: Date): Promise<ErrorDailyDigestResult> {
  if (!process.env.AUNTIE_NOTIFY_EMAIL) return { sent: false, total: 0, truncated: false };

  const cutoff = new Date(now.getTime() - 86400 * 1000);
  // `createdAt` carries the range filter, so it must lead any orderBy
  // (Firestore requires this); descending means a truncated page still
  // shows the most recent failures rather than the oldest ones in the window.
  const snap = await db().collection('activity_log')
    .where('status', '==', 'FAILURE')
    .where('createdAt', '>', cutoff)
    .orderBy('createdAt', 'desc')
    .limit(DAILY_DIGEST_PAGE_SIZE)
    .get();
  if (snap.empty) return { sent: false, total: 0, truncated: false };

  const truncated = snap.size >= DAILY_DIGEST_PAGE_SIZE;
  const lines = snap.docs.slice(0, 50).map((d) => {
    const x = d.data() as { actionType?: string; familyId?: string };
    return `${x.actionType ?? 'UNKNOWN'} fid=${x.familyId ?? '-'}`;
  }).join('\n');
  const truncationNote = truncated
    ? `\n(truncated at ${DAILY_DIGEST_PAGE_SIZE}; showing the most recent failures)`
    : '';

  await sendFromTemplate('error.daily-digest', process.env.AUNTIE_NOTIFY_EMAIL, {
    date: now.toISOString().slice(0, 10),
    summary: `Total: ${snap.size}\n${lines}${truncationNote}`,
    sentryUrl: process.env.SENTRY_DASHBOARD_URL ?? '',
  });

  return { sent: true, total: snap.size, truncated };
}

export const errorDailyDigest = onSchedule(
  // One digest email a day to the operator. Keeps the 0.25 vCPU default.
  {
    schedule: 'every day 08:00',
    timeZone: 'America/New_York',
    secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'],
    ...SERIAL,
  },
  wrapScheduled('errorDailyDigest', async () => {
    await errorDailyDigestCore(new Date());
  }),
);
