import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { materializeKinRoster } from '../lib/kinRoster';
import { isAuntieClaim } from '../lib/staffGate';

/**
 * #397 L19: server-bound edit of the operator-editable fields on ONE
 * `kin_care_sessions` document.
 *
 * THE FIELD SET IS `createKinCareSession`'s, MINUS WHAT ALREADY HAS AN OWNER.
 * That callable is the writer this collection was designed around, so its Zod
 * bounds are the validation this one applies -- the same `min`/`max` on the
 * same field names, rather than a second opinion about how long a service name
 * may be. What is deliberately absent, and who owns it instead:
 *
 *   status, completedAt   `transitionBookingStatus` (terminal, billable, and
 *                         `firestore.rules` refuses both to every client).
 *   arrivedAt, departedAt,
 *   onMyWayAt             `setVisitLifecycle` (the in-visit clock, with the
 *                         state machine that decides which stamp is legal from
 *                         which status).
 *   startTime, endTime    `rescheduleBooking`, which runs the busy-calendar,
 *                         company-closure and visit-overlap guards. Letting a
 *                         "session edit" move a visit's window would route
 *                         around all three, which is the hole #397 M13 closed.
 *   kinfolkId             not editable at all. Re-homing a visit is not an
 *                         edit; every back-reference on the document (the
 *                         envelope ids, the roster, the invoice link) is
 *                         relative to the household that booked it.
 *
 * A PATCH, NOT A REBUILD. Only the keys the caller states are written. This is
 * the exact defect pattern the Android tree carries -- an edit screen that
 * rebuilds the whole model from form state and wipes every field the form has
 * no control for -- and this collection has fields no edit form will ever show
 * (`_backfilledFrom`, `_backfilledAt` and `_reason` on the stub sessions
 * `cleanup_prod_data_pass2.py` created, plus `gpsSummary`, `visitRouteId`,
 * `reportIds`, `invoiceId`). `set(..., { merge: true })` over a patch built
 * only from stated keys is what makes an unstated field untouchable.
 *
 * ONE THING IT DOES NOT GUARD, said out loud rather than left to be discovered:
 * `serviceType` is editable on a session that has already been invoiced.
 * A session carries no price -- the only route from a visit to money is
 * `listUninvoicedSessions` joining `serviceType` against
 * `business_settings.serviceRates` -- so changing it after the fact does NOT
 * re-price an invoice that already exists; that money is decided by the
 * invoice's own line items (`updateInvoice`). Correcting a mis-typed service on
 * a finished visit is a real operator need, and refusing it would be a rule
 * neither client has today.
 */
