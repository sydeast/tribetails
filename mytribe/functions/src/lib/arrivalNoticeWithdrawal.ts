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
 *   - a real arrival later is NOT announced a second time when the household
 *     was already told once (lead ruling on review, in line with #2250's one
 *     "has left"). The arrival's entry goes back on their notifications list,
 *     unread, dated when the real arrival reached the server. No email, text
 *     or push. See {@link restoreToldArrivalNotice}. A household that was never
 *     told (no row was ever written) is told as normal.
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
/**
 * On a `notifications` row: the arrival (its stamped time, ms) the row stands
 * for once a later arrival has taken it over. Absent on a row still standing
 * for the arrival it was sent for. An undo only withdraws a row that stands
 * for the arrival being undone.
 */
export const STANDS_FOR_ARRIVAL_FIELD = 'standsForArrivalAtMs';
/**
 * On a withdrawn row: true when the withdrawal filed it away, false when the
 * reader had filed it away already. Only the first is put back on the list.
 */
export const WITHDRAWN_FILED_FIELD = 'withdrawnFiledAway';

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

/** The ids `visit_step_notices` recorded for the arrival stamped `atMs`. */
async function recordedNoticeIds(sessionId: string, atMs: number): Promise<string[]> {
  const { VISIT_STEP_NOTICES_COLLECTION, visitStepNoticeId } = await import('./visitStepNotice.js');
  const record = await db()
    .collection(VISIT_STEP_NOTICES_COLLECTION)
    .doc(visitStepNoticeId(sessionId, 'arrived', atMs))
    .get();
  return stringIds((record.data() as { dispatchIds?: unknown } | undefined)?.dispatchIds);
}
function stringIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}
/**
 * Reads the dispatcher's ledger for one arrival of this visit, or answers
 * null for every arrival when the visit cannot be addressed to a member.
 */
async function ledgerLookupFor(session: SessionData): Promise<(atMs: number | null) => Promise<string | null>> {
  const none = async (): Promise<string | null> => null;
  const familyId = nonBlank(session['kinfolkId']);
  if (familyId === '') return none;
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
  if (visitId === '') return none;
  const [{ resolveKinfolkUid }, { visitDedupeKey }, { deliveredNotificationId }] = await Promise.all([
    import('./resolveKinfolkUid.js'),
    import('../admin/dispatchVisitNotification.js'),
    import('../notifications/dispatcher.js'),
  ]);
  const recipientUid = await resolveKinfolkUid(familyId);
  if (!recipientUid) return none;
  return (atMs) =>
    deliveredNotificationId(
      ARRIVED_NOTICE_KEY,
      visitDedupeKey(visitId, { event: 'arrived', ...(atMs !== null ? { eventAtMs: atMs } : {}) }),
      recipientUid,
    );
}
/** The `notifications` rows written for the arrival stamped `atMs`. */
async function arrivalNoticeIds(sessionId: string, session: SessionData, atMs: number | null): Promise<string[]> {
  const ids = new Set<string>();
  if (atMs !== null) for (const id of await recordedNoticeIds(sessionId, atMs)) ids.add(id);
  const onLedger = await (await ledgerLookupFor(session))(atMs);
  if (onLedger !== null) ids.add(onLedger);
  return [...ids];
}
/** Withdraw one row, unless it is not an arrival notice or is withdrawn already. */
async function withdrawRow(id: string, atMs: number | null): Promise<boolean> {
  const ref = db().collection(NOTIFICATIONS_COLLECTION).doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data['key'] !== ARRIVED_NOTICE_KEY || isWithdrawnNotification(data)) return false;
    // A later arrival has taken this row over: an undo of the earlier one,
    // handled late, leaves the real arrival's entry where it is.
    const standsFor = data[STANDS_FOR_ARRIVAL_FIELD];
    if (typeof standsFor === 'number' && atMs !== null && standsFor !== atMs) return false;
    const filedByReader = isArchivedNotification(data);
    tx.set(
      ref,
      {
        // A row the reader already filed away keeps the time they filed it.
        ...(filedByReader ? {} : { archivedAt: FieldValue.serverTimestamp() }),
        [WITHDRAWN_FILED_FIELD]: !filedByReader,
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
      if (await withdrawRow(id, atMs)) withdrawn += 1;
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

/**
 * READ-ONLY. The `notifications` row an EARLIER arrival of this visit left
 * with the household, or null when no earlier arrival reached them.
 *
 * "Reached them" means a row was written: that is what the notifications list
 * reads and what drives the email, text and push. A first arrival that found
 * no member login, the household switch off, the notice turned off, a failed
 * send, or that was undone before its notice was written left no row, and the
 * real arrival is then announced as normal.
 *
 * Read from what each arrival's own send left on file (its
 * `visit_step_notices` record and the dispatcher's ledger), never from a mark
 * the undo makes: an owner's undo is a direct write whose trigger can run
 * after the re-arrival's (an Android queue that drains at once).
 */
export async function earlierArrivalNoticeId(
  sessionId: string,
  session: SessionData,
  atMs: number,
): Promise<string | null> {
  const { VISIT_STEP_NOTICES_COLLECTION } = await import('./visitStepNotice.js');
  const records = await db().collection(VISIT_STEP_NOTICES_COLLECTION).where('sessionId', '==', sessionId).get();
  const earlier: Array<{ atMs: number; ids: string[] }> = [];
  for (const doc of records.docs) {
    const rec = doc.data() as { event?: unknown; atMs?: unknown; dispatchIds?: unknown };
    if (rec.event !== 'arrived' || typeof rec.atMs !== 'number' || rec.atMs === atMs) continue;
    earlier.push({ atMs: rec.atMs, ids: stringIds(rec.dispatchIds) });
  }
  if (earlier.length === 0) return null;
  // The latest arrival first: its row is the one a chain of undos carried along.
  earlier.sort((a, b) => b.atMs - a.atMs);
  const onLedger = await ledgerLookupFor(session);
  for (const arrival of earlier) {
    const ids = new Set(arrival.ids);
    const ledgerId = await onLedger(arrival.atMs);
    if (ledgerId !== null) ids.add(ledgerId);
    for (const id of ids) {
      const snap = await db().collection(NOTIFICATIONS_COLLECTION).doc(id).get();
      if (snap.exists && (snap.data() as Record<string, unknown>)['key'] === ARRIVED_NOTICE_KEY) return id;
    }
  }
  return null;
}
/** Hand the row to the arrival stamped `atMs` and put it back on the list. */
async function restoreRow(id: string, atMs: number): Promise<'restored' | 'kept' | 'gone'> {
  const ref = db().collection(NOTIFICATIONS_COLLECTION).doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'gone';
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data['key'] !== ARRIVED_NOTICE_KEY) return 'gone';
    // Already this arrival's row: a redelivery, or the second of the callable
    // and its trigger. Left exactly as it is, withdrawn or not.
    if (data[STANDS_FOR_ARRIVAL_FIELD] === atMs) return 'kept';
    const withdrawn = isWithdrawnNotification(data);
    // A row the reader filed away themselves, before the undo, stays filed.
    const readerFiled = isArchivedNotification(data) && !(withdrawn && data[WITHDRAWN_FILED_FIELD] === true);
    tx.set(
      ref,
      {
        [STANDS_FOR_ARRIVAL_FIELD]: atMs,
        // `null`, which every reader takes as "not there": the server's
        // predicates, both MyTribe clients, and the reader's own restore.
        [WITHDRAWN_AT_FIELD]: null,
        [WITHDRAWN_REASON_FIELD]: null,
        [WITHDRAWN_FILED_FIELD]: null,
        ...(readerFiled
          ? {}
          : {
              archivedAt: null,
              // Unread again, once: this is the household's only word of the
              // real arrival. Dated when it reached the server, as a new
              // notice would have been. The device's stamp is never shown.
              readAt: null,
              createdAt: FieldValue.serverTimestamp(),
            }),
      },
      { merge: true },
    );
    return 'restored';
  });
}
/**
 * A real arrival after an undone one. When the household was already told
 * once, nothing is sent a second time: the entry they were sent is handed to
 * this arrival and put back on their notifications list. Answers the row's id,
 * or null when no earlier arrival reached them (the caller then sends as
 * normal) or when the lookup failed (the same: a passing error never costs a
 * household its only notice).
 *
 * Safe to run twice. Delivery records and the work order are not touched, so
 * no channel sends again.
 */
