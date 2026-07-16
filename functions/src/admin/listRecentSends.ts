import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Recent external sends + their engagement counts, for the Communicate "Recent"
 * panel. external_messages has no client read rule (admin-SDK-only collection), so
 * this callable is the read path. Recipient is already redacted at write time.
 */

export interface RecentSend {
  id: string;
  channel: string;
  recipientRedacted: string;
  subject: string | null;
  sentAtMs: number;
  counts: { delivered: number; opened: number; clicked: number; bounced: number; failed: number };
  lastEvent: string | null;
}

export async function listRecentSendsHandler(_req: CallableRequest<unknown>): Promise<{ sends: RecentSend[] }> {
  const snap = await db().collection('external_messages').orderBy('sentAtMs', 'desc').limit(30).get();
  const sends: RecentSend[] = snap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>;
    const c = (x.counts as Record<string, number> | undefined) ?? {};
    return {
      id: d.id,
      channel: (x.channel as string) ?? '',
      recipientRedacted: (x.recipientRedacted as string) ?? '',
      subject: (x.subject as string | null) ?? null,
      sentAtMs: typeof x.sentAtMs === 'number' ? (x.sentAtMs as number) : 0,
      counts: {
        delivered: c.delivered ?? 0,
        opened: c.opened ?? 0,
        clicked: c.clicked ?? 0,
        bounced: c.bounced ?? 0,
        failed: c.failed ?? 0,
      },
      lastEvent: (x.lastEvent as string | null) ?? null,
    };
  });
  return { sends };
}

export const listRecentSends = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listRecentSends', listRecentSendsHandler),
);
