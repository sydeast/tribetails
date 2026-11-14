import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { getNotificationDef } from './catalog';
import {
  enqueueNotificationDetailed,
  previewHouseholdCopy,
  type EnqueueOutcome,
} from './dispatcher';
import type { Channel, EnqueueArgs } from './types';
import type { HouseholdNotice, HouseholdNoticeReason } from '../admin/dispatchVisitNotification';

/**
 * #1816, #1838, #2027, #1841: WHETHER, AND HOW, THE HOUSEHOLD IS TOLD, said by
 * the server before an admin action (the confirm) and after it (the toast).
 *
 * The walk found four admin actions whose confirm and toast said nothing true
 * about the household: a KinTale send promised "Kinfolk will hear from you
 * soon" with household notices off, a cancel emailed the household and said
 * nothing, a move and a note sent email with no word on screen, and New visit
 * sent nothing and said nothing.
 *
 * #1805 and #2108 fixed the same gap for the three clock taps only, through
 * `previewVisitNotification` (familyId alone, so no channels and no prefs).
 * This is the general form: one notification key, one household login.
 *
 *   PREVIEW (`previewHouseholdNotice`): the login `resolveKinfolkUid` gives the
 *   dispatch, then the dispatcher's own dry run (`previewHouseholdCopy`: the
 *   household audience, prefs, channels, the send gate). Read-only.
 *
 *   RESULT (`householdNoticeFromOutcome`): the dispatcher's per-recipient
 *   report for that same login: written (and on which channels), or why not.
 *
 * Both name the person: the member's own display name, else the household's
 * name, never an email address and never an id.
 *
 * Loaded lazily by every caller (`await import(...)`), so it adds no module to
 * the cold-start graph (`test/coldStartImportGraph.test.ts`).
 */

// The wire shape and its reasons live with `previewVisitNotification`, a
// module already in the cold-start graph, so the callables that return a
// notice can name its schema at file scope without adding one.
export {
  HOUSEHOLD_NOTICE_REASONS,
  HouseholdNoticeSchema,
  type HouseholdNotice,
  type HouseholdNoticeReason,
} from '../admin/dispatchVisitNotification';

/** What a confirm may say, BEFORE the action. Same fields, future tense. */
export interface HouseholdNoticePreview {
  willNotify: boolean;
  reason: Extract<
    HouseholdNoticeReason,
    | 'not_a_household_notice'
    | 'household_has_no_portal_account'
    | 'household_prefs_suppressed'
    | 'household_notices_off'
    | 'session_has_no_routing_ids'
  > | null;
  name: string | null;
  channels: Channel[];
}

