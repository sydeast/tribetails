import { call } from '../lib/fns';

/**
 * #2061: the push an approved Communicate > Personalize "Push" draft sends to
 * its household, through the `sendHouseholdPush` callable
 * (`mytribe/functions/src/admin/sendHouseholdPush.ts`).
 *
 * The server decides everything: whether anybody in the household can be
 * reached, whether household notices are switched on (the send gate), whether
 * the operator turned message notices off, and whether the household's own
 * settings allow a push. This module is the wire and the sentence; it never
 * predicts a send.
 */

export type HouseholdPushOutcome = 'sent' | 'listed' | 'held' | 'already_sent';
export type HouseholdPushReason =
  | 'household_has_no_portal_account'
  | 'household_notices_off'
  | 'notice_turned_off'
  | 'household_push_off'
  | 'no_device'
  | 'push_failed';

export interface HouseholdPushResult {
  outcome: HouseholdPushOutcome;
  reason: HouseholdPushReason | null;
}

export interface SendHouseholdPushArgs {
  kinfolkId: string;
  draftId: string;
  body: string;
  title?: string;
}

export async function sendHouseholdPush(args: SendHouseholdPushArgs): Promise<HouseholdPushResult> {
  const title = (args.title ?? '').trim();
  const res = await call<
    { kinfolkId: string; draftId: string; body: string; title?: string },
    { ok: true; outcome?: unknown; reason?: unknown }
  >(
    'sendHouseholdPush',
    {
      kinfolkId: args.kinfolkId,
      draftId: args.draftId,
      body: args.body.trim(),
      ...(title !== '' ? { title } : {}),
    },
    // Idempotent on the server: the notice is created once per draft.
    { idempotent: true },
  );
  const outcome: HouseholdPushOutcome =
    res.outcome === 'sent' || res.outcome === 'listed' || res.outcome === 'held' || res.outcome === 'already_sent'
      ? res.outcome
      : // An answer this client cannot read is not a send it may claim.
        'held';
  const reason = typeof res.reason === 'string' ? (res.reason as HouseholdPushReason) : null;
  return { outcome, reason };
}

/** Whether a result means the push can be tried again once the cause is fixed. */
export function householdPushRetryable(r: HouseholdPushResult): boolean {
  return r.outcome === 'held';
}

/**
 * The result in the operator's words. Only `sent` says a push went out; every
 * other outcome says what did and did not happen, and what to do about it.
 */
export function householdPushResultText(r: HouseholdPushResult, household: string): { title: string; body: string } {
  switch (r.outcome) {
    case 'sent':
      return { title: 'Push sent', body: `Sent to ${household}'s phone. It is on their notifications list too.` };
    case 'already_sent':
      return { title: 'Push sent', body: `This push already went to ${household}. Nothing new was sent.` };
    case 'listed':
      return {
        title: 'On their notifications list',
        body:
          r.reason === 'household_push_off'
            ? `It is on ${household}'s notifications list. No push went to their phone, because their settings keep pushes for your messages off.`
            : r.reason === 'no_device'
              ? `It is on ${household}'s notifications list. No push went to a phone, because nobody in the household has turned on pushes in the app yet.`
              : `It is on ${household}'s notifications list. The push to their phone did not go through.`,
      };
    case 'held':
    default:
      return {
        title: 'Not sent',
        body:
          r.reason === 'household_notices_off'
            ? `Nothing reached ${household}. Notices to households are switched off. Switch on "Send notices to households" in Settings, under Notifications, then try again.`
            : r.reason === 'household_has_no_portal_account'
              ? `Nothing reached ${household}. Nobody in the household has signed in to the portal yet, so there is no one to send a push to.`
              : r.reason === 'notice_turned_off'
                ? `Nothing reached ${household}. Message notices to households are turned off in your notification settings. Turn them on, then try again.`
                : `Nothing reached ${household}.`,
      };
  }
}
