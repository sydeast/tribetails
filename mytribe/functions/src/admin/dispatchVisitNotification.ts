import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import {
  contentDedupeKey,
  enqueueNotificationDetailed,
  type EnqueueOutcome,
} from '../notifications/dispatcher';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { logEvent } from '../lib/logger';
import { resolveKinCareRef } from '../lib/resolveKinCareRef';
import { TRIBETAILS_CORS } from '../lib/cors';

const EventArg = z.enum(['on_my_way', 'arrived', 'departed', 'report_sent']);

const Args = z
  .object({
    familyId: z.string().min(1),
    batchId: z.string().min(1).optional(),
    visitId: z.string().min(1).optional(),
    /** Legacy flat id, accepted for back-compat mid-migration. */
    bookingId: z.string().min(1).optional(),
    event: EventArg,
    etaMinutes: z.number().int().nonnegative().optional(),
    reportPreviewUrl: z.string().url().optional(),
    /**
     * When the lifecycle step happened (ms epoch): the `onMyWayAt` / `arrivedAt`
     * / `departedAt` the caller just stamped. Every live caller sends it (the
     * web admin's lifecycle patch, `setVisitLifecycle`, Android `VisitNotifier`),
     * and it is what tells a re-arrival from a retry of the first (#832).
     * Optional so an older client still dispatches.
     */
    eventAtMs: z.number().int().nonnegative().optional(),
    /**
     * The KinTale a `report_sent` announces. Two reports for one visit are two
     * notifications; a retry of one report is one (#832).
     */
    reportId: z.string().min(1).max(200).optional(),
  })
  .refine((a) => (a.batchId && a.visitId) || a.bookingId, {
    message: 'Provide batchId+visitId (preferred) or a legacy bookingId.',
  });

/** Exported so `setVisitLifecycle` can name what it hands `dispatchVisitNotificationCore`. */
export type Args = z.infer<typeof Args>;

const EVENT_TO_KEY: Record<z.infer<typeof EventArg>, string> = {
  on_my_way: 'kincare.auntie.on_my_way',
  arrived: 'kincare.auntie.arrived',
  departed: 'kincare.auntie.departed',
  report_sent: 'kincare.report.sent',
};

/**
 * #832: the dispatcher identity of one visit notification. All of them target
 * the visit, so without this an Auntie's second "on my way" with a new ETA, or
 * an arrival after an undone arrival, inside the dispatcher window was dropped.
 *
 * Named by the step and what it says: the ETA, the step's stamped time, and
 * for a report the report id (or its link from an older client). A retry of one
 * tap carries the same stamped time and dedupes; a re-arrival carries a new one
 * and sends.
 */
export function visitDedupeKey(
  visitId: string,
  args: Pick<Args, 'event' | 'etaMinutes' | 'eventAtMs' | 'reportPreviewUrl' | 'reportId'>,
): string {
  return contentDedupeKey(`visit:${visitId}:${args.event}`, {
    eta: args.etaMinutes ?? null,
    at: args.eventAtMs ?? null,
    report: args.reportId ?? args.reportPreviewUrl ?? null,
  });
}

/**
 * #1794: why a visit notification reached nobody, by name.
 *
 * Every one of these is an ordinary state, not a failure, and the callers turn
 * each into a sentence the operator reads on the card (web
 * `lib/visitNotice.ts`, Android `domain/VisitNoticeWords.kt`). Before #1794 the
 * first one was a thrown `failed-precondition` that reached Sentry on every tap
 * for a household with no portal sign-in, and the other three were folded into
 * one `suppressed: true` that every client read as "prefs".
 *
 *   household_has_no_portal_account  nobody in the household has signed in to
 *                                    the portal, so there is no account to send to.
 *   household_notices_off            the pre-launch switch
 *                                    (`business_settings.householdNotificationsLive`)
 *                                    held the copy back.
 *   household_prefs_suppressed       this notice is turned off for the household.
 *   already_notified                 the same step already reached them (#832).
 *   no_recipient                     the dispatcher resolved nobody at all.
 *
 * THE ORDER IS FIXED AND SHARED WITH BOTH CLIENTS' CONFIRM TEXT: a household
 * with no portal account is named for that first, because turning the switch
 * on would not reach them either. Only a household that HAS an account is told
 * the switch is off.
 */
