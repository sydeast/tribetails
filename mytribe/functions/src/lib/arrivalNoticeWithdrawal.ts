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
  toMillisOrNull,
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
 *
 * #2357, THREE FOLLOW-UPS (lead rulings):
 *   1. THE QUIET RULE COVERS A QUICK MISTAKE ONLY. A real arrival or departure
 *      that reaches the server on a LATER BUSINESS DAY than the undone one was
 *      told is announced as a normal notice: a new entry, and an email, text
 *      or push by the household's own channels. The day is read on the
 *      business's clock (`business_settings.timeZone`, else America/Chicago),
 *      from the server's clock at both ends, never from a device's stamp. See
 *      {@link quietRepeatOf}.
 *   2. "YOUR AUNTIE HAS LEFT" FOLLOWS THE ARRIVAL IT BELONGS TO (#2348). Undo
 *      arrival, straight from Departed or after an Undo departed, withdraws
 *      the departure's entry with the arrival's. The next real Departed puts
 *      it back and sends nothing (same day), or is announced (a later day).
 *      "Undo departed" alone still leaves the entry listed, as #2250 ruled,
 *      until a Departed announced on a later day replaces it
 *      ({@link withdrawReplacedNotice}).
 *   3. WHAT THE UNDO TOOK OFF IS RECORDED, at
 *      `visit_step_notices/{session}__undo_arrival__{arrivedAt ms}`, for the
 *      sentence the admin clients show after the undo. `withdrawn` lists the
 *      notices that are off the list (`arrived`, `departed`); a record with
 *      none means the household was never told. It is written only once the
 *      arrival's own notice is settled, so a client never reads "not told"
 *      for a notice that is still on its way.
 */

export const ARRIVED_NOTICE_KEY = 'kincare.auntie.arrived';

export const DEPARTED_NOTICE_KEY = 'kincare.auntie.departed';

export const WITHDRAWN_ARRIVAL_UNDONE = 'arrival_undone';

/** #2348: "Your Auntie has left" taken off the list because its arrival was undone. */
export const WITHDRAWN_DEPARTURE_UNDONE = 'departure_undone';

/**
 * On a `notifications` row: the arrival (its stamped time, ms) the row stands
 * for once a later arrival has taken it over. Absent on a row still standing
 * for the arrival it was sent for. An undo only withdraws a row that stands
 * for the arrival being undone.
 */
export const STANDS_FOR_ARRIVAL_FIELD = 'standsForArrivalAtMs';

/** The same for a "has left" row: the departure it stands for now. */
export const STANDS_FOR_DEPARTURE_FIELD = 'standsForDepartureAtMs';

/**
 * On a withdrawn row: true when the withdrawal filed it away, false when the
 * reader had filed it away already. Only the first is put back on the list.
 */
export const WITHDRAWN_FILED_FIELD = 'withdrawnFiledAway';

/** The `event` of the record that says what an Undo arrival took off the list. */
export const UNDO_ARRIVAL_RECORD_EVENT = 'undo_arrival';

/** The two clock notices an undo can take back. Also the `event` their records carry. */
export type StepNoticeKind = 'arrived' | 'departed';

const KIND: Readonly<Record<StepNoticeKind, { key: string; standsFor: string; reason: string }>> = {
  arrived: { key: ARRIVED_NOTICE_KEY, standsFor: STANDS_FOR_ARRIVAL_FIELD, reason: WITHDRAWN_ARRIVAL_UNDONE },
  departed: { key: DEPARTED_NOTICE_KEY, standsFor: STANDS_FOR_DEPARTURE_FIELD, reason: WITHDRAWN_DEPARTURE_UNDONE },
};

type SessionData = Record<string, unknown>;

type Line = {
  actorRole: 'AUNTIE' | 'SYSTEM' | 'PRIMARY' | 'SECONDARY';
  actorUid: string | null;
  stamp: Record<string, unknown>;
};

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

/**
 * PURE. Is the departure stamped `atMs` still this visit's departure? False
 * once "Undo departed" or "Undo arrival" has taken it back, and false when the
 * visit has departed again under a new time.
 */
export function departureStillStands(
  session: SessionData | undefined,
  atMs: number,
  stampMs: (raw: unknown) => number | null,
): boolean {
  if (session === undefined) return false;
  const status = normalizeBookingStatus(session['status']);
  if (status !== 'DEPARTED' && status !== 'COMPLETED') return false;
  return stampMs(session['departedAt']) === atMs;
}

function stringIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : [];
}

