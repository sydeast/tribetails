import { type VisitLifecycleAction } from '../api/sessionsWrite';
import { type VisitLifecycleSession } from './visitLifecyclePatch';

/**
 * #1794: what the household is told about a visit-clock tap, said in plain
 * words, BEFORE the tap (the confirm) and AFTER it (the line on the card).
 *
 * Found on the Nov 10 walk: the confirms promised "Dre East will be told their
 * Auntie is on the way" while the household-notices switch was off and Dre
 * East had no portal account, so nothing could be sent. The server threw on
 * the missing account, and the card never said the household was not told.
 *
 * ONE ORDER, SHARED WITH THE SERVER AND ANDROID. When more than one reason
 * applies, a household with no portal account is named for that first: turning
 * the switch on would not reach them either. Only a household that has an
 * account is told the switch is off. The server checks in the same order
 * (`functions/src/admin/dispatchVisitNotification.ts#VISIT_NOTICE_REASONS`),
 * and Android's copy of these sentences is `domain/VisitNoticeWords.kt`.
 */

/** Every `notifySkipped` value the clients and the server produce, by name. */
export type VisitNoticeSkip =
  | 'no_event_for_action'
  | 'session_has_no_kinfolk'
  | 'session_has_no_routing_ids'
  | 'household_has_no_portal_account'
  | 'household_notices_off'
  | 'household_prefs_suppressed'
  | 'already_notified'
  | 'already_in_this_state'
  | 'no_recipient'
  | 'not_sent'
  | 'dispatch_failed';

/** What each action tells the household, as the end of "X will be told ...". */
const TOLD_WHAT: Readonly<Partial<Record<VisitLifecycleAction, string>>> = {
  ON_MY_WAY: 'their Auntie is on the way',
  ARRIVED: 'their Auntie has arrived',
  DEPARTED: 'the visit has finished',
};

/** "the Wrens" opens a sentence as "The Wrens". */
function opening(name: string): string {
  return name === '' ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The sentence the card shows once the notification has settled, or `''` when
 * there is nothing to say about the household (an undo, which never notifies,
 * or a double tap that wrote nothing).
 */
export function visitNoticeOutcomeSentence(
  outcome: { notified: boolean; notifySkipped: string | null },
  household: string,
): string {
  const name = opening(household);
  if (outcome.notified) return `${name} was notified.`;
  switch (outcome.notifySkipped) {
    case 'no_event_for_action':
    case 'already_in_this_state':
      return '';
    case 'household_has_no_portal_account':
      return `${name} was not notified, because they have no portal account.`;
    case 'household_notices_off':
      return `${name} was not notified, because notices to households are off in Settings.`;
    case 'household_prefs_suppressed':
      return `${name} was not notified, because this notice is turned off for them.`;
    case 'already_notified':
      return `${name} was already told about this step, so it was not sent again.`;
    case 'session_has_no_kinfolk':
      return 'No household was notified, because this visit is not linked to one.';
    case 'session_has_no_routing_ids':
      return `${name} was not notified, because this visit is not linked to a booking.`;
    case 'dispatch_failed':
      return `The notice to ${household} could not be sent.`;
    default:
      // `no_recipient`, `not_sent`, and anything an older or newer server says
      // that this build has no words for. True, and it promises nothing.
      return `${name} was not notified.`;
  }
}

/** What the confirm can honestly say before the tap. */
export type VisitNoticePreview =
  /** The action tells nobody anything (undo). The confirm says nothing about it. */
  | { kind: 'none' }
  /** The switch or the account has not loaded yet: neither promise nor reason. */
  | { kind: 'unknown' }
  | { kind: 'will_notify' }
  | {
      kind: 'will_not_notify';
      reason:
        | 'session_has_no_kinfolk'
        | 'session_has_no_routing_ids'
        | 'household_has_no_portal_account'
        | 'household_notices_off';
    };

/**
 * PURE. Whether this tap can reach the household, from what the screen already
 * holds.
 *
 * @param hasPortalAccount whether the household's `kinfolk` record carries a
 *        linked login (`uid`), which is what the server routes to. `null` while
 *        that record has not loaded.
 * @param noticesLive `business_settings.householdNotificationsLive`, `null`
 *        while the settings read has not landed or has failed.
 */
export function visitNoticePreview(input: {
  action: VisitLifecycleAction;
  session: Pick<VisitLifecycleSession, 'kinfolkId' | 'kinCareBatchId' | 'kinCareVisitId' | 'sourceBookingId'>;
  hasPortalAccount: boolean | null;
  noticesLive: boolean | null;
}): VisitNoticePreview {
  if (TOLD_WHAT[input.action] === undefined) return { kind: 'none' };
  const { session } = input;
  if ((session.kinfolkId ?? '').trim() === '') {
    return { kind: 'will_not_notify', reason: 'session_has_no_kinfolk' };
  }
  const envelope = (session.kinCareBatchId ?? '').trim() !== '' && (session.kinCareVisitId ?? '').trim() !== '';
  if (!envelope && (session.sourceBookingId ?? '').trim() === '') {
    return { kind: 'will_not_notify', reason: 'session_has_no_routing_ids' };
  }
  if (input.hasPortalAccount === false) {
    return { kind: 'will_not_notify', reason: 'household_has_no_portal_account' };
  }
  if (input.hasPortalAccount === null) return { kind: 'unknown' };
  if (input.noticesLive === false) return { kind: 'will_not_notify', reason: 'household_notices_off' };
  if (input.noticesLive === null) return { kind: 'unknown' };
  return { kind: 'will_notify' };
}

/**
 * The confirm's line about the household, future tense, or `null` when the
 * confirm should say nothing about it (an undo, or a state not yet loaded).
 */
export function visitNoticeConfirmLine(
  preview: VisitNoticePreview,
  action: VisitLifecycleAction,
  household: string,
): string | null {
  const name = opening(household);
  switch (preview.kind) {
    case 'none':
    case 'unknown':
      return null;
    case 'will_notify':
      return `${name} will be told ${TOLD_WHAT[action] ?? 'about this step'}.`;
    case 'will_not_notify':
      switch (preview.reason) {
        case 'household_has_no_portal_account':
          return `${name} will not be told, because they have no portal account.`;
        case 'household_notices_off':
          return `${name} will not be told, because notices to households are off in Settings.`;
        case 'session_has_no_routing_ids':
          return `${name} will not be told, because this visit is not linked to a booking.`;
        case 'session_has_no_kinfolk':
          return 'No household will be told, because this visit is not linked to one.';
      }
  }
}

/** Whether a household record carries a linked portal login. `null` while it has not loaded. */
export function hasPortalAccount(kinfolk: { uid?: unknown } | null | undefined): boolean | null {
  if (kinfolk === undefined || kinfolk === null) return null;
  return typeof kinfolk.uid === 'string' && kinfolk.uid.trim() !== '';
}

/** {@link visitNoticePreview} then {@link visitNoticeConfirmLine}, for a dialog that wants the line. */
export function visitNoticeConfirmFor(
  input: Parameters<typeof visitNoticePreview>[0] & { household: string },
): string | null {
  return visitNoticeConfirmLine(visitNoticePreview(input), input.action, input.household);
}
