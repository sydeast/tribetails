import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { calendarIdProblem, CALENDAR_ID_INVALID_CODE } from '../lib/calendarSyncId';
import {
  busyIntervalToSlots,
  legacyUtcWindow,
  storedInstants,
  type BusyInterval,
} from '../lib/googleBusySlot';
import { businessTimeZone } from '../lib/bookingTimeBlocks';

/**
 * Slice 8 / spec 29 item 9 (scheduling). Server-side Google Calendar busy
 * import.
 *
 * Reads a shared Google Calendar (named by the UI-entered `calendarSyncId`)
 * via the Functions runtime service account through Application Default
 * Credentials (no key file ships in any client bundle), runs a freebusy
 * query over the next `lookAheadDays`, and upserts each Busy interval into the
 * `booking_time_slots` collection as a private BLOCKED slot that the kinfolk
 * app renders as "unavailable" with no event details
 * (hideDetailsFromKinfolk=true). Dedup is by `externalEventId` so re-running is
 * idempotent.
 *
 * Fail-loud: if the calendar is not shared with the runtime SA the Google API
 * returns 403/404 and we rethrow a permission-denied HttpsError whose message
 * NAMES the service account the operator must share the calendar with, so the
 * fix is unambiguous. A missing calendar id (no UI value) is a
 * failed-precondition.
 *
 * Calendar id resolution (see resolveCalendarId): the operator enters the
 * calendar id in the AuntieOS UI, which writes it to a `business_settings`
 * Firestore doc under field `calendarSyncId`. That is the single source of
 * truth. There is no secret fallback: the front-facing UI value is required.
 * The auth model is unchanged: ADC resolves the pinned `CALENDAR_SYNC_SA_EMAIL`
 * service account (no OAuth, no token storage).
 *
 * Two additions on 2026-07-25, both for the restored admin panel (Task 7.1):
 *   - The calendar id is SHAPE-CHECKED before the Google call
 *     (`lib/calendarSyncId.ts`). A typo and an empty calendar are
 *     indistinguishable in Google's answer, and both would otherwise reach the
 *     operator as "Imported 0 busy blocks".
 *   - Every run leaves a receipt on the settings doc (`CalendarSyncStamp`):
 *     when it ran, whether it worked, how many blocks landed, and the cause if
 *     it did not. The callable's return value dies with the page; the audit
 *     entry this already writes is not client-readable. Without the receipt the
 *     operator cannot tell a sync that worked from one that never ran.
 */

/**
 * Service account the operator must share the calendar with. This is the
 * identity ADC resolves at runtime when the function's `serviceAccount` option
 * is pinned below. It is surfaced verbatim in the fail-loud error message and
 * is the operator-facing source of truth (see GOOGLE_CALENDAR_SETUP.md).
 */
export const CALENDAR_SYNC_SA_EMAIL =
  'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com';

/**
 * Frozen in `test/callableContract.test.ts` as `syncGoogleCalendarBusyEvents`:
 * the React admin (`src/api/calendarSync.ts`) and android
 * (`BookingRepository.syncGoogleBusyEventsViaServer`) both build this payload.
 */
export const Args = z.object({
  lookAheadDays: z.number().int().optional(),
});

export type { BusyInterval, BookingTimeSlotDoc } from '../lib/googleBusySlot';
export { busyIntervalToSlots } from '../lib/googleBusySlot';
/**
 * The unified settings doc that carries `timeZone`. Read by its fixed id, not
 * through the `calendarSyncId` scan below: that scan returns whichever doc
 * holds the calendar id, which is not guaranteed to be the one with the zone.
 */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';
/** Clamp the look-ahead window to a sane 1..90 day range (default 30). */
export function clampLookAheadDays(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(raw)));
}

/**
 * Firestore collection that holds the operator-entered business settings. The
 * doc id is NOT consistent across clients: the web app writes doc id
 * "singleton" while Android writes doc id "business_settings". So we never read
 * a fixed id. Instead we scan the whole collection (see
 * pickCalendarIdFromDocs).
 */
const BUSINESS_SETTINGS_COLLECTION = 'business_settings';

/**
 * Doc id that holds feature flags, not real business settings. Ignored when
 * scanning for a `calendarSyncId`.
 */
const FEATURE_FLAGS_DOC_ID = 'feature_flags';