/** One `visit_step_notices` record of this visit, as the rules here read it. */
interface StepRecord {
  event: string;
  atMs: number;
  ids: string[];
  /** When the server recorded it (its own clock), or null on a record from before #2357. */
  recordedAtMs: number | null;
  /** On a departure: the arrival it ended. Null on a record from before #2357. */
  arrivalAtMs: number | null;
}

/** Every step record on file for the visit. */
async function stepRecords(sessionId: string): Promise<StepRecord[]> {
  const { VISIT_STEP_NOTICES_COLLECTION } = await import('./visitStepNotice.js');
  const snap = await db().collection(VISIT_STEP_NOTICES_COLLECTION).where('sessionId', '==', sessionId).get();
  const out: StepRecord[] = [];
  for (const doc of snap.docs) {
    const rec = doc.data() as Record<string, unknown>;
    if (typeof rec['event'] !== 'string' || typeof rec['atMs'] !== 'number') continue;
    out.push({
      event: rec['event'],
      atMs: rec['atMs'],
      ids: stringIds(rec['dispatchIds']),
      recordedAtMs:
        typeof rec['recordedAtMs'] === 'number' ? rec['recordedAtMs'] : toMillisOrNull(rec['recordedAt']),
      arrivalAtMs: typeof rec['arrivalAtMs'] === 'number' ? rec['arrivalAtMs'] : null,
    });
  }
  return out;
}

/**
 * PURE. The departures that ended the arrival stamped `arrivalAtMs`. A record
 * from before #2357 does not name its arrival, and is given to the latest
 * arrival on record that is not after it. With no stamped arrival to go by,
 * none: an undo that cannot name its arrival cannot tell its departures from
 * a later arrival's, and leaves them all listed.
 */
export function departuresOfArrival<T extends Pick<StepRecord, 'event' | 'atMs' | 'arrivalAtMs'>>(
  records: readonly T[],
  arrivalAtMs: number | null,
): T[] {
  if (arrivalAtMs === null) return [];
  const departures = records.filter((r) => r.event === 'departed');
  const arrivals = records.filter((r) => r.event === 'arrived').map((r) => r.atMs);
  return departures.filter((d) => {
    if (d.arrivalAtMs !== null) return d.arrivalAtMs === arrivalAtMs;
    const owner = arrivals.filter((a) => a <= d.atMs).sort((a, b) => b - a)[0];
    return owner === undefined || owner === arrivalAtMs;
  });
}

/**
 * Reads the dispatcher's ledger for one step of this visit, or answers null
 * for every step when the visit cannot be addressed to a member.
 */
async function ledgerLookupFor(
  session: SessionData,
): Promise<(kind: StepNoticeKind, atMs: number | null) => Promise<string | null>> {
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
  return (kind, atMs) =>
    deliveredNotificationId(
      KIND[kind].key,
      visitDedupeKey(visitId, { event: kind, ...(atMs !== null ? { eventAtMs: atMs } : {}) }),
      recipientUid,
    );
}

type RowWithdrawal = 'withdrew' | 'already' | 'taken' | 'no';

/**
 * Withdraw one row. `standsForAny` is the step, or steps, being undone: a row
 * a later step has taken over is left where it is (`taken`). `already` is a
 * row an earlier run withdrew for the same reason.
 */
