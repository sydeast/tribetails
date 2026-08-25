import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

export const DeleteBlockedTimeSlotArgs = z.object({
  slotId: z.string().min(1).max(120),
});

export interface DeleteBlockedTimeSlotResult {
  ok: true;
  slotId: string;
}

/**
 * The machine-readable half of the one refusal this callable has, so a client
 * branches on a code rather than on the wording of a sentence — the convention
 * `bookingBusyConflict.ts` and `visitOverlapConflict.ts` already set.
 *
 * NOT OVERRIDABLE, and it is not the same kind of refusal as a conflict guard's.
 * A conflict is a judgement the operator may knowingly go past; this one says
 * the delete would not last. See the header below.
 */
export const IMPORTED_BUSY_SLOT_CODE = 'imported_busy_slot';

/**
 * #574: the other half of "block time", and the half that had no callable at
 * all.
 *
 * `createBlockedTimeSlot` has existed and been deployed since B6. Removing a
 * block had nothing: the only unblock affordance in the product is Android's
 * ("Unblock", on the Scheduling Options list and in the Schedule screen's time
 * block dialog) and it deleted `booking_time_slots/{id}` STRAIGHT FROM THE
 * CLIENT. `firestore.rules` reads
 * `match /booking_time_slots/{id} { allow read: if isAuntie(); allow write: if false; }`,
 * so every one of those taps failed with PERMISSION_DENIED. The rule is right —
 * this collection has two server writers and no client one — so the fix is the
 * missing callable, not a looser rule.
 *
 * IT REFUSES A GOOGLE CALENDAR IMPORT, and that refusal is the reason this is
 * not a two-line delete. `booking_time_slots` holds rows from two writers:
 * `createBlockedTimeSlot` (`source: 'INTERNAL_MANUAL'`, the operator's own
 * block) and `syncGoogleCalendarBusyEvents` (`source: 'GOOGLE_BUSY_IMPORT'`, a
 * mirror of the operator's external calendar). Deleting a mirrored row does not
 * free the time: the next sync reads the same Google event and writes the row
 * straight back, so the operator gets a block that will not stay deleted and no
 * explanation. The honest answer is the one the message gives — clear it in
 * Google Calendar, or turn the sync off — so the delete is refused here, and
 * the clients stop drawing Unblock on those rows at all.
 *
 * `SYSTEM_RULE` is refused by the same test rather than by a second one: it is
 * not an operator-authored block either, and nothing in the product creates one
 * today, so a delete reaching it would be acting on a row whose author this
 * callable cannot name. A row carrying NO `source` at all IS deletable: the
 * collection predates the field, `repairBlockedTimeSlotShape.ts` exists because
 * historical rows are known to be shaped differently, and a manual block is
 * what an unlabelled row in this collection is.
 */
export async function deleteBlockedTimeSlotHandler(
  req: CallableRequest<unknown>,
): Promise<DeleteBlockedTimeSlotResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof DeleteBlockedTimeSlotArgs>;
  try {
    args = DeleteBlockedTimeSlotArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'deleteBlockedTimeSlot validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().doc(`booking_time_slots/${args.slotId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Blocked time slot '${args.slotId}' not found.`);
  }
  const prev = snap.data() as
    | { source?: string; date?: string; startTime?: string; endTime?: string; notes?: string }
    | undefined;

  const source = typeof prev?.source === 'string' ? prev.source : '';
  if (source !== '' && source !== 'INTERNAL_MANUAL') {
    throw new HttpsError(
      'failed-precondition',
      source === 'GOOGLE_BUSY_IMPORT'
        ? 'That busy block is a mirror of an event on the connected Google Calendar, ' +
          'so deleting it here would not free the time: the next sync writes it back. ' +
          'Remove the event in Google Calendar, or turn calendar sync off in Scheduling Options.'
        : `That busy block was written by ${source}, not by an operator, so it cannot be unblocked here.`,
      { code: IMPORTED_BUSY_SLOT_CODE, source },
    );
  }

  await ref.delete();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.DELETE_BLOCKED_TIME_SLOT,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      docId: args.slotId,
      date: prev?.date ?? null,
      startTime: prev?.startTime ?? null,
      endTime: prev?.endTime ?? null,
      notes: prev?.notes ?? null,
    },
  });

  logEvent({
    severity: 'info',
    function: 'deleteBlockedTimeSlot',
    event: 'admin.timeSlot.unblocked',
    uid,
    extra: { docId: args.slotId, date: prev?.date ?? null },
  });

  return { ok: true, slotId: args.slotId };
}

export const deleteBlockedTimeSlot = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteBlockedTimeSlot', deleteBlockedTimeSlotHandler),
);