/** Minimal shape of a business_settings doc snapshot we scan. */
export interface SettingsDocLike {
  id: string;
  data: () => { calendarSyncId?: unknown } | undefined;
}

/**
 * Which doc the calendar id came from, alongside the id itself. The DOC ID is
 * carried out of resolution on purpose: the last-run stamp below is written
 * back onto the same doc the operator configured, so the surface that shows
 * the id also shows what that id last did. Writing the stamp to a fixed doc id
 * instead would strand it on a doc the operator's client never reads, given
 * that the doc id is not consistent across clients (see the collection note).
 */
export interface CalendarIdSetting {
  docId: string;
  calendarId: string;
}

/**
 * Pure resolution of the calendar id from a list of business_settings docs.
 * The UI-entered value is the single source of truth:
 *   1. First doc (other than feature_flags) whose `calendarSyncId` is a
 *      non-empty trimmed string, trimmed, with that doc's id.
 *   2. Otherwise undefined (caller fails loud).
 * Unit-testable without Firestore.
 */
export function pickCalendarIdFromDocs(
  docs: SettingsDocLike[],
): CalendarIdSetting | undefined {
  for (const doc of docs) {
    if (doc.id === FEATURE_FLAGS_DOC_ID) continue;
    const raw = doc.data()?.calendarSyncId;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > 0) return { docId: doc.id, calendarId: trimmed };
    }
  }
  return undefined;
}

/**
 * Resolves the calendar id from the UI-entered `calendarSyncId` on any
 * business_settings doc. Throws the fail-loud failed-precondition error when the
 * admin has not configured it in the AuntieOS UI yet.
 */
export async function resolveCalendarId(
  database: FirebaseFirestore.Firestore,
): Promise<CalendarIdSetting> {
  const snap = await database.collection(BUSINESS_SETTINGS_COLLECTION).get();
  const docs: SettingsDocLike[] = snap.docs.map((d) => ({
    id: d.id,
    data: () => d.data() as { calendarSyncId?: unknown } | undefined,
  }));
  const resolved = pickCalendarIdFromDocs(docs);
  if (!resolved) {
    throw new HttpsError('failed-precondition', 'calendar_id_not_configured');
  }
  return resolved;
}

/**
 * The last-run receipt, merged onto the business_settings doc that holds the
 * calendar id. Four flat fields, no nested map, because three clients read
 * them straight off a document they already load.
 *
 * This exists because a Run Sync button that reports nothing is a button the
 * operator presses twice: the callable's return value is gone the moment the
 * screen reloads, and the audit log it already writes is not client-readable.
 * A run that FAILED is stamped too, with its cause, so "the sync is broken"
 * survives the reload that would otherwise leave the panel looking untouched.
 */
export interface CalendarSyncStamp {
  calendarSyncLastRunAt: string; // ISO-8601
  calendarSyncLastStatus: 'ok' | 'error';
  calendarSyncLastImported: number;
  calendarSyncLastError: string; // '' on success
}

/** Pure builder for the receipt, so its field names and success/error split are unit-testable. */
export function calendarSyncStamp(
  outcome: { status: 'ok'; imported: number } | { status: 'error'; error: string },
  nowIso: string,
): CalendarSyncStamp {
  return {
    calendarSyncLastRunAt: nowIso,
    calendarSyncLastStatus: outcome.status,
    calendarSyncLastImported: outcome.status === 'ok' ? outcome.imported : 0,
    calendarSyncLastError: outcome.status === 'ok' ? '' : outcome.error,
  };
}

/**
 * #1162: removing the rows of busy events that were moved or deleted in Google.
 *
 * The sync upserts one row per busy interval (one per business day since
 * #1160) keyed by the interval's instants, so a moved event gets NEW keys and
 * a deleted one gets none. Without this its old rows stay, and they are not
 * only drawn: the server busy guard and admin Android's busy check both refuse
 * bookings over them.
 *
 * DELETED, not marked inactive. These rows are a mirror of Google, rebuilt by
 * the next sync whenever the event is still there; nothing references a row by
 * id and `deleteBlockedTimeSlot` already tells the operator they are not
 * theirs to keep. An inactive flag would have to be honoured by every reader
 * on four surfaces (server guard, admin web, admin Android, desktop console),
 * and one missed reader would keep refusing bookings. The count and the
 * removed keys go to the audit entry and the log instead.
 *
 * Only a row that passes EVERY test below is removed:
 *   - `source` is `GOOGLE_BUSY_IMPORT` and `externalCalendarId` is the calendar
 *     this run fetched. Operator blocks and other calendars are never touched.
 *   - its key is not one this run fetched.
 *   - the whole event (all its `_dN` day rows together) decodes to instants
 *     that lie inside the window this run asked Google about. Freebusy says
 *     nothing about time outside it, so a row past the look-ahead, or one that
 *     began before this run's start, is kept. A row that does not decode is kept.
 *   - it was not written by a run that started after this one
 *     (`createdAt` is rewritten on every upsert), so two overlapping syncs do
 *     not delete each other's fresh rows.
 * And the cleanup runs at all only when the fetch was complete; see
 * `fetchIncompleteReason`.
 */