export const VISIT_NOTICE_REASONS = [
  'household_has_no_portal_account',
  'household_notices_off',
  'household_prefs_suppressed',
  'already_notified',
  'no_recipient',
] as const;
export type VisitNoticeReason = (typeof VISIT_NOTICE_REASONS)[number];

export interface DispatchVisitNotificationOutcome {
  ok: true;
  dispatchIds: string[];
  /** True when nobody was told. Kept beside `reason` because older Android builds read only this. */
  suppressed: boolean;
  /** Why nobody was told, or null when a notification record was written. */
  reason: VisitNoticeReason | null;
}

/**
 * PURE. The reason a dispatch wrote nothing, read off the dispatcher's own
 * per-recipient report. `gate` wins because it applies to every household at
 * once; `prefs` and `duplicate` follow.
 */
export function visitNoticeReasonFor(
  outcome: Pick<EnqueueOutcome, 'written' | 'suppressed'>,
): VisitNoticeReason | null {
  if (outcome.written.length > 0) return null;
  const reasons = new Set(outcome.suppressed.map((s) => s.reason));
  if (reasons.has('gate')) return 'household_notices_off';
  if (reasons.has('prefs')) return 'household_prefs_suppressed';
  if (reasons.has('duplicate')) return 'already_notified';
  return 'no_recipient';
}

/**
 * Who in the household receives the notice (#1794).
 *
 * `families/{id}.primaryUid` first, because that is the field this callable has
 * always routed on. But no sign-up path fills it: every `families` writer
 * (`familyProvision`, `inviteKinfolkToPortal`, `provisionTribe`, `mintInvite`)
 * writes `''`, and only the foundation-v1 migration copied a real uid in. The
 * household's portal login is recorded on `kinfolk/{id}.uid` by the
 * `onClientsWrite` backwrite, and that is what every other household
 * notification resolves through (`resolveKinfolkUid`). The family envelope is
 * keyed by the same id as the kinfolk doc (`familyProvision.ts`).
 *
 * It is also the only account field either admin client holds, so it is what
 * their confirm text predicts from. Routing on a field the clients cannot see
 * would let a confirm say "will be told" over an outcome of "no portal account".
 */
async function householdRecipientUid(
  familyId: string,
  primaryUid: string | undefined,
): Promise<string | null> {
  const primary = typeof primaryUid === 'string' ? primaryUid.trim() : '';
  if (primary !== '') return primary;
  return resolveKinfolkUid(familyId);
}

/**
 * The dispatch itself, lifted out of the callable wrapper so a SECOND server
 * path can reach it (#397 L19).
 *
 * WHY IT WAS LIFTED. On Android the household message is a CLIENT decision:
 * `HomeViewModel.onMyWay/arrived/departed` each call `VisitNotifier`, which
 * calls the callable below. Nothing on `kin_care_sessions` triggers on a write,
 * so a lifecycle transition made anywhere ELSE notifies nobody. The web admin's
 * `setVisitLifecycle` therefore dispatches server-side, in the same call that
 * moves the status, rather than asking the browser to make a second one that a
 * closed tab or a failed round-trip would skip.
 *
 * `actorDisplayNameFallback` is what the callable used to read straight off
 * `req.auth.token.name`; a non-callable caller passes its own or nothing.
 */
