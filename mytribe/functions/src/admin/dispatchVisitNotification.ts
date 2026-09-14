import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { contentDedupeKey, enqueueNotification } from '../notifications/dispatcher';
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

export interface DispatchVisitNotificationOutcome {
  ok: true;
  dispatchIds: string[];
  suppressed: boolean;
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
  const recipientUid = family.primaryUid;
  if (!recipientUid) {
    throw new HttpsError(
      'failed-precondition',
      `families/${args.familyId} has no primaryUid, cannot route notification`,
    );
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

  const dispatchIds = await enqueueNotification({
    key,
    recipientUid,
    data,
    actorUid,
    dedupeKey: visitDedupeKey(visitId, args),
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATION_DISPATCHED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid,
    familyId: args.familyId,
    payload: { key, batchId, visitId, event: args.event, dispatchIds },
  });

  logEvent({
    severity: 'info',
    function: 'dispatchVisitNotification',
    event: 'visit.notification.dispatched',
    uid: actorUid,
    extra: { key, familyId: args.familyId, batchId, visitId, dispatchCount: dispatchIds.length },
  });

  return { ok: true, dispatchIds, suppressed: dispatchIds.length === 0 };
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
