/**
 * Pure helpers for message engagement tracking (Communicate "Recent" panel).
 *
 * Outbound 1:1 sends are recorded in `external_messages` with a `providerMessageId`
 * (smtp2go email_id for email, Twilio MessageSid for SMS). Provider event
 * webhooks (smtp2go event webhook, Twilio status callback) call back with that id;
 * these helpers map a raw provider event to (a) the providerMessageId to match and
 * (b) the per-send counter to bump. Kept pure + dependency-free so matching/mapping
 * is unit-tested without Firestore, crypto, or network.
 */

export type EngagementCounter = 'delivered' | 'opened' | 'clicked' | 'bounced' | 'failed';

/**
 * smtp2go events carry the send's `email_id` verbatim — the same value
 * sendTemplatedEmail stored as providerMessageId, so no prefix-splitting is
 * needed (unlike SendGrid's `<id>.<suffix>` sg_message_id). Returns '' for
 * missing/blank input (caller skips).
 */
export function s2gProviderIdFromEvent(emailId: string | undefined | null): string {
  return (emailId ?? '').trim();
}

/** Map a smtp2go event name to a counter field, or null to ignore the event. */
export function s2gEventToCounter(event: string | undefined | null): EngagementCounter | null {
  switch ((event ?? '').toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'open':
      return 'opened';
    case 'click':
      return 'clicked';
    case 'bounce':
    case 'reject':
    case 'spam':
      // All deliverability-negative outcomes share the bounced bucket (mirrors
      // the old SendGrid bounce/blocked/dropped grouping; there is no dedicated
      // spam counter on external_messages).
      return 'bounced';
    default:
      // processed / unsubscribe / resubscribe are not engagement counters here
      // (unsubscribe is handled by the suppression flow separately).
      return null;
  }
}

/** Map a Twilio message status to a counter field, or null to ignore the status. */
export function twilioStatusToCounter(status: string | undefined | null): EngagementCounter | null {
  switch ((status ?? '').toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'opened'; // WhatsApp read receipts
    case 'failed':
    case 'undelivered':
      return 'failed';
    default:
      // queued / sending / sent -> no counter bump (not yet a terminal outcome)
      return null;
  }
}

/**
 * Stable dedupe id for a smtp2go event. Prefers the per-event webhook `id`;
 * falls back to `email_id:event` so once-per-send events (delivered/bounce)
 * still dedupe when `id` is absent. The fallback collapses repeated opens/clicks
 * of the same send into one count — acceptable degradation vs. counting nothing.
 * Returns null when no stable key can be built (caller skips).
 */
export function s2gEventDedupeId(ev: {
  id?: string | null;
  email_id?: string | null;
  event?: string | null;
}): string | null {
  const id = ev.id?.trim();
  if (id) return id;
  const emailId = ev.email_id?.trim();
  const event = ev.event?.trim();
  return emailId && event ? `${emailId}:${event}` : null;
}

/** The zeroed counter map stamped on a new send so the read path always has fields. */
export function zeroCounters(): Record<EngagementCounter, number> {
  return { delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0 };
}
