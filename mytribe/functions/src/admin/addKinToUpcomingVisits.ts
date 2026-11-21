import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { readHouseholdKinRoster, type KinRosterEntry } from '../lib/kinRoster';
import { isAuntieClaim } from '../lib/staffGate';
import type { TimeZoneReader } from '../lib/pastVisit';

/**
 * #1822 (operator ruling 2026-11-20): "Add <Kin> to the N upcoming visits".
 *
 * A visit freezes the household's Kin when it is booked (`lib/kinRoster.ts`),
 * so a Kin adopted after a booking is on every visit booked from then on and
 * on none already on the calendar. The ruling keeps that and gives the OWNER
 * one deliberate step for the visits already booked: put this Kin on the
 * household's upcoming visits too.
 *
 * WHICH VISITS. Only this household's, and only the ones that have not
 * started:
 *   - an office visit (`kin_care_sessions`) still DRAFT, PENDING or SCHEDULED,
 *     with no On my way and no Arrived stamp, whose start is still ahead;
 *   - the household's own copy of a visit (`families/{id}/bookings/{b}/kinCares/{v}`)
 *     still requested, confirmed or approved, whose start (or, for a night
 *     still awaiting its time, its night) is still ahead. A request waiting
 *     for approval counts: approval keeps the Kin a request carries, so a
 *     request left out here would come back on the calendar without the Kin.
 * A visit whose office row has started is left alone even if its household
 * copy still reads confirmed. A past, cancelled or completed visit is never
 * touched: history is not rewritten.
 *
 * WHAT IS WRITTEN. The Kin's id (the one a visit stores: its admin record's,
 * see `readHouseholdKin`) and its name are added to `kinIds` / `kinNames` on
 * the office row, the household's copy and the booking envelope, each only
 * where it is missing. Nothing else on any of them changes. A doc stored with
 * no Kin at all means every Kin (R1), so it gets the whole active roster, never
 * the new Kin alone. Each visit is written in its own transaction that checks
 * again that it has not started, so a visit an Auntie starts while this runs
 * is left alone, and a Kin another edit added meanwhile is kept.
 *
 * IDEMPOTENT. A visit that already carries the Kin (by either of its two ids)
 * is not counted and not written, so a second tap, or a retry of a call whose
 * answer was lost, adds nothing and logs nothing.
 *
 * NOTICES: ONE for the whole change, never one per visit (lead decision
 * 2026-11-21, the rule #532 and #536 set for a request and its approval).
 * The household's copy of a confirmed visit changing its Kin used to be
 * answered by `onBookingsWrite` once per visit, so adding a Kin to six visits
 * sent six `kincare.changed` to the household, six office copies, and six
 * `assignment.changed` to the Auntie. Now each household copy this callable
 * writes carries a fresh `kinAddedStamp`, the trigger stays quiet for that
 * write (`kinAddedStampChanged`), and this callable sends, once the writes are
 * done:
 *   - ONE `kincare.changed` naming every confirmed visit it changed: the office
 *     copy (its `businessAdmins` resolver) and the household's (its
 *     `kinfolkAcct` secondary), which the household send gate holds like any
 *     household notice;
 *   - ONE `assignment.changed` per Auntie those visits are assigned to, naming
 *     her own days.
 * A request still awaiting approval tells nobody, as before, and neither does
 * an office row with no household copy.
 *
 * A PARTIAL FAILURE still tells about the visits this call did change, then
 * reports the failure. Each visit is changed by exactly one call (a retry
 * skips a visit that already carries the Kin), so a retry tells about the
 * rest and nobody hears of a visit twice.
 *
 * ENVELOPES. The envelope names the Kin of the whole booking (the request
 * card and the notices read it). Every apply also puts right the envelope of
 * an upcoming visit that already carries the Kin while its envelope does not,
 * so an envelope write that failed on one call is repaired by the next tap.
 * Such a visit is not counted as missing the Kin: the visit has it, and a Kin
 * put on one visit by an edit would otherwise draw the band for a visit that
 * already shows it.
 *
 * Preview and apply are one callable: `apply: false` answers the count the
 * button names, `apply: true` writes and answers how many visits it changed.
 * Owner only: an Auntie is refused here and is not on `lib/auntieAccess.ts`.
 */