async function withdrawRow(kind: StepNoticeKind, id: string, standsForAny: readonly number[] | null): Promise<RowWithdrawal> {
  const ref = db().collection(NOTIFICATIONS_COLLECTION).doc(id);
  return db().runTransaction(async (tx): Promise<RowWithdrawal> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'no';
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data['key'] !== KIND[kind].key) return 'no';
    // A later arrival (or departure) has taken this row over: an undo of the
    // earlier one, handled late, leaves the real step's entry where it is.
    const standsFor = data[KIND[kind].standsFor];
    if (typeof standsFor === 'number' && standsForAny !== null && !standsForAny.includes(standsFor)) return 'taken';
    if (isWithdrawnNotification(data)) return data[WITHDRAWN_REASON_FIELD] === KIND[kind].reason ? 'already' : 'no';
    const filedByReader = isArchivedNotification(data);
    tx.set(
      ref,
      {
        // A row the reader already filed away keeps the time they filed it.
        ...(filedByReader ? {} : { archivedAt: FieldValue.serverTimestamp() }),
        [WITHDRAWN_FILED_FIELD]: !filedByReader,
        [WITHDRAWN_AT_FIELD]: FieldValue.serverTimestamp(),
        [WITHDRAWN_REASON_FIELD]: KIND[kind].reason,
      },
      { merge: true },
    );
    return 'withdrew';
  });
}

/** What an Undo arrival left off the household's notifications list. */
export interface UndoneNotices {
  /** "Your Auntie has arrived" is off the list, by this run or an earlier one. */
  arrived: boolean;
  /** "Your Auntie has left" is off the list, by this run or an earlier one. */
  departed: boolean;
}

/**
 * Take the notices of one undone arrival off the household's notifications
 * list: the arrival's own, and (#2348) the "has left" of any departure that
 * ended it. Answers which of the two are off the list now. Both false when the
 * household was never told.
 *
 * Then records that answer for the admin clients' after-undo sentence, unless
 * the arrival's own notice is still on its way (`settled: 'ask'` and no record
 * of it yet): the arrival's handler runs this again once it knows.
 *
 * @param atMs the undone arrival's stamped time (`VisitStep.atMs`).
 * @param line who the Activity Log line names, as `announceVisitStep` resolved it.
 */
