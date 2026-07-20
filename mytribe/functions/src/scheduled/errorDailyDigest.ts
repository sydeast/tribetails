import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { sendFromTemplate } from '../lib/sendFromTemplate';
import { wrapScheduled } from '../lib/wrapScheduled';

export const errorDailyDigest = onSchedule(
  { schedule: 'every day 08:00', timeZone: 'America/New_York', secrets: ['SMTP2GO_API_KEY', 'EMAIL_FROM', 'SENTRY_DSN'] },
  wrapScheduled('errorDailyDigest', async () => {
    if (!process.env.AUNTIE_NOTIFY_EMAIL) return;
    const cutoff = new Date(Date.now() - 86400 * 1000);
    const snap = await db().collection('auditLog')
      .where('severity', 'in', ['warn', 'critical'])
      .where('createdAt', '>', cutoff)
      .limit(1000).get();
    if (snap.empty) return;
    const lines = snap.docs.slice(0, 50).map((d) => {
      const x = d.data() as { event: string; familyId?: string; payload?: unknown };
      return `${x.event} fid=${x.familyId ?? '-'}`;
    }).join('\n');
    await sendFromTemplate('error.daily-digest', process.env.AUNTIE_NOTIFY_EMAIL, {
      date: new Date().toISOString().slice(0, 10),
      summary: `Total: ${snap.size}\n${lines}`,
      sentryUrl: process.env.SENTRY_DASHBOARD_URL ?? '',
    });
  }),
);
