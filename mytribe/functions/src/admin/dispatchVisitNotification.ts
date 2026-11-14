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
import { loadHouseholdSendGate } from '../notifications/householdSendGate';
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
 * Who in the household receives the notice (#1794, #1802, #1840): a login
 * that is an ACTIVE member of the household, as `resolveKinfolkUid` confirms
 * it (the login on `kinfolk/{id}.uid` when it is a member, the household's
 * ACTIVE PRIMARY when it is not, nobody when the household has no such
 * member). Every other household notification resolves through the same
 * function. The family envelope is keyed by the same id as the kinfolk doc.
 *
 * #1805 routed on `kinfolk.uid` alone. That field is a backwrite any client
 * record listing the household can stamp, and on an unclaimed demo household
 * it held the Admin's own login, so the Admin was sent the household's notice
 * and the card said the household had been told (#1840).
 *
 * NOT `families/{id}.primaryUid`, which no sign-up path fills, and NOT as a
 * fallback either: `revokeKinfolkClaim` unlinks a login by blanking
 * `kinfolk.uid` and never touches `primaryUid`, so a fallback would keep
 * sending to a revoked login.
 */
async function householdRecipientUid(familyId: string): Promise<string | null> {
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
 * #2037: THAT IS NO LONGER TRUE. `triggers/onKinCareSessionLifecycle.ts`
 * reads every session write and sends each clock step from the server, through
 * `lib/visitStepNotice.ts#announceVisitStep`, which calls this. The admin
 * clients no longer dispatch a clock step themselves. The callable below stays
 * for a KinTale (`report_sent`) and for installed clients from before #2037,
 * whose clock dispatch carries the same dedupe key and so is the duplicate.
 *
 * `actorDisplayNameFallback` is what the callable used to read straight off
 * `req.auth.token.name`; a non-callable caller passes its own or nothing.
 */
export async function dispatchVisitNotificationCore(
  args: Args,
  actorUid: string,
  actorDisplayNameFallback?: string | undefined,
  opts: {
    /**
     * #2037: a fixed id for the "notice dispatched" line, so the trigger and
     * `setVisitLifecycle` reaching the same clock step write it once.
     */
    auditDocId?: string;
    /**
     * #2037: how far back the duplicate check looks. The clock trigger passes a
     * day: its key names the step's stamped time, so a late redelivery is the
     * same step and a re-arrival is a new one whatever the window.
     */
    dedupeWindowMs?: number;
  } = {},
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
  const recipientUid = await householdRecipientUid(args.familyId);
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

  // #2037: the clock trigger may not know who made the write. With no actor
  // there is no staff record to read, and the notice says "Your Auntie".
  const [recipientSnap, actorSnap] = await Promise.all([
    db().doc(`clients/${recipientUid}`).get(),
    actorUid !== '' ? db().doc(`staff/${actorUid}`).get() : Promise.resolve(null),
  ]);
  const recipientDisplayName =
    (recipientSnap.data() as { displayName?: string } | undefined)?.displayName ?? null;
  const auntieDisplayName =
    (actorSnap?.data() as { displayName?: string } | undefined)?.displayName ??
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
    ...(opts.dedupeWindowMs !== undefined ? { dedupeWindowMs: opts.dedupeWindowMs } : {}),
  });
  const dispatchIds = enqueued.written;
  const reason = visitNoticeReasonFor(enqueued);

  // #2037: a step the household already heard about dispatched nothing, so it
  // writes no "dispatched" line. Since the server sends each clock step itself,
  // that is what an installed client from before #2037 reaches when it still
  // dispatches after its write, and a second line would be a second claim.
  if (reason !== 'already_notified') {
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.NOTIFICATION_DISPATCHED,
      severity: 'info',
      actorRole: actorUid !== '' ? 'AUNTIE' : 'SYSTEM',
      ...(actorUid !== '' ? { actorUid } : {}),
      familyId: args.familyId,
      payload: { key, batchId, visitId, event: args.event, dispatchIds, reason },
      ...(opts.auditDocId !== undefined ? { docId: opts.auditDocId } : {}),
    });
  }

  logEvent({
    severity: 'info',
    function: 'dispatchVisitNotification',
    event: 'visit.notification.dispatched',
    ...(actorUid !== '' ? { uid: actorUid } : {}),
    extra: { key, familyId: args.familyId, batchId, visitId, dispatchCount: dispatchIds.length, reason },
  });

  return { ok: true, dispatchIds, suppressed: dispatchIds.length === 0, reason };
}

/** Why a confirm may not promise the household a notice, or null when it may. */
export type VisitNoticePreviewReason = Extract<
  VisitNoticeReason,
  'household_has_no_portal_account' | 'household_notices_off'
>;

export interface PreviewVisitNotificationOutcome {
  ok: true;
  /** True when a visit notice for this household would be handed to the dispatcher and pass the switch. */
  willNotify: boolean;
  reason: VisitNoticePreviewReason | null;
}

const PreviewArgs = z.object({ familyId: z.string().trim().min(1) });

/**
 * #1840: what a clock confirm may say about the household BEFORE the tap,
 * answered by the server with the same two checks the dispatch makes, in the
 * same order (`VISIT_NOTICE_REASONS`): is there a member login to send to, and
 * is the household-notices switch on.
 *
 * The admin clients used to predict this from `kinfolk.uid` on the record they
 * already held. That is the field #1840 found holding the Admin's own login on
 * a household nobody had claimed, and no client can check membership itself.
 *
 * Read-only. It does not predict a notice the household turned off for
 * themselves or a repeat of a step already sent; the result line, which is the
 * dispatch's own answer, names those.
 */
export async function previewVisitNotificationHandler(
  req: CallableRequest<unknown>,
): Promise<PreviewVisitNotificationOutcome> {
  const { familyId } = PreviewArgs.parse(req.data);
  const recipientUid = await householdRecipientUid(familyId);
  if (!recipientUid) {
    return { ok: true, willNotify: false, reason: 'household_has_no_portal_account' };
  }
  const gate = await loadHouseholdSendGate(db());
  if (!gate.live) return { ok: true, willNotify: false, reason: 'household_notices_off' };
  return { ok: true, willNotify: true, reason: null };
}

export const previewVisitNotification = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('previewVisitNotification', previewVisitNotificationHandler),
);

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