export interface StaleCandidateRow {
  id: string;
  data: Record<string, unknown>;
}

export interface BusyCleanupWindow {
  /** Epoch ms the freebusy query started at (its `timeMin`). */
  startMs: number;
  /** Epoch ms the freebusy query ended at (its `timeMax`). */
  endMs: number;
}

const GOOGLE_BUSY_SOURCE = 'GOOGLE_BUSY_IMPORT';

/** A day row's event key: its own key with any `_dN` day suffix taken off. */
export function busyEventKeyOf(externalEventId: string): string {
  return externalEventId.replace(/_d\d+$/, '');
}

/**
 * Pure: which of `rows` are stale imports of `calendarId` this run may delete.
 * See the note above for each test.
 */
export function staleBusyRowIds(
  rows: readonly StaleCandidateRow[],
  calendarId: string,
  fetchedKeys: ReadonlySet<string>,
  window: BusyCleanupWindow,
  runStartedAtIso: string,
): string[] {
  const groups = new Map<string, Array<{ id: string; startMs: number; endMs: number } | null>>();
  for (const row of rows) {
    const d = row.data;
    if (d['source'] !== GOOGLE_BUSY_SOURCE) continue;
    if (d['externalCalendarId'] !== calendarId) continue;
    const key = d['externalEventId'];
    if (typeof key !== 'string' || key.length === 0) continue;
    const eventKey = busyEventKeyOf(key);
    const list = groups.get(eventKey) ?? [];
    groups.set(eventKey, list);
    // Any day row the run fetched, or that a newer run wrote, keeps its whole event.
    const createdAt = d['createdAt'];
    const newer = typeof createdAt === 'string' && createdAt >= runStartedAtIso;
    if (fetchedKeys.has(key) || newer) {
      list.push(null);
      continue;
    }
    const instants = storedInstants(d) ?? legacyUtcWindow(d['date'], d['startTime'], d['endTime']);
    list.push(instants ? { id: row.id, ...instants } : null);
  }

  const out: string[] = [];
  for (const list of groups.values()) {
    if (list.some((r) => r === null)) continue;
    const pieces = list as Array<{ id: string; startMs: number; endMs: number }>;
    const startMs = Math.min(...pieces.map((p) => p.startMs));
    const endMs = Math.max(...pieces.map((p) => p.endMs));
    if (startMs < window.startMs || endMs > window.endMs) continue;
    for (const p of pieces) out.push(p.id);
  }
  return out;
}

/**
 * Why this run's answer from Google cannot be trusted as the whole picture,
 * or null when it can. Any reason here skips the cleanup (the import itself
 * still runs as before): a missing calendar block or `busy` list would
 * otherwise read as "nothing is busy" and delete every row in the window.
 */
export function fetchIncompleteReason(calBlock: { busy?: unknown } | undefined): string | null {
  if (!calBlock) return 'calendar_missing_from_response';
  if (!Array.isArray(calBlock.busy)) return 'busy_list_missing';
  for (const b of calBlock.busy as Array<{ start?: unknown; end?: unknown } | null | undefined>) {
    if (!b || typeof b.start !== 'string' || !b.start || typeof b.end !== 'string' || !b.end) {
      return 'busy_interval_unreadable';
    }
  }
  return null;
}

/** Firestore's hard cap on writes per WriteBatch. */
const DELETE_BATCH_LIMIT = 500;

/** How many removed keys the log line carries, so one bad run cannot flood it. */
const LOGGED_KEYS_CAP = 50;

export interface SyncResult {
  imported: number;
  scanned: number;
  /** The stamp's timestamp, so a client renders the receipt without re-reading the doc. */
  ranAt: string;
}