export async function withdrawUndoneArrivalNotices(input: {
  sessionId: string;
  session: SessionData;
  atMs: number | null;
  source: string;
  /** `true` when the caller knows the arrival's notice is settled; `'ask'` reads its record. */
  settled: true | 'ask';
  line?: Line;
}): Promise<UndoneNotices> {
  const { sessionId, session, atMs } = input;
  const off: UndoneNotices = { arrived: false, departed: false };
  const withdrew: Record<StepNoticeKind, number> = { arrived: 0, departed: 0 };
  let arrivalRecorded = false;
  // A later arrival or departure holds an entry this undo would have taken
  // off: the undo was handled late, and the household's entry stays listed.
  let takenOver = false;
  try {
    const records = await stepRecords(sessionId);
    const onLedger = await ledgerLookupFor(session);
    const take = async (kind: StepNoticeKind, ids: Iterable<string>, standsForAny: readonly number[] | null) => {
      for (const id of ids) {
        const outcome = await withdrawRow(kind, id, standsForAny);
        if (outcome === 'taken') takenOver = true;
        if (outcome === 'no' || outcome === 'taken') continue;
        off[kind] = true;
        if (outcome === 'withdrew') withdrew[kind] += 1;
      }
    };
    const arrivalIds = new Set<string>();
    for (const rec of records) {
      if (rec.event !== 'arrived' || rec.atMs !== atMs) continue;
      arrivalRecorded = true;
      for (const id of rec.ids) arrivalIds.add(id);
    }
    const arrivalOnLedger = await onLedger('arrived', atMs);
    if (arrivalOnLedger !== null) arrivalIds.add(arrivalOnLedger);
    await take('arrived', arrivalIds, atMs === null ? null : [atMs]);
    // #2348: the departures that ended this arrival, each found the same two ways.
    const departures = departuresOfArrival(records, atMs);
    const departureIds = new Set<string>();
    for (const dep of departures) {
      for (const id of dep.ids) departureIds.add(id);
      const depOnLedger = await onLedger('departed', dep.atMs);
      if (depOnLedger !== null) departureIds.add(depOnLedger);
    }
    await take('departed', departureIds, departures.map((d) => d.atMs));
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'withdrawUndoneArrivalNotices',
      event: 'visit.arrival.notice.withdraw.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
    return off;
  }
  // Nothing came off, but only because a later step holds the entry: the
  // household WAS told, so no record says they were not. The card then says
  // only that no message was sent about the undo.
  const toldButKept = takenOver && !off.arrived && !off.departed;
  if (atMs !== null && !toldButKept && (off.arrived || off.departed || input.settled === true || arrivalRecorded)) {
    await recordUndoneArrival(sessionId, atMs, off, input.source);
  }
  for (const kind of ['arrived', 'departed'] as const) {
    if (withdrew[kind] === 0) continue;
    logEvent({
      severity: 'info',
      function: 'withdrawUndoneArrivalNotices',
      event: kind === 'arrived' ? 'visit.arrival.notice.withdrawn' : 'visit.departure.notice.withdrawn',
      extra: { sessionId, withdrawn: withdrew[kind], source: input.source },
    });
    const familyId = nonBlank(session['kinfolkId']);
    const words = await import('./activityWords.js');
    await writeAuditEntry({
      event: AUDIT_EVENTS.VISIT_UNDO_ARRIVAL,
      severity: 'info',
      status: 'SUCCESS',
      actorRole: input.line?.actorRole ?? 'SYSTEM',
      ...(input.line?.actorUid ? { actorUid: input.line.actorUid } : {}),
      targetUid: sessionId,
      targetCollection: 'kin_care_sessions',
      ...(familyId !== '' ? { familyId } : {}),
      description: kind === 'arrived' ? words.arrivalNoticeWithdrawnWords() : words.departureNoticeWithdrawnWords(),
      payload: {
        visitId: sessionId,
        action: 'UNDO_ARRIVAL',
        noticeWithdrawn: true,
        notice: kind,
        source: input.source,
        ...(input.line?.stamp ?? {}),
      },
      // One line per notice: the kind is in the id, so neither hides the other.
      docId:
        kind === 'arrived'
          ? `visitnoticewithdrawn__${sessionId}__${atMs ?? 'unstamped'}`
          : `visitdeparturenoticewithdrawn__${sessionId}__${atMs ?? 'unstamped'}`,
    }).catch((err) => {
      logEvent({
        severity: 'error',
        function: 'withdrawUndoneArrivalNotices',
        event: 'audit.write.failed',
        extra: { sessionId, source: input.source },
        errorMessage: (err as Error)?.message,
      });
    });
  }
  return off;
}

/**
 * #2357: what one Undo arrival took off the household's notifications list,
 * for the sentence the admin clients show after it. `withdrawn` only ever
 * grows: the callable and the trigger its write fires both come here, and the
 * second, which finds the rows already withdrawn, never takes the first's
 * answer back. Never throws.
 */
async function recordUndoneArrival(sessionId: string, atMs: number, off: UndoneNotices, source: string): Promise<void> {
  try {
    const { VISIT_STEP_NOTICES_COLLECTION, visitStepNoticeId } = await import('./visitStepNotice.js');
    const ref = db()
      .collection(VISIT_STEP_NOTICES_COLLECTION)
      .doc(visitStepNoticeId(sessionId, UNDO_ARRIVAL_RECORD_EVENT, atMs));
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const before = stringIds((snap.data() as { withdrawn?: unknown } | undefined)?.withdrawn);
      const withdrawn = (['arrived', 'departed'] as const).filter((kind) => off[kind] || before.includes(kind));
      if (snap.exists && withdrawn.length === before.length) return;
      tx.set(ref, {
        sessionId,
        action: 'UNDO_ARRIVAL',
        event: UNDO_ARRIVAL_RECORD_EVENT,
        atMs,
        // An undo sends the household nothing, whatever it took off their list.
        notified: false,
        reason: 'no_event_for_action',
        withdrawn,
        source,
        recordedAt: FieldValue.serverTimestamp(),
        recordedAtMs: Date.now(),
      });
    });
  } catch (err) {
    // The card falls back to its plain "No message was sent about the undo".
    logEvent({
      severity: 'warn',
      function: 'recordUndoneArrival',
      event: 'visit.notice.record.failed',
      extra: { sessionId },
      errorMessage: (err as Error)?.message,
    });
  }
}