export const Args = z.object({
  kinfolkId: z.string().min(1).max(120),
  /** Either of the Kin's ids: its admin record's or its household card's. */
  kinId: z.string().min(1).max(120),
  apply: z.boolean().optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    /** The id the visits store for this Kin. */
    kinId: z.string(),
    kinName: z.string().nullable(),
    /** Upcoming visits that do not carry this Kin yet (before this call wrote anything). */
    upcoming: z.number().int().min(0),
    /** Visits this call changed. Always 0 for a preview. */
    added: z.number().int().min(0),
  })
  .strict();

export type AddKinToUpcomingVisitsResult = z.infer<typeof Result>;

type Doc = Record<string, unknown>;

const SESSION_OPEN = new Set(['DRAFT', 'PENDING', 'SCHEDULED']);
const HOUSEHOLD_OPEN = new Set(['requested', 'confirmed', 'approved']);

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A stored time as the string `classifyVisitTimes` reads, or '' when unreadable. */
function timeString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v instanceof Timestamp) return v.toDate().toISOString();
  const ts = v as { toMillis?: () => number } | null | undefined;
  if (ts && typeof ts.toMillis === 'function') {
    const ms = ts.toMillis();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }
  return '';
}

async function isAhead(start: string, end: string, nowMs: number, tz: TimeZoneReader): Promise<boolean> {
  if (start === '') return false;
  // Loaded on use, as `createKinCareSession` does (coldStartImportGraph.test.ts).
  const { classifyVisitTimes } = await import('../lib/pastVisit.js');
  return (await classifyVisitTimes(start, end || start, nowMs, tz)) === 'ahead';
}

/** One visit: its office row, its household copy, or both. */
interface Visit {
  session: { id: string; data: Doc } | null;
  household: { path: string; batchPath: string; data: Doc } | null;
  /** The booking envelope the household copy sits under, when it exists. */
  envelope: { path: string; data: Doc } | null;
}

/**
 * #1822 review: the field on a household copy that says THIS write was an
 * `addKinToUpcomingVisits` write, so `onBookingsWrite` leaves the notices to
 * this callable. A fresh value per call; the trigger skips only a write that
 * changed it (`kinAddedStampChanged`), so every later edit by anyone else still
 * sends from the trigger.
 */