export async function syncGoogleCalendarBusyEventsHandler(
  req: CallableRequest<unknown>,
): Promise<SyncResult> {
  initSentry();
  const uid = req.auth?.uid;
  // defense-in-depth, wrapAdminCallable already enforces admin.
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = Args.safeParse(req.data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'lookAheadDays must be a number');
  }
  const lookAheadDays = clampLookAheadDays(parsed.data.lookAheadDays);

  // UI-entered calendarSyncId (business_settings) is the only source. Throws
  // failed-precondition / 'calendar_id_not_configured' when it is not set.
  // Resolved OUTSIDE the try below because with no configured doc there is
  // nowhere to stamp the failure; the panel already says "Not configured".
  const setting = await resolveCalendarId(db());

  try {
    return await runSync(setting, lookAheadDays, uid);
  } catch (err) {
    // Every failure past this point is stamped before it is rethrown, so the
    // panel still says what went wrong after the operator reloads. The stamp
    // write is best-effort: if IT fails the ORIGINAL error is the one worth
    // surfacing, and the stamp failure is logged rather than swallowed.
    await stampRun(
      setting.docId,
      calendarSyncStamp({ status: 'error', error: errorText(err) }, new Date().toISOString()),
      uid,
    );
    throw err;
  }
}

/** The sync proper. Split out so the caller owns the one place failures get stamped. */
async function runSync(
  setting: CalendarIdSetting,
  lookAheadDays: number,
  uid: string,
): Promise<SyncResult> {
  const calId = setting.calendarId;

  // SHAPE CHECK BEFORE THE ROUND TRIP. A typo'd id is answered by Google with
  // `notFound`, and `primary` is answered with an empty calendar; both would
  // otherwise reach the operator as "Imported 0 busy blocks", which reads as a
  // clear calendar rather than a wrong id. See lib/calendarSyncId.ts.
  const problem = calendarIdProblem(calId);
  if (problem) {
    logEvent({
      severity: 'warn',
      function: 'syncGoogleCalendarBusyEvents',
      event: 'gcal.calendar_id.invalid',
      uid,
      extra: { calendarId: calId },
    });
    throw new HttpsError('failed-precondition', problem, { code: CALENDAR_ID_INVALID_CODE });
  }

  const now = new Date();
  const window: BusyCleanupWindow = {
    startMs: now.getTime(),
    endMs: now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000,
  };
  const timeMin = new Date(window.startMs).toISOString();
  const timeMax = new Date(window.endMs).toISOString();

  // Loaded here rather than at file scope, and the one-API package rather than
  // the `googleapis` bundle. At file scope the bundle's 109MiB was charged to
  // the cold start of all 227 functions; deferred to here it was still +97 MiB
  // at the moment of use, which on its own put this function over a 256MiB
  // limit. `@googleapis/calendar` is the same generated client for the same API
  // and costs +0.9 MiB. See lib/googleOAuth.ts for the full argument, the numbers,
  // and why `await import()` and not `require()`.
  const { auth: googleAuth, calendar: calendarApi } = await import('@googleapis/calendar');

  // ADC: resolves the Functions runtime service account, no key file shipped.
  const auth = new googleAuth.GoogleAuth({
    // Least privilege: free/busy only. The freebusy.query below returns busy
    // intervals (start/end) and never event titles, attendees, or descriptions.
    // The calendar is shared at "free/busy only" so no personal detail can leak
    // into the apps even via this token.
    scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
  });
  const calendar = calendarApi({ version: 'v3', auth });

  let busy: BusyInterval[];
  // #1162: set when the answer cannot be trusted as complete; the cleanup then does not run.
  let incomplete: string | null;
  try {
    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: calId }],
      },
    });
    const calBlock = resp.data.calendars?.[calId];
    // freebusy can return a per-calendar `errors` array (e.g. notFound) with a
    // 200 envelope. Treat that as the not-shared / not-found fail-loud case, but
    // first log the raw per-calendar errors + reasons so the operator sees the
    // exact Google reason (notFound vs another failure) and surface a distinct,
    // reason-specific message (a typo'd calendar id or a share to the wrong
    // address both come back as `notFound`, which the message calls out).
    if (calBlock?.errors && calBlock.errors.length > 0) {
      const reasons = calBlock.errors
        .map((e) => (typeof e?.reason === 'string' ? e.reason : ''))
        .filter((r): r is string => r.length > 0);
      logEvent({
        severity: 'warn',
        function: 'syncGoogleCalendarBusyEvents',
        event: 'gcal.freebusy.calendar_error',
        uid,
        extra: { calendarId: calId, reasons, errors: calBlock.errors },
      });
      throw new HttpsError('permission-denied', calendarFreebusyErrorMessage(calId, reasons));
    }
    incomplete = fetchIncompleteReason(calBlock);
    busy = (calBlock?.busy ?? [])
      .filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
      .map((b) => ({ start: b.start, end: b.end }));
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    const status = extractGoogleStatus(err);
    if (status === 403 || status === 404) {
      logEvent({
        severity: 'warn',
        function: 'syncGoogleCalendarBusyEvents',
        event: 'gcal.freebusy.not_shared',
        uid,
        extra: { status, calendarId: calId },
      });
      throw new HttpsError('permission-denied', calendarNotSharedMessage(calId));
    }
    logEvent({
      severity: 'warn',
      function: 'syncGoogleCalendarBusyEvents',
      event: 'gcal.freebusy.failed',
      uid,
      extra: { status: status ?? 'unknown' },
    });
    throw new HttpsError('unavailable', `gcal_${status ?? 'error'}`);
  }

  // #1160: rows are written on the business's clock, the clock every client
  // draws `booking_time_slots` on, with the real instants alongside.
  const timeZone = businessTimeZone((await db().doc(BUSINESS_SETTINGS_DOC).get()).data());
  const nowIso = new Date().toISOString();
  // Counts busy EVENTS, not rows: an event that crosses business midnight is
  // stored as one row per day, and the receipt says how many events landed.
  let imported = 0;
  const fetchedKeys = new Set<string>();
  for (const interval of busy) {
    const slots = busyIntervalToSlots(interval, calId, nowIso, timeZone);
    // An interval that maps to no rows has no key in the fetched set, so its
    // old rows would look stale: the answer is not complete enough to clean by.
    if (slots.length === 0) incomplete ??= 'busy_interval_unreadable';
    for (const slot of slots) {
      fetchedKeys.add(slot.externalEventId);
      // The first day's key is the interval's own key, unchanged from before
      // #1160, so this finds a legacy UTC row and rewrites it in place.
      const existing = await db()
        .collection('booking_time_slots')
        .where('externalEventId', '==', slot.externalEventId)
        .limit(1)
        .get();
      const ref = existing.docs.length === 0
        ? db().collection('booking_time_slots').doc()
        : db().collection('booking_time_slots').doc(existing.docs[0].id);
      await ref.set(slot, { merge: true });
    }
    if (slots.length > 0) imported += 1;
  }

  // #1162. Runs only after every upsert above succeeded (any failure there has
  // already thrown), and only on a complete answer from Google.
  let removed = 0;
  if (incomplete === null) {
    removed = await removeStaleBusyRows(calId, fetchedKeys, window, timeMin, uid);
  } else {
    logEvent({
      severity: 'warn',
      function: 'syncGoogleCalendarBusyEvents',
      event: 'gcal.sync.cleanup_skipped',
      uid,
      extra: { calendarId: calId, reason: incomplete },
    });
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.INTEGRATION_CALENDAR_SYNC,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'booking_time_slots',
    description: `Imported ${imported} Google busy blocks, removed ${removed} stale`,
    payload: {
      count: imported,
      removed,
      cleanupSkipped: incomplete ?? '',
      lookAheadDays,
      calendarId: calId,
    },
  });

  const stamp = calendarSyncStamp({ status: 'ok', imported }, new Date().toISOString());
  await stampRun(setting.docId, stamp, uid);

  logEvent({
    severity: 'info',
    function: 'syncGoogleCalendarBusyEvents',
    event: 'gcal.sync.complete',
    uid,
    extra: { imported, removed, cleanupSkipped: incomplete ?? '', scanned: busy.length, lookAheadDays },
  });

  return { imported, scanned: busy.length, ranAt: stamp.calendarSyncLastRunAt };
}