/** The `notifications` row an earlier step of this visit left with the household. */
export interface EarlierNotice {
  id: string;
  /** When the server recorded that step (its own clock), or null when it cannot be read. */
  toldAtMs: number | null;
  /** True when the row already stands for the step asked about. */
  standsForThis: boolean;
}

/**
 * READ-ONLY. The `notifications` row an EARLIER arrival (or departure) of this
 * visit left with the household, or null when none reached them.
 *
 * "Reached them" means a row was written: that is what the notifications list
 * reads and what drives the email, text and push. A first step that found no
 * member login, the household switch off, the notice turned off, a failed
 * send, or that was undone before its notice was written left no row, and the
 * real step is then announced as normal.
 *
 * Read from what each step's own send left on file (its `visit_step_notices`
 * record and the dispatcher's ledger), never from a mark the undo makes: an
 * owner's undo is a direct write whose trigger can run after the re-arrival's
 * (an Android queue that drains at once).
 */
export async function earlierStepNotice(
  kind: StepNoticeKind,
  sessionId: string,
  session: SessionData,
  atMs: number,
): Promise<EarlierNotice | null> {
  const earlier = (await stepRecords(sessionId)).filter((rec) => rec.event === kind && rec.atMs !== atMs);
  if (earlier.length === 0) return null;
  // The latest step first: its row is the one a chain of undos carried along.
  // "Latest" on the server's clock where the record has one. A device's stamp
  // can run hours off (the desktop console's older ones carry no zone), and a
  // stale first-day row read as the latest would announce the step again.
  earlier.sort((a, b) => (b.recordedAtMs ?? b.atMs) - (a.recordedAtMs ?? a.atMs));
  const onLedger = await ledgerLookupFor(session);
  for (const step of earlier) {
    const ids = new Set(step.ids);
    const ledgerId = await onLedger(kind, step.atMs);
    if (ledgerId !== null) ids.add(ledgerId);
    for (const id of ids) {
      const snap = await db().collection(NOTIFICATIONS_COLLECTION).doc(id).get();
      const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
      if (data === null || data['key'] !== KIND[kind].key) continue;
      return {
        id,
        toldAtMs: step.recordedAtMs ?? toMillisOrNull(data['createdAt']),
        standsForThis: data[KIND[kind].standsFor] === atMs,
      };
    }
  }
  return null;
}

/** The arrival's form, kept under the name its callers and tests know. */
export async function earlierArrivalNoticeId(sessionId: string, session: SessionData, atMs: number): Promise<string | null> {
  return (await earlierStepNotice('arrived', sessionId, session, atMs))?.id ?? null;
}

/**
 * The business's zone for the day rule: `business_settings.timeZone`, else the
 * ruled America/Chicago. A settings read that fails answers the same default.
 */
async function businessZone(): Promise<string> {
  const { businessTimeZone } = await import('./bookingTimeBlocks.js');
  try {
    const snap = await db().doc('business_settings/business_settings').get();
    return businessTimeZone(snap.exists ? snap.data() : undefined);
  } catch {
    return businessTimeZone(undefined);
  }
}

/**
 * PURE. Does `nowMs` fall on a later business day than `toldAtMs`, on the
 * clock of `timeZone`? The same day, and an earlier one (a clock that ran
 * back), are both "no".
 */
export function isLaterBusinessDay(
  toldAtMs: number,
  nowMs: number,
  timeZone: string,
  dayOf: (ms: number, zone: string) => string,
): boolean {
  return dayOf(nowMs, timeZone) > dayOf(toldAtMs, timeZone);
}