export const KIN_ADDED_STAMP_FIELD = 'kinAddedStamp';
function freshStamp(nowMs: number): string {
  return `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
}

function carries(data: Doc, kin: KinRosterEntry): boolean {
  const ids = stringList(data['kinIds']);
  return ids.includes(kin.id) || (kin.householdId !== null && ids.includes(kin.householdId));
}

/**
 * A lifecycle stamp that is really there. `setVisitLifecycle`'s Undo Arrived
 * clears `arrivedAt` by writing `''` (this collection's "cleared" spelling) and
 * puts the row back to SCHEDULED, so a blank string is no stamp.
 */
function stamped(v: unknown): boolean {
  if (v == null) return false;
  return typeof v === 'string' ? v.trim() !== '' : true;
}

async function sessionUpcoming(data: Doc, nowMs: number, tz: TimeZoneReader): Promise<boolean> {
  if (!SESSION_OPEN.has(text(data['status']).toUpperCase())) return false;
  if (stamped(data['onMyWayAt']) || stamped(data['arrivedAt'])) return false;
  return isAhead(timeString(data['startTime']), timeString(data['endTime']), nowMs, tz);
}

async function householdUpcoming(data: Doc, nowMs: number, tz: TimeZoneReader): Promise<boolean> {
  if (!HOUSEHOLD_OPEN.has(text(data['status']).toLowerCase())) return false;
  if (data['visitProgress'] != null && text(data['visitProgress']) !== '') return false;
  const start = timeString(data['startTime']);
  if (start !== '') return isAhead(start, timeString(data['endTime']), nowMs, tz);
  // #1098: a night still awaiting its start time is upcoming until that night is over.
  const night = text(data['requestedDate']);
  return /^\d{4}-\d{2}-\d{2}$/.test(night) ? isAhead(`${night}T23:59`, `${night}T23:59`, nowMs, tz) : false;
}

/**
 * The household's visits that have not started, each once, office row and
 * household copy paired by the visit's `sessionId` or the row's
 * `kinCareVisitId`.
 */
async function upcomingVisits(kinfolkId: string, nowMs: number, tz: TimeZoneReader): Promise<Visit[]> {
  const firestore = db();
  const [sessionSnap, householdSnap] = await Promise.all([
    firestore.collection('kin_care_sessions').where('kinfolkId', '==', kinfolkId).get(),
    firestore.collectionGroup('kinCares').where('familyId', '==', kinfolkId).get(),
  ]);
  const sessions = new Map<string, Doc>();
  const sessionByVisitId = new Map<string, string>();
  for (const d of sessionSnap.docs) {
    const data = (d.data() ?? {}) as Doc;
    sessions.set(d.id, data);
    const visitId = text(data['kinCareVisitId']);
    if (visitId !== '') sessionByVisitId.set(visitId, d.id);
  }
  const paired = new Set<string>();
  const out: Visit[] = [];
  for (const d of householdSnap.docs) {
    const data = (d.data() ?? {}) as Doc;
    const path = d.ref.path;
    // Only this household's tree, whatever the stored field says.
    if (!path.startsWith(`families/${kinfolkId}/bookings/`)) continue;
    const own = text(data['sessionId']);
    const sessionId = own !== '' && sessions.has(own) ? own : (sessionByVisitId.get(d.id) ?? null);
    if (sessionId !== null) paired.add(sessionId);
    const session = sessionId !== null ? { id: sessionId, data: sessions.get(sessionId)! } : null;
    const ok = session !== null ? await sessionUpcoming(session.data, nowMs, tz) : true;
    if (!ok || !(await householdUpcoming(data, nowMs, tz))) continue;
    const batchPath = path.split('/').slice(0, 4).join('/');
    out.push({ session, household: { path, batchPath, data }, envelope: null });
  }
  for (const [id, data] of sessions) {
    if (paired.has(id)) continue;
    if (await sessionUpcoming(data, nowMs, tz)) out.push({ session: { id, data }, household: null, envelope: null });
  }
  // The envelopes of those visits, each read once.
  const batchPaths = [...new Set(out.flatMap((v) => (v.household !== null ? [v.household.batchPath] : [])))];
  const envelopes = new Map<string, Doc>();
  await Promise.all(
    batchPaths.map(async (p) => {
      const snap = await firestore.doc(p).get();
      if (snap.exists) envelopes.set(p, (snap.data() ?? {}) as Doc);
    }),
  );
  for (const v of out) {
    if (v.household === null) continue;
    const data = envelopes.get(v.household.batchPath);
    if (data !== undefined) v.envelope = { path: v.household.batchPath, data };
  }
  return out;
}

/**
 * The doc's Kin with [kin] added. A doc stored with NO Kin means every Kin of
 * the household (R1, `lib/kinRoster.ts`; an approval materializes it as the
 * whole roster), so adding to it writes the whole active roster, which has
 * [kin] on it, rather than narrowing the visit to the new Kin alone.
 */
function withKin(
  data: Doc,
  kin: KinRosterEntry,
  roster: readonly KinRosterEntry[],
): { kinIds: string[]; kinNames: string[] } {
  const ids = stringList(data['kinIds']);
  if (ids.length === 0) {
    return {
      kinIds: roster.map((k) => k.id),
      kinNames: roster.map((k) => k.name).filter((n): n is string => n !== null),
    };
  }
  const names = stringList(data['kinNames']);
  const kinNames = kin.name !== null && !names.includes(kin.name) ? [...names, kin.name] : names;
  return { kinIds: [...ids, kin.id], kinNames };
}

/** Visits written at once, each in its own transaction. */
const PARALLEL = 10;

export async function addKinToUpcomingVisitsHandler(
  req: CallableRequest<unknown>,
): Promise<AddKinToUpcomingVisitsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  // Owner only. `wrapAdminCallable` already refuses an Auntie (this callable
  // is not on her allowlist); said again here so the rule reads in one place.
  if (isAuntieClaim(req.auth?.token)) {
    throw new HttpsError('permission-denied', 'Only the owner can add a Kin to visits already booked.');
  }

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'addKinToUpcomingVisits validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const roster = await readHouseholdKinRoster(args.kinfolkId);
  const kin = roster.find((k) => k.id === args.kinId || k.householdId === args.kinId);
  if (kin === undefined) {
    // A memorial or archived Kin is on no visit still to come, so the count is
    // 0 and its page draws nothing (all three clients ask on every Kin page).
    // Only putting it on visits is refused.
    if (args.apply !== true) {
      return validateResponse('addKinToUpcomingVisits', Result, {
        ok: true as const,
        kinId: args.kinId,
        kinName: null,
        upcoming: 0,
        added: 0,
      });
    }
    throw new HttpsError('not-found', 'This Kin is not one of the household’s Kin in care.', {
      code: 'kin_not_in_household',
    });
  }

  const nowMs = Date.now();
  const { businessTimeZoneReader } = await import('../lib/pastVisit.js');
  const tz = businessTimeZoneReader();
  const visits = await upcomingVisits(args.kinfolkId, nowMs, tz);
  const visitLacks = (v: Visit): boolean =>
    (v.session !== null && !carries(v.session.data, kin)) || (v.household !== null && !carries(v.household.data, kin));
  const envelopeLacks = (v: Visit): boolean => v.envelope !== null && !carries(v.envelope.data, kin);
  const missing = visits.filter(visitLacks);
  // A visit that carries the Kin while its envelope does not: an envelope write
  // that failed on an earlier call. Not counted (the visit itself has the Kin),
  // but any apply puts the envelope right.
  const envelopeOnly = visits.filter((v) => !visitLacks(v) && envelopeLacks(v));

  if (args.apply !== true || (missing.length === 0 && envelopeOnly.length === 0)) {
    return validateResponse('addKinToUpcomingVisits', Result, {
      ok: true as const,
      kinId: kin.id,
      kinName: kin.name,
      upcoming: missing.length,
      added: 0,
    });
  }

  const firestore = db();
  const stamp = freshStamp(nowMs);
  /**
   * CONCURRENCY. Each visit is written in its own transaction, which reads the
   * office row and the household's copy again, tests again that the visit has
   * not started (an Auntie can tap On my way while this runs) and that the Kin
   * is still missing, and adds the Kin to the lists as they stand then, so a
   * Kin another edit put on the visit meanwhile is kept. A visit that started
   * in between is left as it is and not counted.
   *
   * It answers the household copy as it wrote it when the household is owed
   * word of the change (a confirmed visit), for the one notice sent below.
   */
  const addOne = (v: Visit): Promise<{ changed: boolean; told: Told | null }> =>
    firestore.runTransaction(async (tx) => {
      const none = { changed: false, told: null };
      const sessionRef = v.session !== null ? firestore.doc(`kin_care_sessions/${v.session.id}`) : null;
      const householdRef = v.household !== null ? firestore.doc(v.household.path) : null;
      const sessionSnap = sessionRef !== null ? await tx.get(sessionRef) : null;
      const householdSnap = householdRef !== null ? await tx.get(householdRef) : null;
      const session = sessionSnap?.exists ? ((sessionSnap.data() ?? {}) as Doc) : null;
      const household = householdSnap?.exists ? ((householdSnap.data() ?? {}) as Doc) : null;
      if (sessionRef !== null && (session === null || !(await sessionUpcoming(session, nowMs, tz)))) return none;
      if (householdRef !== null && (household === null || !(await householdUpcoming(household, nowMs, tz)))) return none;
      let changed = false;
      let told: Told | null = null;
      if (sessionRef !== null && session !== null && !carries(session, kin)) {
        tx.set(
          sessionRef,
          { ...withKin(session, kin, roster), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
          { merge: true },
        );
        changed = true;
      }
      if (householdRef !== null && household !== null && v.household !== null && !carries(household, kin)) {
        const kinLists = withKin(household, kin, roster);
        tx.set(
          householdRef,
          { ...kinLists, [KIN_ADDED_STAMP_FIELD]: stamp, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        changed = true;
        if (HOUSEHOLD_TOLD.has(text(household['status']).toLowerCase())) {
          const segs = v.household.path.split('/');
          told = { visitId: segs[5] ?? '', batchId: segs[3] ?? '', data: { ...household, ...kinLists } };
        }
      }
      return { changed, told };
    });
  const changed = new Set<Visit>();
  const told: Told[] = [];
  let failure: unknown = null;
  for (let i = 0; i < missing.length && failure === null; i += PARALLEL) {
    const chunk = missing.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(chunk.map(addOne));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') {
        if (r.value.changed) changed.add(chunk[j]!);
        if (r.value.told !== null) told.push(r.value.told);
      } else if (failure === null) {
        failure = r.reason;
      }
    });
  }
  // The booking envelopes name the Kin of the whole booking. An envelope gets
  // the Kin when a visit of its booking got it now, or when its visits already
  // carry it and only the envelope does not (an envelope write that failed on
  // an earlier call). Each in its own transaction, checked again.
  const envelopeOwed = (v: Visit): boolean => v.envelope !== null && (changed.has(v) || envelopeOnly.includes(v));
  const envelopePaths = new Set(visits.filter(envelopeOwed).map((v) => v.envelope!.path));
  const envelopesWritten = new Set<string>();
  for (const path of envelopePaths) {
    try {
      const wrote = await firestore.runTransaction(async (tx) => {
        const ref = firestore.doc(path);
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = (snap.data() ?? {}) as Doc;
        if (carries(data, kin)) return false;
        tx.set(ref, { ...withKin(data, kin, roster), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return true;
      });
      if (wrote) envelopesWritten.add(path);
    } catch (err) {
      if (failure === null) failure = err;
    }
  }
  // A visit whose only gap was its envelope counts once its envelope is put
  // right, so the retry after a failed envelope answers what it fixed.
  for (const v of envelopeOnly) {
    if (v.envelope !== null && envelopesWritten.has(v.envelope.path)) changed.add(v);
  }
  // ONE notice per recipient for the whole change, sent before a failure is
  // reported so the visits this call did change are told about (see the header).
  await tellOnce({ kinfolkId: args.kinfolkId, kin, told, stamp, uid });
  if (changed.size === 0) {
    if (failure !== null) throw failure;
    return validateResponse('addKinToUpcomingVisits', Result, {
      ok: true as const,
      kinId: kin.id,
      kinName: kin.name,
      upcoming: missing.length,
      added: 0,
    });
  }
  const kinWords = kin.name ?? 'a Kin';
  const visitWords = changed.size === 1 ? '1 upcoming visit' : `${changed.size} upcoming visits`;
  await writeAuditEntry({
    event: AUDIT_EVENTS.ADD_KIN_TO_UPCOMING_VISITS,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: 'AUNTIE',
    actorUid: uid,
    familyId: args.kinfolkId,
    targetUid: args.kinfolkId,
    targetCollection: 'kinfolk',
    description: `Added ${kinWords} to ${visitWords}`,
    payload: {
      kinfolkId: args.kinfolkId,
      kinId: kin.id,
      visitCount: changed.size,
      sessionIds: [...changed].flatMap((v) => (v.session !== null ? [v.session.id] : [])),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'addKinToUpcomingVisits',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });
  logEvent({
    severity: 'info',
    function: 'addKinToUpcomingVisits',
    event: 'admin.kin.addedToUpcomingVisits',
    uid,
    extra: { kinfolkId: args.kinfolkId, kinId: kin.id, visits: changed.size, upcoming: missing.length },
  });
  // Visits already written stay written (a retry finds them carrying the Kin
  // and skips them), and the log above names them; the rest are reported.
  if (failure !== null) throw failure;
  return validateResponse('addKinToUpcomingVisits', Result, {
    ok: true as const,
    kinId: kin.id,
    kinName: kin.name,
    upcoming: missing.length,
    added: changed.size,
  });
}

/** The two household statuses on which a changed visit is news to the household (`visitTellsHouseholdOfChanges`). */
const HOUSEHOLD_TOLD = new Set(['confirmed', 'approved']);
/** A confirmed visit this call changed, as it wrote the household copy. */
interface Told {
  visitId: string;
  batchId: string;
  data: Doc;
}

/**
 * The whole change, told once (lead decision 2026-11-21; #532/#536 shape):
 *
 *   - ONE `kincare.changed`: the office's copy and the household's (held by the
 *     household send gate), naming every confirmed visit this call changed;
 *   - ONE `assignment.changed` per Auntie those visits are assigned to, naming
 *     her own days.
 *
 * The dates are the structured shape every multi-visit message carries
 * (`notifications/visitDates.ts`): email lists every day, SMS and push give the
 * count and the first day with a link. `kinAdded` and `addedKinName` select the
 * seed's own wording for this change; `bookingDate` / `bookingTime` (the first
 * day) are sent too, so a Firestore template imported before this wording
 * still renders until the operator re-imports.
 *
 * The target is the household (`kinfolk`): the office's Open lands on it, and
 * the household's copy opens its schedule (`householdNoticeTarget`). No visit
 * id, because no one visit is what this is about.
 *
 * Never throws: the visits are written by now, and a failed send is logged at
 * `warn` with the key. Each send is caught on its own so one recipient's
 * failure costs nobody else their copy. Named by this call's stamp, so a
 * redelivery dedupes and a later call (another Kin) sends.
 */
async function tellOnce(args: { kinfolkId: string; kin: KinRosterEntry; told: Told[]; stamp: string; uid: string }): Promise<void> {
  const { kinfolkId, kin, told, stamp, uid } = args;
  if (told.length === 0) return;
  const warn = (key: string, err: unknown, extra: Record<string, unknown> = {}) =>
    logEvent({
      severity: 'warn',
      function: 'addKinToUpcomingVisits',
      event: 'notification.dispatch.failed',
      uid,
      extra: { kinfolkId, key, ...extra, err: (err as Error)?.message },
    });
  try {
    const [dispatcher, dates, { resolveKinfolkUid }] = await Promise.all([
      import('../notifications/dispatcher.js'),
      import('../notifications/visitDates.js'),
      import('../lib/resolveKinfolkUid.js'),
    ]);
    const rows = told
      .map((t) => ({
        visitId: t.visitId,
        startTimeMs: dates.startMillisOf(t.data['startTime']) ?? dates.requestedDateNoonUtcMs(t.data['requestedDate']),
        timeBlockId: typeof t.data['timeBlockId'] === 'string' ? (t.data['timeBlockId'] as string) : null,
        serviceId: typeof t.data['serviceId'] === 'string' ? (t.data['serviceId'] as string) : null,
        assignedAuntieUid: text(t.data['assignedAuntieUid']) || null,
        serviceName: text(t.data['serviceName']) || text(t.data['serviceType']) || text(t.data['title']) || null,
      }))
      .filter((r): r is typeof r & { startTimeMs: number } => r.startTimeMs !== null)
      .sort((a, b) => a.startTimeMs - b.startTimeMs);
    if (rows.length === 0) return;
    const tz = await dates.loadBusinessTimeZone();
    const householdTime = await dates.loadHouseholdTimeContext();
    const first = rows[0]!;
    const common = {
      kinfolkId,
      kinId: kin.id,
      kinName: kin.name,
      kinAdded: true,
      addedKinName: kin.name ?? 'A Kin',
      changedFields: ['kinIds', 'kinNames'],
    };
    const dedupeKey = `kin-add:${kinfolkId}:${kin.id}:${stamp}`;
    try {
      const recipientUid = await resolveKinfolkUid(kinfolkId);
      await dispatcher.enqueueNotification({
        key: 'kincare.changed',
        recipientUid: recipientUid ?? '',
        data: {
          ...common,
          serviceName: first.serviceName,
          startTimeMs: first.startTimeMs,
          ...dates.buildVisitDateData(rows, tz, undefined, householdTime),
          bookingDate: dates.formatBookingDate(first.startTimeMs, tz),
          bookingTime: dates.formatBookingTime(first.startTimeMs, tz),
          [dates.HOUSEHOLD_BOOKING_TIME]: dates.householdVisitTime(first, householdTime, tz),
        },
        targetType: 'kinfolk',
        targetId: kinfolkId,
        dedupeKey,
      });
    } catch (err) {
      warn('kincare.changed', err);
    }
    const byAuntie = new Map<string, typeof rows>();
    for (const r of rows) {
      if (r.assignedAuntieUid === null) continue;
      byAuntie.set(r.assignedAuntieUid, [...(byAuntie.get(r.assignedAuntieUid) ?? []), r]);
    }
    for (const [auntieUid, hers] of byAuntie) {
      const herFirst = hers[0]!;
      try {
        await dispatcher.enqueueNotification({
          key: 'assignment.changed',
          recipientUid: auntieUid,
          data: {
            ...common,
            assignedAuntieUid: auntieUid,
            changeKind: 'updated',
            serviceName: herFirst.serviceName,
            startTimeMs: herFirst.startTimeMs,
            ...dates.buildVisitDateData(hers, tz, dates.AUNTIE_SCHEDULE_URL),
            bookingDate: dates.formatBookingDate(herFirst.startTimeMs, tz),
            bookingTime: dates.formatBookingTime(herFirst.startTimeMs, tz),
          },
          targetType: 'kinfolk',
          targetId: kinfolkId,
          dedupeKey,
        });
      } catch (err) {
        warn('assignment.changed', err, { auntieUid });
      }
    }
  } catch (err) {
    warn('kincare.changed', err);
  }
}

export const addKinToUpcomingVisits = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('addKinToUpcomingVisits', addKinToUpcomingVisitsHandler),
);