/**
 * Deletes this calendar's stale import rows (see `staleBusyRowIds`) in
 * batches of at most 500. A failed commit throws, so the run is stamped as an
 * error and the operator sees it; a stale row left behind keeps refusing
 * bookings, which is not something to swallow.
 */
async function removeStaleBusyRows(
  calId: string,
  fetchedKeys: ReadonlySet<string>,
  window: BusyCleanupWindow,
  runStartedAtIso: string,
  uid: string,
): Promise<number> {
  // One equality filter, the rest in memory: the same rule `loadGoogleBusySlots`
  // follows for this collection, so no composite index is needed.
  const snap = await db()
    .collection('booking_time_slots')
    .where('externalCalendarId', '==', calId)
    .get();
  const rows: StaleCandidateRow[] = snap.docs.map((d) => ({
    id: d.id,
    data: (d.data() ?? {}) as Record<string, unknown>,
  }));
  const ids = staleBusyRowIds(rows, calId, fetchedKeys, window, runStartedAtIso);
  for (let i = 0; i < ids.length; i += DELETE_BATCH_LIMIT) {
    const batch = db().batch();
    for (const id of ids.slice(i, i + DELETE_BATCH_LIMIT)) {
      batch.delete(db().collection('booking_time_slots').doc(id));
    }
    await batch.commit();
  }
  if (ids.length > 0) {
    const keyById = new Map(rows.map((r) => [r.id, r.data['externalEventId']]));
    logEvent({
      severity: 'info',
      function: 'syncGoogleCalendarBusyEvents',
      event: 'gcal.sync.stale_removed',
      uid,
      extra: {
        calendarId: calId,
        removed: ids.length,
        keys: ids.slice(0, LOGGED_KEYS_CAP).map((id) => keyById.get(id)),
      },
    });
  }
  return ids.length;
}

