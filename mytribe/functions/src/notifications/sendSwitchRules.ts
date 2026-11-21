import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { getNotificationDef } from './catalog';
import { loadHouseholdSendGate } from './householdSendGate';
import { loadBusinessOverride, notificationDisabledFor } from './prefs';

/**
 * #1834 (operator ruling, 2026-11-20): holding a broadcast or a marketing
 * blast. What the switch holds and what passes is set out in
 * `householdSendGate.ts`.
 */
export { BROADCAST_KEYS, ONE_HOUSEHOLD_MESSAGE_KEYS, isBroadcastKey, passesHouseholdSendSwitch } from './householdSendGate';

/**
 * Why a broadcast is held, as the token the clients match on:
 *   off         the send switch is off
 *   unreadable  the switch could not be read (the gate fails closed)
 *   turnedOff   the notification itself is turned off in Settings
 */
export type BroadcastHoldReason = 'off' | 'unreadable' | 'turnedOff';

/**
 * Whether a broadcast of `key` is held right now, and why; null when it may go.
 * The switch first, so a business with both off reads "notices are off".
 */
export async function broadcastHoldReason(key: string): Promise<BroadcastHoldReason | null> {
  const gate = await loadHouseholdSendGate(db());
  if (!gate.live) return gate.state === 'read-failed' ? 'unreadable' : 'off';
  const def = getNotificationDef(key);
  const override = await loadBusinessOverride(def.key);
  // Empty prefs: only the operator's own switch is asked here. A marketing
  // key answers 'marketing' for a household with no opt-in, which is a fact
  // about one household and is still decided per copy by the dispatcher.
  if (notificationDisabledFor(def, {}, override, 'kinfolk') === 'operator') return 'turnedOff';
  return null;
}

/** The machine token in the refusal, matched by web, Android and desktop. */
export const BROADCAST_HELD_TOKENS: Record<BroadcastHoldReason, string> = {
  off: 'held_household_notices_off',
  unreadable: 'held_household_notices_unreadable',
  turnedOff: 'held_notice_turned_off',
};

/**
 * The refusal a held broadcast or blast answers with. `failed-precondition`,
 * like `no_recipients`: nothing was sent and nothing was stored, so the same
 * idempotency key can send it once notices are on again.
 */
export function broadcastHeldError(reason: BroadcastHoldReason, fn: string): HttpsError {
  logEvent({ severity: 'info', function: fn, event: 'broadcast.held', extra: { reason } });
  return new HttpsError('failed-precondition', BROADCAST_HELD_TOKENS[reason], { held: reason });
}

/**
 * The one Activity Log line for a held broadcast or blast. Never throws: the
 * refusal is the owner's answer, and a line that cannot be written must not
 * replace it with an error about the log.
 */
export async function recordBroadcastHeld(input: {
  what: 'a broadcast' | 'a marketing blast';
  key: string;
  households: number;
  reason: BroadcastHoldReason;
  actorUid: string;
  fn: string;
}): Promise<void> {
  try {
    const [{ writeAuditEntry }, { AUDIT_EVENTS }, { broadcastHeldWords }] = await Promise.all([
      import('../lib/writeAuditEntry.js'),
      import('../lib/auditEvents.js'),
      import('../lib/activityWords.js'),
    ]);
    await writeAuditEntry({
      status: 'NOT_SENT',
      event: AUDIT_EVENTS.NOTIFICATION_NOT_SENT,
      severity: input.reason === 'unreadable' ? 'warn' : 'info',
      actorRole: 'AUNTIE',
      actorUid: input.actorUid,
      description: broadcastHeldWords(input.what, input.households, input.reason),
      payload: {
        key: input.key,
        outcome: input.reason === 'turnedOff' ? 'turned_off' : 'held',
        households: input.households,
        ...(input.reason === 'unreadable' ? { reason: 'setting_unreadable' } : {}),
      },
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: input.fn,
      event: 'broadcast.held.audit_failed',
      errorMessage: (err as Error)?.message,
      extra: { key: input.key, reason: input.reason },
    });
  }
}