export const Args = z
  .object({
    sessionId: z.string().min(1).max(120),
    /**
     * A `serviceRates` key, not free text. Same bound as
     * `createKinCareSession.Args.serviceType`, and the same reason: pricing is
     * by this exact NAME, so the client picks a canonical one
     * (`serviceOptionsFromRates` on web) rather than typing one.
     */
    serviceType: z.string().min(1).max(120).optional(),
    /** Admin-internal notes. Same 4000-char bound as the create path. */
    notes: z.string().max(4000).optional(),
    /** Expected visit length. Same 0..24h bound as the create path. */
    serviceDurationMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    /**
     * R1: which Kin this visit covers. An EMPTY array is not "no Kin" -- a
     * booking for zero animals is not a thing the business sells -- it means
     * the whole household, and `materializeKinRoster` expands it, exactly as
     * the create path does. `kinNames` is re-resolved in the same step so the
     * two can never drift apart on one document.
     */
    kinIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .refine(
    (a) =>
      a.serviceType !== undefined ||
      a.notes !== undefined ||
      a.serviceDurationMinutes !== undefined ||
      a.kinIds !== undefined,
    {
      // An empty patch is a bug in the caller, not a no-op worth writing an
      // `updatedAt` for: it would stamp the document as edited while changing
      // nothing, which is the one thing an audit trail must not say.
      message: 'State at least one field to change.',
    },
  );

export const Result = z
  .object({
    ok: z.literal(true),
    sessionId: z.string(),
    /** The field names actually written, in the order this handler applied them. */
    updated: z.array(z.string()),
  })
  .strict();

export type UpdateKinCareSessionResult = z.infer<typeof Result>;

export async function updateKinCareSessionHandler(
  req: CallableRequest<unknown>,
): Promise<UpdateKinCareSessionResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'updateKinCareSession validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // #944: a caretaker may fix a visit she worked, and may not re-price it.
  //
  // `serviceType` carries no money on this document, but it is the JOIN KEY the
  // money is computed from: listUninvoicedSessions matches it against
  // business_settings.serviceRates, which is owner-only precisely because it is
  // the price book. An Auntie changing the service on a finished visit would
  // therefore move what the household is billed, without ever seeing a rate.
  // The rules cannot catch this one: a callable runs on the Admin SDK, so
  // caretakerMoneyUnchanged() never evaluates.
  //
  // Everything else in the patch stays hers: notes, duration and the kin
  // roster are the corrections she is on site to make. The OWNER still decides
  // the money either way, since createInvoice is owner-only; this stops a
  // retroactive edit changing the answer underneath them.
  if (isAuntieClaim(req.auth?.token) && args.serviceType !== undefined) {
    throw new HttpsError(
      'permission-denied',
      'serviceType decides what this visit bills at. Ask an admin to change it.',
    );
  }
  const ref = db().doc(`kin_care_sessions/${args.sessionId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Session '${args.sessionId}' not found.`);
  }
  const prev = (snap.data() ?? {}) as { kinfolkId?: unknown };

  const patch: Record<string, unknown> = {};
  const updated: string[] = [];

  if (args.serviceType !== undefined) {
    patch.serviceType = args.serviceType;
    updated.push('serviceType');
  }
  if (args.notes !== undefined) {
    patch.notes = args.notes;
    updated.push('notes');
  }
  if (args.serviceDurationMinutes !== undefined) {
    patch.serviceDurationMinutes = args.serviceDurationMinutes;
    updated.push('serviceDurationMinutes');
  }
  if (args.kinIds !== undefined) {
    const kinfolkId = typeof prev.kinfolkId === 'string' ? prev.kinfolkId.trim() : '';
    if (kinfolkId === '') {
      // Without the household there is no roster to resolve against, and
      // writing the stated ids alone would leave `kinNames` stale against a
      // `kinIds` that changed. Refusing names the real problem instead.
      throw new HttpsError(
        'failed-precondition',
        `Session '${args.sessionId}' has no household on file, so the Kin it covers cannot be resolved.`,
        { code: 'session_has_no_kinfolk', sessionId: args.sessionId },
      );
    }
    const roster = await materializeKinRoster(kinfolkId, args.kinIds);
    patch.kinIds = roster.kinIds;
    patch.kinNames = roster.kinNames;
    updated.push('kinIds', 'kinNames');
  }

  patch.updatedAt = FieldValue.serverTimestamp();
  patch.updatedBy = uid;

  await ref.set(patch, { merge: true });

  await writeAuditEntry({
    event: AUDIT_EVENTS.UPDATE_KINCARE_SESSION,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.sessionId,
    targetCollection: 'kin_care_sessions',
    description: `Edited session ${args.sessionId}: ${updated.join(', ')}`,
    // FIELD NAMES, NOT FIELD VALUES. `notes` is free text an operator may have
    // put a household detail into, and the audit trail is a different
    // retention question from the document. Same treatment
    // `transitionBookingStatus` gives a cancellation reason.
    payload: { sessionId: args.sessionId, updated },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'updateKinCareSession',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'updateKinCareSession',
    event: 'admin.kinCareSession.updated',
    uid,
    extra: { sessionId: args.sessionId, updated },
  });

  return validateResponse('updateKinCareSession', Result, {
    ok: true as const,
    sessionId: args.sessionId,
    updated,
  });
}

export const updateKinCareSession = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('updateKinCareSession', updateKinCareSessionHandler),
);
