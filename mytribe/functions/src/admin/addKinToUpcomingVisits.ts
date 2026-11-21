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
 * where it is missing. Nothing else on any of them changes.
 *
 * IDEMPOTENT. A visit that already carries the Kin (by either of its two ids)
 * is not counted and not written, so a second tap, or a retry of a call whose
 * answer was lost, adds nothing and logs nothing.
 *
 * NOTICES follow the existing visit-change rules, and this callable sends none
 * of its own. Writing the household's copy of a confirmed visit is a change to
 * its Kin, which `onBookingsWrite` already answers with `kincare.changed`
 * (behind the household send gate, like every household notice). A request
 * still awaiting approval sends nothing, as for any other edit to a request.
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
}

function carries(data: Doc, kin: KinRosterEntry): boolean {
  const ids = stringList(data['kinIds']);
  return ids.includes(kin.id) || (kin.householdId !== null && ids.includes(kin.householdId));
}

async function sessionUpcoming(data: Doc, nowMs: number, tz: TimeZoneReader): Promise<boolean> {
  if (!SESSION_OPEN.has(text(data['status']).toUpperCase())) return false;
  if (data['onMyWayAt'] != null || data['arrivedAt'] != null) return false;
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
async function upcomingVisits(kinfolkId: string, nowMs: number): Promise<Visit[]> {
  const firestore = db();
  const [sessionSnap, householdSnap] = await Promise.all([
    firestore.collection('kin_care_sessions').where('kinfolkId', '==', kinfolkId).get(),
    firestore.collectionGroup('kinCares').where('familyId', '==', kinfolkId).get(),
  ]);
  const { businessTimeZoneReader } = await import('../lib/pastVisit.js');
  const tz = businessTimeZoneReader();
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
    out.push({ session, household: { path, batchPath, data } });
  }
  for (const [id, data] of sessions) {
    if (paired.has(id)) continue;
    if (await sessionUpcoming(data, nowMs, tz)) out.push({ session: { id, data }, household: null });
  }
  return out;
}

function withKin(data: Doc, kin: KinRosterEntry): { kinIds: string[]; kinNames: string[] } {
  const kinIds = [...stringList(data['kinIds']), kin.id];
  const names = stringList(data['kinNames']);
  const kinNames = kin.name !== null && !names.includes(kin.name) ? [...names, kin.name] : names;
  return { kinIds, kinNames };
}

const BATCH_LIMIT = 400;

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
    throw new HttpsError('not-found', 'This Kin is not one of the household’s Kin in care.', {
      code: 'kin_not_in_household',
    });
  }

  const visits = await upcomingVisits(args.kinfolkId, Date.now());
  const missing = visits.filter(
    (v) => (v.session !== null && !carries(v.session.data, kin)) || (v.household !== null && !carries(v.household.data, kin)),
  );

  if (args.apply !== true || missing.length === 0) {
    return validateResponse('addKinToUpcomingVisits', Result, {
      ok: true as const,
      kinId: kin.id,
      kinName: kin.name,
      upcoming: missing.length,
      added: 0,
    });
  }

  const firestore = db();
  const writes: Array<{ path: string; data: Doc }> = [];
  const batchPaths = new Set<string>();
  for (const v of missing) {
    if (v.session !== null && !carries(v.session.data, kin)) {
      writes.push({
        path: `kin_care_sessions/${v.session.id}`,
        data: { ...withKin(v.session.data, kin), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
      });
    }
    if (v.household !== null) {
      if (!carries(v.household.data, kin)) {
        writes.push({
          path: v.household.path,
          data: { ...withKin(v.household.data, kin), updatedAt: FieldValue.serverTimestamp() },
        });
      }
      batchPaths.add(v.household.batchPath);
    }
  }
  // The booking envelopes name the Kin of the whole booking: add the Kin to
  // each envelope one of the changed visits belongs to.
  const envelopes = await Promise.all([...batchPaths].map((p) => firestore.doc(p).get()));
  for (const snap of envelopes) {
    if (!snap.exists) continue;
    const data = (snap.data() ?? {}) as Doc;
    if (carries(data, kin)) continue;
    writes.push({ path: snap.ref.path, data: { ...withKin(data, kin), updatedAt: FieldValue.serverTimestamp() } });
  }

  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = firestore.batch();
    for (const w of writes.slice(i, i + BATCH_LIMIT)) batch.set(firestore.doc(w.path), w.data, { merge: true });
    await batch.commit();
  }

  const kinWords = kin.name ?? 'a Kin';
  const visitWords = missing.length === 1 ? '1 upcoming visit' : `${missing.length} upcoming visits`;
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
      visitCount: missing.length,
      sessionIds: missing.flatMap((v) => (v.session !== null ? [v.session.id] : [])),
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
    extra: { kinfolkId: args.kinfolkId, kinId: kin.id, visits: missing.length, writes: writes.length },
  });

  return validateResponse('addKinToUpcomingVisits', Result, {
    ok: true as const,
    kinId: kin.id,
    kinName: kin.name,
    upcoming: missing.length,
    added: missing.length,
  });
}

export const addKinToUpcomingVisits = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('addKinToUpcomingVisits', addKinToUpcomingVisitsHandler),
);
