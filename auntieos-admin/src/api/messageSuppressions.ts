import { call } from '../lib/fns';
import type { ExternalChannel } from '../lib/externalSend';

/**
 * The do-not-send list (`message_suppressions`), through its two owner-only
 * callables (MyTribe `functions/src/admin/messageSuppressions.ts`, #1083). The
 * collection is denied to every client in the rules, so there is no direct
 * Firestore path.
 *
 * `recipient` is the FULL address. Clear needs it and the server refuses the
 * masked form, so a row carries both: show `recipient`, send `recipient` back.
 */
export type SuppressionReason = 'hard_bounce' | 'opt_out';

export type SuppressionSource = 'smtp2go' | 'admin';

export type SuppressionFilter = 'all' | SuppressionReason;

export interface MessageSuppression {
  recipient: string;
  recipientRedacted: string;
  channel: ExternalChannel;
  reason: SuppressionReason;
  source: SuppressionSource;
  suppressedAtMs: number;
  /** The household opted out, whether or not the address also bounced. */
  optedOut: boolean;

  /** The smtp2go webhook event id of the bounce, or null. */
  eventId: string | null;
}

export interface MessageSuppressionPage {
  items: MessageSuppression[];
  nextCursor: string | null;
}

export interface ListMessageSuppressionsArgs {
  reason?: SuppressionFilter;
  limit?: number;
  cursor?: string;
}

interface WireRow {
  recipient?: unknown;
  recipientRedacted?: unknown;
  channel?: unknown;
  reason?: unknown;
  source?: unknown;
  suppressedAtMs?: unknown;
  optedOut?: unknown;
  eventId?: unknown;
}

function decodeRow(row: WireRow): MessageSuppression | null {
  if (typeof row?.recipient !== 'string' || row.recipient === '') return null;
  const reason: SuppressionReason = row.reason === 'hard_bounce' ? 'hard_bounce' : 'opt_out';
  return {
    recipient: row.recipient,
    recipientRedacted: typeof row.recipientRedacted === 'string' ? row.recipientRedacted : '',
    channel: row.channel === 'sms' ? 'sms' : 'email',
    reason,
    source: row.source === 'smtp2go' ? 'smtp2go' : 'admin',
    suppressedAtMs: typeof row.suppressedAtMs === 'number' ? row.suppressedAtMs : 0,
    // An opt-out only row is an opt-out by definition, whatever an older deploy sent.
    optedOut: row.optedOut === true || reason === 'opt_out',
    eventId: typeof row.eventId === 'string' && row.eventId !== '' ? row.eventId : null,
  };
}

export async function listMessageSuppressions(args: ListMessageSuppressionsArgs): Promise<MessageSuppressionPage> {
  const res = await call<ListMessageSuppressionsArgs, { items?: WireRow[]; nextCursor?: string | null }>(
    'listMessageSuppressions',
    {
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    },
    { idempotent: true },
  );

  const items = (Array.isArray(res.items) ? res.items : [])
    .map(decodeRow)
    .filter((r): r is MessageSuppression => r !== null);
  return { items, nextCursor: typeof res.nextCursor === 'string' && res.nextCursor !== '' ? res.nextCursor : null };
}

export interface ClearMessageSuppressionResult {
  ok: true;
  channel: ExternalChannel;
  recipientRedacted: string;
  /** True when the address also had an opt-out, which Clear never removes. */
  optOutKept: boolean;
}

/**
 * Clears a hard bounce. An opt-out is the household's own choice, so it stays:
 * on a row that holds both, only the bounce goes. The server audits who did it.
 */
export async function clearMessageSuppression(recipient: string): Promise<ClearMessageSuppressionResult> {
  const res = await call<{ recipient: string }, { ok: true; channel?: string; recipientRedacted?: string; optOutKept?: boolean }>(
    'clearMessageSuppression',
    { recipient: recipient.trim() },
  );
  return {
    ok: true,
    channel: res.channel === 'sms' ? 'sms' : 'email',
    recipientRedacted: typeof res.recipientRedacted === 'string' ? res.recipientRedacted : '',
    optOutKept: res.optOutKept === true,
  };
}
