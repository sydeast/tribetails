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
 * #1840: THE CONFIRM ASKS THE SERVER. It used to predict from `kinfolk.uid` on
 * the roster, which is a field any client record listing the household can
 * stamp: on an unclaimed demo household it held the Admin's own login, so the
 * confirm promised a notice and the notice went to the Admin. Whether a
 * household has a portal sign-in is a membership question only the server can
 * answer (`previewVisitNotification`, the same check the dispatch makes), so
 * the confirm waits for that answer and says it is checking meanwhile.
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
 * Why the household switch stopped this notice, as the end of the sentence
 * (#2185). The owner's line says where to change it. An Auntie never sees
 * Settings (ruling 2026-11-13), so her line says who can.
 */
function noticesOffBecause(auntie: boolean): string {
  return auntie
    ? 'because the owner has notices to households turned off.'
    : 'because notices to households are off in Settings.';
}

/**
 * The sentence the card shows once the notification has settled, or `''` when
 * there is nothing to say about the household (an undo, which never notifies,
 * or a double tap that wrote nothing).
 *
 * @param auntie an Auntie is signed in (`useIsAuntie`); only the Settings
 *        line changes.
 */
export function visitNoticeOutcomeSentence(
  outcome: { notified: boolean; notifySkipped: string | null },
  household: string,
  auntie = false,
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
      return `${name} was not notified, ${noticesOffBecause(auntie)}`;
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

/**
 * What the server said about reaching this household (#1840), as the confirm
 * holds it: still asking, no usable answer, or the answer.
 */
export type VisitNoticeReach =
  | { status: 'checking' }
  /** The call failed, or a server that predates the preview answered. */
  | { status: 'unknown' }
  | { status: 'ready'; willNotify: boolean; reason: string | null };

/** What the confirm can honestly say before the tap. */
export type VisitNoticePreview =
  /** The action tells nobody anything (undo). The confirm says nothing about it. */
  | { kind: 'none' }
  /** The server is being asked. The confirm says so. */
  | { kind: 'checking' }
  /** No usable answer: neither promise nor reason. */
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
 * Why this visit cannot be routed to a household at all, read off the row, or
 * `null` when it can. Nothing to ask the server in either refused case.
 */
export function visitRoutingSkip(
  session: Pick<VisitLifecycleSession, 'kinfolkId' | 'kinCareBatchId' | 'kinCareVisitId' | 'sourceBookingId'>,
): 'session_has_no_kinfolk' | 'session_has_no_routing_ids' | null {
  if ((session.kinfolkId ?? '').trim() === '') return 'session_has_no_kinfolk';
  const envelope = (session.kinCareBatchId ?? '').trim() !== '' && (session.kinCareVisitId ?? '').trim() !== '';
  if (!envelope && (session.sourceBookingId ?? '').trim() === '') return 'session_has_no_routing_ids';
  return null;
}

/** Whether this action tells the household anything, so whether there is a question to ask. */
export function actionNotifiesHousehold(action: VisitLifecycleAction): boolean {
  return TOLD_WHAT[action] !== undefined;
}

/**
 * PURE. Whether this tap can reach the household: the row's own routing first,
 * then the server's answer.
 *
 * @param reach what `previewVisitNotification` said for this household. Its
 *        two reasons arrive already in the shared order (no portal account
 *        before the switch).
 */
export function visitNoticePreview(input: {
  action: VisitLifecycleAction;
  session: Pick<VisitLifecycleSession, 'kinfolkId' | 'kinCareBatchId' | 'kinCareVisitId' | 'sourceBookingId'>;
  reach: VisitNoticeReach;
}): VisitNoticePreview {
  if (!actionNotifiesHousehold(input.action)) return { kind: 'none' };
  const skip = visitRoutingSkip(input.session);
  if (skip !== null) return { kind: 'will_not_notify', reason: skip };
  const { reach } = input;
  if (reach.status === 'checking') return { kind: 'checking' };
  if (reach.status === 'unknown') return { kind: 'unknown' };
  if (reach.willNotify) return { kind: 'will_notify' };
  if (reach.reason === 'household_has_no_portal_account' || reach.reason === 'household_notices_off') {
    return { kind: 'will_not_notify', reason: reach.reason };
  }
  // A reason this build has no words for. It promises nothing.
  return { kind: 'unknown' };
}

/**
 * The confirm's line about the household, future tense, or `null` when the
 * confirm should say nothing about it (an undo, or no usable answer).
 */
export function visitNoticeConfirmLine(
  preview: VisitNoticePreview,
  action: VisitLifecycleAction,
  household: string,
  auntie = false,
): string | null {
  const name = opening(household);
  switch (preview.kind) {
    case 'none':
    case 'unknown':
      return null;
    case 'checking':
      return household === '' ? 'Checking who will be told.' : `Checking whether ${household} will be told.`;
    case 'will_notify':
      return `${name} will be told ${TOLD_WHAT[action] ?? 'about this step'}.`;
    case 'will_not_notify':
      switch (preview.reason) {
        case 'household_has_no_portal_account':
          return `${name} will not be told, because they have no portal account.`;
        case 'household_notices_off':
          return `${name} will not be told, ${noticesOffBecause(auntie)}`;
        case 'session_has_no_routing_ids':
          return `${name} will not be told, because this visit is not linked to a booking.`;
        case 'session_has_no_kinfolk':
          return 'No household will be told, because this visit is not linked to one.';
      }
  }
}

/** {@link visitNoticePreview} then {@link visitNoticeConfirmLine}, for a dialog that wants the line. */
export function visitNoticeConfirmFor(
  input: Parameters<typeof visitNoticePreview>[0] & { household: string; auntie?: boolean },
): string | null {
  return visitNoticeConfirmLine(visitNoticePreview(input), input.action, input.household, input.auntie === true);
}
