import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Recent sends + their engagement counts, for the Communicate "Recent" panel.
 * external_messages has no client read rule (admin-SDK-only collection), so
 * this callable is the read path. Recipient is already redacted at write time.
 *
 * ── WHAT COUNTS AS A SEND (#1610) ─────────────────────────────────────────
 * Recent read `external_messages` alone, which only `sendExternalMessage`
 * writes. A broadcast writes `broadcasts/{id}` and an Inbox reply writes into
 * the household's conversation, so the panel said "No external sends yet"
 * while the Inbox showed messages the operator had sent. Three ledgers now
 * feed it, newest first, each row tagged with its `kind`:
 *
 *   external   a 1:1 email or text (sendExternalMessage), with provider counts
 *   broadcast  one row per broadcast, `recipientCount` households
 *   reply      the latest Auntie reply in each conversation thread
 *
 * The reply rows come from the thread SUMMARIES (`conversations`, where
 * Auntie spoke last), not a collection-group scan of every message, which
 * would need a new composite index. A thread whose household answered since
 * shows the household's message in the Inbox, not here.
 *
 * The collection names are literals rather than imports so this light read
 * does not load the broadcast sender (Twilio, the mailer) on a cold start.
 */

export type RecentSendKind = 'external' | 'broadcast' | 'reply';

export interface RecentSend {
  id: string;
  kind: RecentSendKind;
  /** `email` | `sms` for external; `broadcast` or `message` otherwise. */
  channel: string;
  recipientRedacted: string;
  subject: string | null;
  sentAtMs: number;
  counts: { delivered: number; opened: number; clicked: number; bounced: number; failed: number };
  lastEvent: string | null;
  /** Broadcast only: households targeted. */
  recipientCount?: number;
  /** Broadcast only: the channels it went out on. */
  channels?: string[];
  /** Reply only: the start of what Auntie wrote. */
  preview?: string;
}

const PER_SOURCE = 30;
const zero = (): RecentSend['counts'] => ({ delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function externalRow(id: string, x: Record<string, unknown>): RecentSend {
  const c = (x.counts as Record<string, number> | undefined) ?? {};
  return {
    id,
    kind: 'external',
    channel: str(x.channel),
    recipientRedacted: str(x.recipientRedacted),
    subject: (x.subject as string | null) ?? null,
    sentAtMs: num(x.sentAtMs),
    counts: {
      delivered: c.delivered ?? 0,
      opened: c.opened ?? 0,
      clicked: c.clicked ?? 0,
      bounced: c.bounced ?? 0,
      failed: c.failed ?? 0,
    },
    lastEvent: (x.lastEvent as string | null) ?? null,
  };
}

export function broadcastRow(id: string, x: Record<string, unknown>): RecentSend {
  const channels = Array.isArray(x.channels)
    ? (x.channels as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  return {
    id: `broadcast_${id}`,
    kind: 'broadcast',
    channel: 'broadcast',
    recipientRedacted: str(x.criteriaDescription),
    subject: typeof x.subject === 'string' && x.subject !== '' ? x.subject : null,
    sentAtMs: num(x.sentAtMs),
    counts: zero(),
    lastEvent: null,
    recipientCount: num(x.recipientCount),
    channels,
  };
}

/** A thread summary as a reply row, or null when the household spoke last. */
export function replyRow(id: string, x: Record<string, unknown>): RecentSend | null {
  if (str(x.lastSenderRole).trim().toLowerCase() !== 'auntie') return null;
  return {
    id: `reply_${id}`,
    kind: 'reply',
    channel: 'message',
    recipientRedacted: str(x.kinfolkName).trim() || 'Household',
    subject: null,
    sentAtMs: num(x.lastMessageAtMs),
    counts: zero(),
    lastEvent: null,
    preview: str(x.lastMessagePreview),
  };
}

/** Newest first across all three ledgers, capped. Pure. */
export function mergeRecentSends(rows: RecentSend[], cap = PER_SOURCE * 2): RecentSend[] {
  return [...rows].sort((a, b) => b.sentAtMs - a.sentAtMs).slice(0, cap);
}

export async function listRecentSendsHandler(_req: CallableRequest<unknown>): Promise<{ sends: RecentSend[] }> {
  const [external, broadcasts, threads] = await Promise.all([
    db().collection('external_messages').orderBy('sentAtMs', 'desc').limit(PER_SOURCE).get(),
    db().collection('broadcasts').orderBy('sentAtMs', 'desc').limit(PER_SOURCE).get(),
    db().collection('conversations').orderBy('lastMessageAtMs', 'desc').limit(PER_SOURCE).get(),
  ]);
  const rows: RecentSend[] = [
    ...external.docs.map((d) => externalRow(d.id, d.data() as Record<string, unknown>)),
    ...broadcasts.docs.map((d) => broadcastRow(d.id, d.data() as Record<string, unknown>)),
    ...threads.docs
      .map((d) => replyRow(d.id, d.data() as Record<string, unknown>))
      .filter((r): r is RecentSend => r !== null),
  ];
  return { sends: mergeRecentSends(rows) };
}

export const listRecentSends = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listRecentSends', listRecentSendsHandler),
);
