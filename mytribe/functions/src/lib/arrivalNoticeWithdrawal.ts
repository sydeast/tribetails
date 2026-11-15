import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS } from './auditEvents';
import { normalizeBookingStatus } from './bookingTransitions';
import {
  NOTIFICATIONS_COLLECTION,
  WITHDRAWN_AT_FIELD,
  WITHDRAWN_REASON_FIELD,
  isArchivedNotification,
  isWithdrawnNotification,
} from './recipientNotifications';

/**
 * #2038: "Undo arrived" left "Your Auntie has arrived" on the household's
 * notifications list, unread and counted on the bell, for a visit that was
 * back at Scheduled.
 *
 * LEAD RULING, in line with the operator's quiet "Undo departed" (#2250):
 *   - the undo sends the household NO correction;
 *   - the arrival's entry on their notifications list is withdrawn, so it is
 *     no longer listed or counted;
 *   - an email, text or push already handed to its channel is not recalled;
 *   - a real arrival later is announced once, as a new notice.
 *
 * HOW A ROW IS WITHDRAWN. `archivedAt` and `withdrawnAt` are stamped on it,
 * with `withdrawnReason`. `archivedAt` is what every reader already leaves out:
 * `listMyNotifications`, `getMyHome`'s count, and the bell that MyTribe web and
 * the MyTribe Android app count on the device, including builds installed
 * before this change. `withdrawnAt` tells it from a row the reader filed away
 * themselves, and the restore callables refuse it. The row is not deleted: the
 * delivery trigger reads it and Activity Log lines point at it.
 *
 * WHICH ROW. The one written for THIS arrival, never "every arrived row of the
 * visit": an undo and the arrival after it can reach the server out of order
 * (an Android queue that drains at once), and a sweep would take the real
 * arrival's row with the wrong one. The arrival is named by its stamped time,
 * the same name its notice was sent under (#832), and found two ways:
 *   - `visit_step_notices/{session}__arrived__{at}.dispatchIds`, what the
 *     clock trigger or `setVisitLifecycle` recorded;
 *   - the dispatcher's ledger entry for that notice, which names the row
 *     whoever sent it (an installed client's own dispatch included).
 *
 * WHERE IT RUNS. `lib/visitStepNotice.ts#announceVisitStep`, on the Undo
 * arrival step, which every undo reaches: `setVisitLifecycle` calls it and the
 * session trigger calls it for a client's own write. It also runs after an
 * arrival's notice is sent when the arrival has been undone in the meantime,
 * because a wrong tap taken back within a second or two can reach the undo
 * before the arrival's notice exists.
 *
 * NEVER THROWS, and safe to run twice: each row is withdrawn in a transaction
 * that leaves a withdrawn row alone, and the Activity Log line has a fixed id.
 */

export const ARRIVED_NOTICE_KEY = 'kincare.auntie.arrived';
export const WITHDRAWN_ARRIVAL_UNDONE = 'arrival_undone';

type SessionData = Record<string, unknown>;