export async function dispatchVisitNotificationCore(
  args: Args,
  actorUid: string,
  actorDisplayNameFallback?: string | undefined,
): Promise<DispatchVisitNotificationOutcome> {
  const resolved = await resolveKinCareRef({
    familyId: args.familyId,
    batchId: args.batchId,
    visitId: args.visitId,
    bookingId: args.bookingId,
  });
  if (!resolved) {
    throw new HttpsError('not-found', `kinCare for family ${args.familyId} not found`);
  }
  const bookingSnap = await resolved.ref.get();
  if (!bookingSnap.exists) {
    throw new HttpsError('not-found', `kinCare for family ${args.familyId} not found`);
  }
  const booking = bookingSnap.data() as {
    serviceType?: string;
    scheduledAtMs?: number;
    kinfolkId?: string;
  };
  const visitId = resolved.visitId;
  const batchId = resolved.batchId;

  const familySnap = await db().doc(`families/${args.familyId}`).get();
  if (!familySnap.exists) {
    throw new HttpsError('not-found', `families/${args.familyId} not found`);
  }
  const family = familySnap.data() as { primaryUid?: string; displayName?: string };
  const recipientUid = await householdRecipientUid(args.familyId, family.primaryUid);
  if (!recipientUid) {
    // #1794: a household nobody has signed in for is a normal state, not a
    // failure. This used to throw `failed-precondition`, which every client
    // logged as a failed dispatch and Sentry recorded on every tap.
    logEvent({
      severity: 'info',
      function: 'dispatchVisitNotification',
      event: 'visit.notification.skipped',
      uid: actorUid,
      extra: {
        familyId: args.familyId,
        batchId,
        visitId,
        event: args.event,
        reason: 'household_has_no_portal_account',
      },
    });
    return { ok: true, dispatchIds: [], suppressed: true, reason: 'household_has_no_portal_account' };
  }

  const [recipientSnap, actorSnap] = await Promise.all([
    db().doc(`clients/${recipientUid}`).get(),
    db().doc(`staff/${actorUid}`).get(),
  ]);
  const recipientDisplayName =
    (recipientSnap.data() as { displayName?: string } | undefined)?.displayName ?? null;
  const auntieDisplayName =
    (actorSnap.data() as { displayName?: string } | undefined)?.displayName ??
    actorDisplayNameFallback ??
    'Your Auntie';

  const key = EVENT_TO_KEY[args.event];
  const data: Record<string, unknown> = {
    familyId: args.familyId,
    batchId,
    // `bookingId` retained for notification-template back-compat; now the visit id.
    bookingId: visitId,
    visitId,
    event: args.event,
    serviceType: booking.serviceType ?? null,
    scheduledAtMs: booking.scheduledAtMs ?? null,
    auntieDisplayName,
    recipientDisplayName,
  };
  if (args.etaMinutes !== undefined) data.etaMinutes = args.etaMinutes;
  if (args.reportPreviewUrl) data.reportPreviewUrl = args.reportPreviewUrl;

  const enqueued = await enqueueNotificationDetailed({
    key,
    recipientUid,
    data,
    actorUid,
    dedupeKey: visitDedupeKey(visitId, args),
  });
  const dispatchIds = enqueued.written;
  const reason = visitNoticeReasonFor(enqueued);

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATION_DISPATCHED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid,
    familyId: args.familyId,
    payload: { key, batchId, visitId, event: args.event, dispatchIds, reason },
  });

  logEvent({
    severity: 'info',
    function: 'dispatchVisitNotification',
    event: 'visit.notification.dispatched',
    uid: actorUid,
    extra: { key, familyId: args.familyId, batchId, visitId, dispatchCount: dispatchIds.length, reason },
  });

  return { ok: true, dispatchIds, suppressed: dispatchIds.length === 0, reason };
}

export async function dispatchVisitNotificationHandler(
  req: CallableRequest<unknown>,
): Promise<DispatchVisitNotificationOutcome> {
  const args: Args = Args.parse(req.data);
  return dispatchVisitNotificationCore(args, req.auth!.uid, req.auth?.token?.name);
}

export const dispatchVisitNotification = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('dispatchVisitNotification', dispatchVisitNotificationHandler),
);