/**
 * Merges the last-run receipt onto the business_settings doc that holds the
 * calendar id. Best-effort BY DESIGN: on the failure path the caller is already
 * rethrowing a more informative error, and losing the receipt must not replace
 * "the calendar is not shared" with "could not write settings". The loss is
 * logged, not swallowed.
 */
async function stampRun(docId: string, stamp: CalendarSyncStamp, uid: string): Promise<void> {
  try {
    await db().collection(BUSINESS_SETTINGS_COLLECTION).doc(docId).set(stamp, { merge: true });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'syncGoogleCalendarBusyEvents',
      event: 'gcal.sync.stamp_failed',
      uid,
      extra: { docId, reason: errorText(err) },
    });
  }
}

/** The message an operator should see, from whatever the throw site produced. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Calendar sync failed.';
}

export function calendarNotSharedMessage(calId: string): string {
  return (
    `calendar_not_shared: share calendar ${calId} with ${CALENDAR_SYNC_SA_EMAIL} ` +
    `at "See only free/busy (hide details)" so the sync service account can read availability.`
  );
}

/**
 * Distinct, reason-specific message for the freebusy per-calendar `errors`
 * array (200 envelope with an error block, not an HTTP 4xx). `notFound` is the
 * reason Google returns both when the calendar id is wrong AND when the calendar
 * was shared with the WRONG address (so the sync SA still cannot see it), so the
 * message names the EXACT service account + calendar id and calls out the typo
 * case explicitly. Other reasons fall back to a generic-but-named message.
 */
export function calendarFreebusyErrorMessage(calId: string, reasons: string[]): string {
  if (reasons.includes('notFound')) {
    return (
      `calendar_not_shared: Google returned notFound for calendar ${calId}. The calendar id may ` +
      `be mistyped, OR it was shared with the wrong address so ${CALENDAR_SYNC_SA_EMAIL} still ` +
      `cannot see it. Share calendar ${calId} with EXACTLY ${CALENDAR_SYNC_SA_EMAIL} (double-check ` +
      `the domain for a typo) at "See only free/busy (hide details)" so the sync service account ` +
      `can read availability.`
    );
  }
  const reasonStr = reasons.length > 0 ? reasons.join(', ') : 'unknown';
  return (
    `calendar_freebusy_error (${reasonStr}) for calendar ${calId}: confirm the calendar is shared ` +
    `with ${CALENDAR_SYNC_SA_EMAIL} at "See only free/busy (hide details)".`
  );
}

/** Best-effort HTTP status extraction across Google API client error shapes. */
function extractGoogleStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  return undefined;
}

export const syncGoogleCalendarBusyEvents = onCall(
  {
    region: 'us-central1',
    serviceAccount: CALENDAR_SYNC_SA_EMAIL,
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapAdminCallable('syncGoogleCalendarBusyEvents', syncGoogleCalendarBusyEventsHandler),
);
