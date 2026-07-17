/**
 * Send suppression for every outbound SMS and email.
 *
 * WHY THIS EXISTS
 * There is no test environment. MyTribe "beta" (mytribe-kinfolk-beta) shares
 * prod Firestore, prod functions and prod Twilio secrets with the live portal:
 * it is a second URL, not an environment. Before 2026-07-15 there was ZERO
 * `process.env` gating anywhere under notifications/, so a booking created on
 * beta wrote a real doc, fired the real trigger, and texted a real customer.
 *
 * CONTRACT (owner ruling 2026-07-15): fail-OPEN.
 *   SEND_SUPPRESS unset  -> real send. Live prod behavior is unchanged.
 *   SEND_SUPPRESS='1'    -> suppressed, logged loudly, fake id returned.
 *
 * Fail-open was chosen deliberately over requiring an explicit SEND_MODE on
 * every deploy: the fail-closed version would stop all customer notifications
 * the moment a prod deploy went out without the secret bound. The tradeoff is
 * real and named: a non-prod deploy that FORGETS SEND_SUPPRESS=1 will send for
 * real. Bind it on every non-prod target.
 *
 * Suppression is logged at warn, never silently: a suppressed send must be
 * visible in logs, and the returned id is prefixed so it is obvious in the
 * external_messages / engagement ledger that it is not a provider id.
 */

import * as logger from 'firebase-functions/logger';

export const SUPPRESSED_ID_PREFIX = 'SUPPRESSED_';

/** True when this deploy must not contact real customers. */
export function sendsAreSuppressed(): boolean {
  return process.env.SEND_SUPPRESS === '1';
}

/**
 * Fake provider id for a suppressed send. Prefixed so it can never be mistaken
 * for a Twilio SID or an smtp2go email_id downstream.
 */
export function suppressedId(channel: 'sms' | 'email'): string {
  return `${SUPPRESSED_ID_PREFIX}${channel}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Record a suppressed send. Loud by design: this is the only trace that a
 * message the code believes it sent never left the building.
 */
export function logSuppressedSend(
  channel: 'sms' | 'email',
  to: string,
  preview: string,
): void {
  logger.warn('SEND SUPPRESSED (SEND_SUPPRESS=1): no message was delivered', {
    channel,
    to,
    preview: preview.slice(0, 120),
  });
}