/**
 * #2357, THE ONE QUIET-OR-ANNOUNCE DECISION for a real arrival or departure
 * that follows an undone one. `announceVisitStep` (the callable and the
 * session trigger) and the `dispatchVisitNotification` callable an installed
 * client still calls both ask here, so they cannot disagree.
 *
 * Answers the earlier entry to reuse when the step stays QUIET: an earlier
 * step of this visit reached the household, and this one reached the server on
 * the same business day. Answers null when it is ANNOUNCED as normal: nothing
 * earlier reached them, or (lead ruling) the earlier one was told on an
 * earlier business day, which is a later visit and not a quick mistake.
 *
 * Both ends of the comparison are the server's clock: when the earlier step
 * was recorded, and now. A device's stamp only names a notice; the desktop
 * console's carries no zone at all. An entry already handed to this step stays
 * this step's, so the callable and its trigger agree across midnight. An
 * earlier step with no readable time (a record from before #2357 whose row is
 * gone or undated) is treated as the same day, which is what it was before.
 */
export async function quietRepeatOf(
  kind: StepNoticeKind,
  sessionId: string,
  session: SessionData,
  atMs: number,
  nowMs: number = Date.now(),
): Promise<string | null> {
  return (await repeatOf(kind, sessionId, session, atMs, nowMs)).quietId;
}
/** What {@link repeatOf} decided for a step that follows an undone one. */
export interface RepeatDecision {
  /** QUIET: the earlier entry to reuse. Null when the step is announced as normal. */
  quietId: string | null;
  /**
   * ANNOUNCED on a later business day: the earlier day's entry, which the new
   * notice replaces ({@link withdrawReplacedNotice}). Null on the quiet path
   * and when nothing earlier reached the household.
   */
  replacedId: string | null;
}
/**
 * The decision behind {@link quietRepeatOf}, with the earlier day's entry
 * named when the step is announced, so the caller that replaces it does not
 * decide the day a second time.
 */