export async function restoreToldArrivalNotice(input: {
  sessionId: string;
  session: SessionData;
  atMs: number;
  source: string;
  line?: {
    actorRole: 'AUNTIE' | 'SYSTEM' | 'PRIMARY' | 'SECONDARY';
    actorUid: string | null;
    stamp: Record<string, unknown>;
  };
}): Promise<string | null> {
  const { sessionId, session, atMs } = input;
  let id: string | null;
  let outcome: 'restored' | 'kept' | 'gone';
  try {
    id = await earlierArrivalNoticeId(sessionId, session, atMs);
    if (id === null) return null;
    outcome = await restoreRow(id, atMs);
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'restoreToldArrivalNotice',
      event: 'visit.arrival.notice.restore.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
    return null;
  }
  if (outcome === 'gone') return null;
  if (outcome === 'kept') return id;
  logEvent({
    severity: 'info',
    function: 'restoreToldArrivalNotice',
    event: 'visit.arrival.notice.restored',
    extra: { sessionId, source: input.source },
  });
  const familyId = nonBlank(session['kinfolkId']);
  const { arrivalNoticeRestoredWords } = await import('./activityWords.js');
  await writeAuditEntry({
    event: AUDIT_EVENTS.VISIT_ARRIVED,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: input.line?.actorRole ?? 'SYSTEM',
    ...(input.line?.actorUid ? { actorUid: input.line.actorUid } : {}),
    targetUid: sessionId,
    targetCollection: 'kin_care_sessions',
    ...(familyId !== '' ? { familyId } : {}),
    description: arrivalNoticeRestoredWords(),
    payload: {
      visitId: sessionId,
      action: 'ARRIVED',
      noticeRestored: true,
      source: input.source,
      ...(input.line?.stamp ?? {}),
    },
    docId: `visitnoticerestored__${sessionId}__${atMs}`,
  }).catch((err) => {
    logEvent({
      severity: 'error',
      function: 'restoreToldArrivalNotice',
      event: 'audit.write.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
  });
  return id;
}