function nonBlank(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * PURE. Is the arrival stamped `atMs` still this visit's arrival? False once
 * the visit is back at Scheduled or On my way, and false when it has arrived
 * again under a new time.
 */
export function arrivalStillStands(
  session: SessionData | undefined,
  atMs: number,
  stampMs: (raw: unknown) => number | null,
): boolean {
  if (session === undefined) return false;
  const status = normalizeBookingStatus(session['status']);
  if (status !== 'ARRIVED' && status !== 'DEPARTED' && status !== 'COMPLETED') return false;
  return stampMs(session['arrivedAt']) === atMs;
}

/** The `notifications` rows written for the arrival stamped `atMs`. */
async function arrivalNoticeIds(sessionId: string, session: SessionData, atMs: number | null): Promise<string[]> {
  const ids = new Set<string>();

  if (atMs !== null) {
    const { VISIT_STEP_NOTICES_COLLECTION, visitStepNoticeId } = await import('./visitStepNotice.js');
    const record = await db()
      .collection(VISIT_STEP_NOTICES_COLLECTION)
      .doc(visitStepNoticeId(sessionId, 'arrived', atMs))
      .get();
    const recorded = (record.data() as { dispatchIds?: unknown } | undefined)?.dispatchIds;
    if (Array.isArray(recorded)) {
      for (const id of recorded) if (typeof id === 'string' && id !== '') ids.add(id);
    }
  }

  const familyId = nonBlank(session['kinfolkId']);
  if (familyId === '') return [...ids];
  let visitId = '';
  const batchId = nonBlank(session['kinCareBatchId']);
  const envelopeVisitId = nonBlank(session['kinCareVisitId']);
  if (batchId !== '' && envelopeVisitId !== '') {
    visitId = envelopeVisitId;
  } else {
    const bookingId = nonBlank(session['sourceBookingId']);
    if (bookingId !== '') {
      const { resolveKinCareRef } = await import('./resolveKinCareRef.js');
      visitId = (await resolveKinCareRef({ familyId, bookingId }))?.visitId ?? '';
    }
  }
  if (visitId === '') return [...ids];

  const [{ resolveKinfolkUid }, { visitDedupeKey }, { deliveredNotificationId }] = await Promise.all([
    import('./resolveKinfolkUid.js'),
    import('../admin/dispatchVisitNotification.js'),
    import('../notifications/dispatcher.js'),
  ]);
  const recipientUid = await resolveKinfolkUid(familyId);
  if (recipientUid) {
    const onLedger = await deliveredNotificationId(
      ARRIVED_NOTICE_KEY,
      visitDedupeKey(visitId, { event: 'arrived', ...(atMs !== null ? { eventAtMs: atMs } : {}) }),
      recipientUid,
    );
    if (onLedger !== null) ids.add(onLedger);
  }
  return [...ids];
}

/** Withdraw one row, unless it is not an arrival notice or is withdrawn already. */
async function withdrawRow(id: string): Promise<boolean> {
  const ref = db().collection(NOTIFICATIONS_COLLECTION).doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data['key'] !== ARRIVED_NOTICE_KEY || isWithdrawnNotification(data)) return false;
    tx.set(
      ref,
      {
        // A row the reader already filed away keeps the time they filed it.
        ...(isArchivedNotification(data) ? {} : { archivedAt: FieldValue.serverTimestamp() }),
        [WITHDRAWN_AT_FIELD]: FieldValue.serverTimestamp(),
        [WITHDRAWN_REASON_FIELD]: WITHDRAWN_ARRIVAL_UNDONE,
      },
      { merge: true },
    );
    return true;
  });
}

/**
 * Take the notice of one undone arrival off the household's notifications
 * list. Answers how many rows it withdrew: 0 when the household was never
 * told, or when an earlier run already did it.
 *
 * @param atMs the undone arrival's stamped time (`VisitStep.atMs`).
 * @param line who the Activity Log line names, as `announceVisitStep` resolved it.
 */
export async function withdrawArrivalNotice(input: {
  sessionId: string;
  session: SessionData;
  atMs: number | null;
  source: string;
  line?: {
    actorRole: 'AUNTIE' | 'SYSTEM' | 'PRIMARY' | 'SECONDARY';
    actorUid: string | null;
    stamp: Record<string, unknown>;
  };
}): Promise<number> {
  const { sessionId, session, atMs } = input;
  let withdrawn = 0;
  try {
    for (const id of await arrivalNoticeIds(sessionId, session, atMs)) {
      if (await withdrawRow(id)) withdrawn += 1;
    }
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'withdrawArrivalNotice',
      event: 'visit.arrival.notice.withdraw.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
    return withdrawn;
  }
  if (withdrawn === 0) return 0;

  logEvent({
    severity: 'info',
    function: 'withdrawArrivalNotice',
    event: 'visit.arrival.notice.withdrawn',
    extra: { sessionId, withdrawn, source: input.source },
  });
  const familyId = nonBlank(session['kinfolkId']);
  const { arrivalNoticeWithdrawnWords } = await import('./activityWords.js');
  await writeAuditEntry({
    event: AUDIT_EVENTS.VISIT_UNDO_ARRIVAL,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: input.line?.actorRole ?? 'SYSTEM',
    ...(input.line?.actorUid ? { actorUid: input.line.actorUid } : {}),
    targetUid: sessionId,
    targetCollection: 'kin_care_sessions',
    ...(familyId !== '' ? { familyId } : {}),
    description: arrivalNoticeWithdrawnWords(),
    payload: {
      visitId: sessionId,
      action: 'UNDO_ARRIVAL',
      noticeWithdrawn: true,
      source: input.source,
      ...(input.line?.stamp ?? {}),
    },
    docId: `visitnoticewithdrawn__${sessionId}__${atMs ?? 'unstamped'}`,
  }).catch((err) => {
    logEvent({
      severity: 'error',
      function: 'withdrawArrivalNotice',
      event: 'audit.write.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
  });
  return withdrawn;
}
