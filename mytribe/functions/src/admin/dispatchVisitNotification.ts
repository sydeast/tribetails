import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { enqueueNotification } from '../notifications/dispatcher';
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
  })
  .refine((a) => (a.batchId && a.visitId) || a.bookingId, {
    message: 'Provide batchId+visitId (preferred) or a legacy bookingId.',
  });

type Args = z.infer<typeof Args>;

const EVENT_TO_KEY: Record<z.infer<typeof EventArg>, string> = {
  on_my_way: 'kincare.auntie.on_my_way',
  arrived: 'kincare.auntie.arrived',
  departed: 'kincare.auntie.departed',
  report_sent: 'kincare.report.sent',
};

export async function dispatchVisitNotificationHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; dispatchIds: string[]; suppressed: boolean }> {
  const args: Args = Args.parse(req.data);
  const actorUid = req.auth!.uid;

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
    req.auth?.token?.name ??
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

export const dispatchVisitNotification = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('dispatchVisitNotification', dispatchVisitNotificationHandler),
);