function words(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** An address is not a name (BUILDER-RULES: no emails-as-names on screen). */
function asName(raw: string): string | null {
  return raw === '' || raw.includes('@') ? null : raw;
}

/**
 * The person the notice is addressed to, as the admin knows them: the member
 * login's own display name, else the household's name on its record. Never
 * the id `resolveKinfolkDisplayName` falls back to, never an email.
 */
export async function householdNoticeName(familyId: string, recipientUid: string | null): Promise<string | null> {
  try {
    if (recipientUid !== null) {
      const client = (await db().collection('clients').doc(recipientUid).get()).data() as
        | Record<string, unknown>
        | undefined;
      const own =
        asName(words(client?.['displayName'])) ??
        asName([words(client?.['firstName']), words(client?.['lastName'])].filter(Boolean).join(' '));
      if (own !== null) return own;
    }
    const kinfolk = (await db().collection('kinfolk').doc(familyId).get()).data() as
      | Record<string, unknown>
      | undefined;
    return (
      asName(words(kinfolk?.['kinfolkName'])) ??
      asName([words(kinfolk?.['firstName']), words(kinfolk?.['lastName'])].filter(Boolean).join(' '))
    );
  } catch {
    return null;
  }
}

/**
 * Which channels the login can be reached on at all. The email and SMS senders
 * skip a login with no address on file (`senders/emailChannel.ts`
 * `recipient_no_email`, `senders/smsChannel.ts`), so a channel the prefs leave
 * on is not a send without one. Push stays: its tokens live on devices, and
 * the record in the notifications list is written either way.
 */
export interface HouseholdReach {
  email: boolean;
  sms: boolean;
}

export async function householdReach(recipientUid: string | null): Promise<HouseholdReach> {
  if (recipientUid === null) return { email: false, sms: false };
  try {
    const client = (await db().collection('clients').doc(recipientUid).get()).data() as
      | Record<string, unknown>
      | undefined;
    return { email: words(client?.['email']) !== '', sms: words(client?.['phone']) !== '' };
  } catch {
    // Unreadable: say what the prefs say rather than invent a missing address.
    return { email: true, sms: true };
  }
}

/** PURE. The channels a copy really goes out on: the prefs' list, less one with no address. */
export function reachableChannels<C extends string>(channels: readonly C[], reach: HouseholdReach): C[] {
  return channels.filter((c) => (c === 'email' ? reach.email : c === 'sms' ? reach.sms : true));
}

/** True when [key] can reach a household at all. Unknown keys throw, as the dispatcher does. */
export function isHouseholdKey(key: string): boolean {
  const def = getNotificationDef(key);
  if (def.external === true || def.audiences.kinfolk !== true) return false;
  const resolvers = [def.recipientResolver, def.secondaryResolver];
  return resolvers.includes('kinfolkAcct') || resolvers.includes('specificUid');
}

/**
 * The confirm's answer for one household and one notification key. The same
 * order the dispatch decides in: the key, the member login, prefs, the gate.
 */
export async function previewHouseholdNotice(familyId: string, key: string): Promise<HouseholdNoticePreview> {
  if (!isHouseholdKey(key)) {
    return { willNotify: false, reason: 'not_a_household_notice', name: await householdNoticeName(familyId, null), channels: [] };
  }
  const recipientUid = await resolveKinfolkUid(familyId);
  const name = await householdNoticeName(familyId, recipientUid);
  if (recipientUid === null) {
    return { willNotify: false, reason: 'household_has_no_portal_account', name, channels: [] };
  }
  const copy = await previewHouseholdCopy(key, recipientUid);
  switch (copy.kind) {
    case 'not_household':
      return { willNotify: false, reason: 'not_a_household_notice', name, channels: [] };
    case 'prefs':
      return { willNotify: false, reason: 'household_prefs_suppressed', name, channels: [] };
    case 'gate':
      return { willNotify: false, reason: 'household_notices_off', name, channels: [] };
    case 'send':
      return {
        willNotify: true,
        reason: null,
        name,
        channels: reachableChannels(copy.channels, await householdReach(recipientUid)),
      };
  }
}

/**
 * PURE. What happened to the household's copy, read off the dispatcher's own
 * report for that login. Another audience's copy (the office's, on a key that
 * goes to both) is not the household's and is not counted.
 */
export function householdNoticeFromOutcome(
  outcome: Pick<EnqueueOutcome, 'written' | 'suppressed' | 'channelsByRecipient'>,
  recipientUid: string | null,
  name: string | null,
  /** Which channels the login has an address for (`householdReach`); all of them when not given. */
  reach: HouseholdReach = { email: true, sms: true },
): HouseholdNotice {
  if (recipientUid === null) return { told: false, reason: 'household_has_no_portal_account', name, channels: [] };
  const channels = outcome.channelsByRecipient?.[recipientUid];
  if (channels !== undefined) return { told: true, reason: null, name, channels: reachableChannels(channels, reach) };
  const held = outcome.suppressed.find((s) => s.recipientUid === recipientUid);
  if (held?.reason === 'gate') return { told: false, reason: 'household_notices_off', name, channels: [] };
  if (held?.reason === 'prefs') return { told: false, reason: 'household_prefs_suppressed', name, channels: [] };
  if (held?.reason === 'duplicate') return { told: false, reason: 'already_notified', name, channels: [] };
  return { told: false, reason: 'no_recipient', name, channels: [] };
}

/** A household notice that was never attempted, with the reason and the name. */
export async function householdNoticeNotSent(
  familyId: string,
  reason: HouseholdNoticeReason,
): Promise<HouseholdNotice> {
  return { told: false, reason, name: await householdNoticeName(familyId, null), channels: [] };
}

/**
 * The household notices the admin actions send through `sendHouseholdNotice`,
 * by catalog key, and where each is sent from (`provenance.ts` names this file):
 *
 *   kincare.booking.cancel   transitionBookingStatus CANCEL, batchUpdateBookings CANCEL (#1838)
 *   kincare.changed          rescheduleBooking, the move and the Schedule drag (#2027)
 *   kincare.booking.confirm  createKinCareSession with `notifyHousehold` (#1841)
 *   kintale.published        onKinTaleUpdate, a KinTale the web composer sent (#1816)
 */
export type HouseholdNoticeKey =
  | 'kincare.booking.cancel'
  | 'kincare.changed'
  | 'kincare.booking.confirm'
  | 'kintale.published';
/**
 * Send [args.key] to the household of [familyId] (and, on a key that goes to
 * both, to the office as the dispatch always does) and say what happened to
 * the household's copy. Never throws: a failed send is `dispatch_failed`.
 */
export async function sendHouseholdNotice(
  familyId: string,
  args: Omit<EnqueueArgs, 'recipientUid' | 'key'> & { key: HouseholdNoticeKey },
  caller: string,
): Promise<HouseholdNotice> {
  let recipientUid: string | null = null;
  let name: string | null = null;
  try {
    recipientUid = await resolveKinfolkUid(familyId);
    name = await householdNoticeName(familyId, recipientUid);
    const outcome = await enqueueNotificationDetailed({ ...args, recipientUid: recipientUid ?? '' });
    return householdNoticeFromOutcome(outcome, recipientUid, name, await householdReach(recipientUid));
  } catch (err) {
    const noOne = (err as { name?: unknown } | null)?.name === 'NoRecipientsError';
    logEvent({
      severity: noOne ? 'info' : 'warn',
      function: caller,
      event: noOne ? 'household.notice.no_recipient' : 'household.notice.failed',
      extra: { familyId, key: args.key },
      errorMessage: (err as Error)?.message,
    });
    if (noOne && recipientUid === null) {
      return { told: false, reason: 'household_has_no_portal_account', name, channels: [] };
    }
    return { told: false, reason: noOne ? 'no_recipient' : 'dispatch_failed', name, channels: [] };
  }
}

/**
 * #1838/#2027: the stamp a server write puts on a household's visit when that
 * write's own caller sends the household notice inline, so `onBookingsWrite`
 * does not send it a second time. A FRESH value per write: the trigger skips
 * only when the stamp CHANGED in the write it is reading, so a later write by
 * anyone else (the portal, a batch edit, an older client) still sends.
 */
export const OFFICE_NOTICE_STAMP_FIELD = 'officeNoticeStamp';

export function freshOfficeNoticeStamp(nowMs: number = Date.now()): string {
  return `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
}

function millisOf(raw: unknown): number | null {
  const ts = raw as { toMillis?: () => number } | null | undefined;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

/**
 * Send a per-visit household notice from a callable, with the same data,
 * target and dedupe shape `onBookingsWrite` gives the key, so the templates
 * and the household's notice line (#2262) read it as they read the trigger's.
 * The dedupe key is named by the office notice stamp the same write carried.
 */
export async function sendVisitHouseholdNotice(input: {
  key: 'kincare.booking.cancel' | 'kincare.changed';
  kinfolkId: string;
  batchId: string;
  visitId: string;
  /** The household's visit as the write left it. */
  visit: Record<string, unknown>;
  officeNoticeStamp: string;
  extra?: Record<string, unknown>;
  actorUid: string;
  caller: string;
}): Promise<HouseholdNotice> {
  const v = input.visit;
  const serviceName = words(v['serviceName']) || words(v['serviceType']) || words(v['title']) || null;
  return sendHouseholdNotice(
    input.kinfolkId,
    {
      key: input.key,
      data: {
        kinfolkId: input.kinfolkId,
        batchId: input.batchId,
        // `bookingId` retained for notification-template back-compat; the visit id, as the trigger sends.
        bookingId: input.visitId,
        visitId: input.visitId,
        serviceName,
        startTimeMs: millisOf(v['startTime']),
        ...(input.extra ?? {}),
      },
      actorUid: input.actorUid,
      targetType: 'booking',
      targetId: input.visitId,
      dedupeKey: `booking:${input.visitId}:${input.key}:office:${input.officeNoticeStamp}`,
    },
    input.caller,
  );
}

/**
 * #1838/#2027 review: the confirm for a cancel or a move of ONE visit, with
 * the visit's own checks the send makes, before the household's:
 *
 *   - the session must name its booking record (`kinfolkId`, `kinCareBatchId`,
 *     `kinCareVisitId`) and that record must exist; otherwise the cancel or the
 *     move reaches nobody (`session_has_no_routing_ids`), as in
 *     `transitionBookingStatus#visitMirrorFor` and `visitTimeMirror`;
 *   - a cancel of a visit already finished sends nothing either;
 *   - a move tells the household only while the visit is confirmed
 *     (`visitTellsHouseholdOfChanges`), else `not_a_household_notice`.
 *
 * Then the household, through `previewHouseholdNotice`, as the send does.
 */
export async function previewVisitHouseholdNotice(
  sessionId: string,
  key: 'kincare.booking.cancel' | 'kincare.changed',
): Promise<HouseholdNoticePreview & { familyId: string | null }> {
  const session = ((await db().collection('kin_care_sessions').doc(sessionId).get()).data() ?? {}) as Record<
    string,
    unknown
  >;
  const familyId = words(session['kinfolkId']);
  const batchId = words(session['kinCareBatchId']);
  const visitId = words(session['kinCareVisitId']);
  const nobody = async (
    reason: 'session_has_no_routing_ids' | 'not_a_household_notice',
  ): Promise<HouseholdNoticePreview & { familyId: string | null }> => ({
    willNotify: false,
    reason,
    name: familyId === '' ? null : await householdNoticeName(familyId, null),
    channels: [],
    familyId: familyId === '' ? null : familyId,
  });
  if (familyId === '' || batchId === '' || visitId === '') return nobody('session_has_no_routing_ids');
  const visitSnap = await db().doc(`families/${familyId}/bookings/${batchId}/kinCares/${visitId}`).get();
  const visit = (visitSnap.data() ?? {}) as Record<string, unknown>;
  const status = words(visit['status']);
  if (!visitSnap.exists) return nobody('session_has_no_routing_ids');
  if (key === 'kincare.booking.cancel' && (status === 'cancelled' || status === 'completed')) {
    return nobody('session_has_no_routing_ids');
  }
  if (key === 'kincare.changed' && !visitTellsHouseholdOfChanges(visit)) return nobody('not_a_household_notice');
  return { ...(await previewHouseholdNotice(familyId, key)), familyId };
}

/** The two statuses on which `onBookingsWrite` tells the household a visit changed. */
export function visitTellsHouseholdOfChanges(visit: Record<string, unknown>): boolean {
  const status = words(visit['status']);
  return status === 'confirmed' || status === 'approved';
}