export async function repeatOf(
  kind: StepNoticeKind,
  sessionId: string,
  session: SessionData,
  atMs: number,
  nowMs: number = Date.now(),
): Promise<RepeatDecision> {
  const earlier = await earlierStepNotice(kind, sessionId, session, atMs);
  if (earlier === null) return { quietId: null, replacedId: null };
  if (earlier.standsForThis || earlier.toldAtMs === null) return { quietId: earlier.id, replacedId: null };
  const { businessCalendarDate } = await import('./bookingTimeBlocks.js');
  return isLaterBusinessDay(earlier.toldAtMs, nowMs, await businessZone(), businessCalendarDate)
    ? { quietId: null, replacedId: earlier.id }
    : { quietId: earlier.id, replacedId: null };
}
/** Hand the row to the step stamped `atMs` and, when it was withdrawn, put it back on the list. */
async function restoreRow(kind: StepNoticeKind, id: string, atMs: number): Promise<'restored' | 'handed' | 'kept' | 'gone'> {
  const ref = db().collection(NOTIFICATIONS_COLLECTION).doc(id);
  const standsForField = KIND[kind].standsFor;
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'gone';
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data['key'] !== KIND[kind].key) return 'gone';
    // Already this step's row: a redelivery, or the second of the callable
    // and its trigger. Left exactly as it is, withdrawn or not.
    if (data[standsForField] === atMs) return 'kept';
    const withdrawn = isWithdrawnNotification(data);
    if (!withdrawn) {
      // Never taken off the list: "Undo departed" alone leaves "has left"
      // listed (#2250), and an undo handled after the real step has not run
      // yet. The entry is the household's word of this step already, so it is
      // handed over as it stands: not re-dated, and not marked unread again.
      tx.set(ref, { [standsForField]: atMs }, { merge: true });
      return 'handed';
    }
    // A row the reader filed away themselves, before the undo, stays filed.
    const readerFiled = isArchivedNotification(data) && data[WITHDRAWN_FILED_FIELD] !== true;
    tx.set(
      ref,
      {
        [standsForField]: atMs,
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
              // real step. Dated when it reached the server, as a new notice
              // would have been. The device's stamp is never shown.
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
 * A real arrival or departure after an undone one. When the household was
 * already told once, and this is the same business day ({@link quietRepeatOf}),
 * nothing is sent a second time: the entry they were sent is handed to this
 * step and put back on their notifications list. Answers the row's id, or null
 * when the step is to be announced as normal (nothing earlier reached them, or
 * it was a day ago) or when the lookup failed (the same: a passing error never
 * costs a household its only notice).
 *
 * Safe to run twice. Delivery records and the work order are not touched, so
 * no channel sends again.
 */
export async function restoreToldNotice(
  kind: StepNoticeKind,
  input: { sessionId: string; session: SessionData; atMs: number; source: string; line?: Line },
): Promise<string | null> {
  return (await settleRepeat(kind, input)).quietId;
}
/**
 * {@link restoreToldNotice}, answering the whole decision: the entry reused
 * when the step stays quiet, or the earlier day's entry the announced notice
 * is to replace. Both null when the step is simply announced.
 */
export async function settleRepeat(
  kind: StepNoticeKind,
  input: { sessionId: string; session: SessionData; atMs: number; source: string; line?: Line },
): Promise<RepeatDecision> {
  const none: RepeatDecision = { quietId: null, replacedId: null };
  const { sessionId, session, atMs } = input;
  let id: string | null;
  let outcome: 'restored' | 'handed' | 'kept' | 'gone';
  try {
    const decision = await repeatOf(kind, sessionId, session, atMs);
    id = decision.quietId;
    if (id === null) return decision;
    outcome = await restoreRow(kind, id, atMs);
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'restoreToldNotice',
      event: 'visit.notice.restore.failed',
      extra: { sessionId, kind, source: input.source },
      errorMessage: (err as Error)?.message,
    });
    return none;
  }
  if (outcome === 'gone') return none;
  const quiet: RepeatDecision = { quietId: id, replacedId: null };
  // Nothing went back on the list, so the Activity Log does not say it did.
  if (outcome !== 'restored') return quiet;
  logEvent({
    severity: 'info',
    function: 'restoreToldNotice',
    event: kind === 'arrived' ? 'visit.arrival.notice.restored' : 'visit.departure.notice.restored',
    extra: { sessionId, source: input.source },
  });
  const familyId = nonBlank(session['kinfolkId']);
  const words = await import('./activityWords.js');
  await writeAuditEntry({
    event: kind === 'arrived' ? AUDIT_EVENTS.VISIT_ARRIVED : AUDIT_EVENTS.VISIT_DEPARTED,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: input.line?.actorRole ?? 'SYSTEM',
    ...(input.line?.actorUid ? { actorUid: input.line.actorUid } : {}),
    targetUid: sessionId,
    targetCollection: 'kin_care_sessions',
    ...(familyId !== '' ? { familyId } : {}),
    description: kind === 'arrived' ? words.arrivalNoticeRestoredWords() : words.departureNoticeRestoredWords(),
    payload: {
      visitId: sessionId,
      action: kind === 'arrived' ? 'ARRIVED' : 'DEPARTED',
      noticeRestored: true,
      source: input.source,
      ...(input.line?.stamp ?? {}),
    },
    docId:
      kind === 'arrived'
        ? `visitnoticerestored__${sessionId}__${atMs}`
        : `visitdeparturenoticerestored__${sessionId}__${atMs}`,
  }).catch((err) => {
    logEvent({
      severity: 'error',
      function: 'restoreToldNotice',
      event: 'audit.write.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
  });
  return quiet;
}

/**
 * #2357, lead ruling: A NOTICE ANNOUNCED ON A LATER BUSINESS DAY REPLACES THE
 * EARLIER DAY'S ENTRY. "Undo departed" alone leaves "Your Auntie has left"
 * listed (#2250). When the real Departed lands on a later business day it is
 * announced, and the household would then read two "has left" entries for one
 * visit, the first of them for a departure that was taken back. The first
 * comes off their notifications list, the way an undone arrival's does, and
 * they see only the real one. Nothing is sent about it.
 *
 * The same for an arrival, where it is nearly always a no-op: Undo arrival
 * has already withdrawn the first day's entry. It matters only when that
 * withdrawal never landed.
 *
 * ONLY ONCE THE NEW ENTRY EXISTS. A later-day step the household is not told
 * about (the send gate off, the notice turned off, no member login, a failed
 * send) writes no entry, and the earlier one then stays where it is: it is
 * the only word of the visit on their list. The new entry is found the two
 * ways every notice here is, so an installed client that dispatched first is
 * covered when the session trigger comes through.
 *
 * `replacedId` is the entry {@link repeatOf} judged a day old, for this same
 * step. Never throws, and safe to run twice: a withdrawn row is left alone and
 * the Activity Log line has a fixed id.
 */
export async function withdrawReplacedNotice(
  kind: StepNoticeKind,
  input: { sessionId: string; session: SessionData; atMs: number; replacedId: string; source: string; line?: Line },
): Promise<boolean> {
  const { sessionId, session, atMs, replacedId } = input;
  let outcome: RowWithdrawal;
  try {
    const records = (await stepRecords(sessionId)).filter((rec) => rec.event === kind);
    const own = new Set<string>();
    for (const rec of records) if (rec.atMs === atMs) for (const id of rec.ids) own.add(id);
    const onLedger = await (await ledgerLookupFor(session))(kind, atMs);
    if (onLedger !== null) own.add(onLedger);
    // The entry was handed to this step after all: it is the household's one.
    if (own.has(replacedId)) return false;
    let listed = false;
    for (const id of own) {
      const snap = await db().collection(NOTIFICATIONS_COLLECTION).doc(id).get();
      const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
      if (data !== null && data['key'] === KIND[kind].key && !isWithdrawnNotification(data)) listed = true;
    }
    if (!listed) return false;
    // A row that stands for this very step is never taken: only one that
    // still stands for an earlier step of the visit, or for none.
    const earlierSteps = records.filter((rec) => rec.atMs !== atMs).map((rec) => rec.atMs);
    outcome = await withdrawRow(kind, replacedId, earlierSteps);
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'withdrawReplacedNotice',
      event: 'visit.notice.replace.failed',
      extra: { sessionId, kind, source: input.source },
      errorMessage: (err as Error)?.message,
    });
    return false;
  }
  if (outcome !== 'withdrew') return outcome === 'already';
  logEvent({
    severity: 'info',
    function: 'withdrawReplacedNotice',
    event: kind === 'arrived' ? 'visit.arrival.notice.replaced' : 'visit.departure.notice.replaced',
    extra: { sessionId, source: input.source },
  });
  const familyId = nonBlank(session['kinfolkId']);
  const words = await import('./activityWords.js');
  await writeAuditEntry({
    event: kind === 'arrived' ? AUDIT_EVENTS.VISIT_ARRIVED : AUDIT_EVENTS.VISIT_DEPARTED,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: input.line?.actorRole ?? 'SYSTEM',
    ...(input.line?.actorUid ? { actorUid: input.line.actorUid } : {}),
    targetUid: sessionId,
    targetCollection: 'kin_care_sessions',
    ...(familyId !== '' ? { familyId } : {}),
    description: kind === 'arrived' ? words.arrivalNoticeReplacedWords() : words.departureNoticeReplacedWords(),
    payload: {
      visitId: sessionId,
      action: kind === 'arrived' ? 'ARRIVED' : 'DEPARTED',
      noticeReplaced: true,
      source: input.source,
      ...(input.line?.stamp ?? {}),
    },
    docId:
      kind === 'arrived'
        ? `visitnoticereplaced__${sessionId}__${atMs}`
        : `visitdeparturenoticereplaced__${sessionId}__${atMs}`,
  }).catch((err) => {
    logEvent({
      severity: 'error',
      function: 'withdrawReplacedNotice',
      event: 'audit.write.failed',
      extra: { sessionId, source: input.source },
      errorMessage: (err as Error)?.message,
    });
  });
  return true;
}
