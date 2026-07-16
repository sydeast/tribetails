import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { google } from 'googleapis';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';

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
 */

/**
 * Service account the operator must share the calendar with. This is the
 * identity ADC resolves at runtime when the function's `serviceAccount` option
 * is pinned below. It is surfaced verbatim in the fail-loud error message and
 * is the operator-facing source of truth (see GOOGLE_CALENDAR_SETUP.md).
 */
export const CALENDAR_SYNC_SA_EMAIL =
  'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com';

const argsSchema = z.object({
  lookAheadDays: z.number().int().optional(),
});

export interface BusyInterval {
  start: string; // RFC3339
  end: string; // RFC3339
}

export interface BookingTimeSlotDoc {
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  isAvailable: false;
  slotType: 'BLOCKED';
  notes: string;
  source: 'GOOGLE_BUSY_IMPORT';
  externalEventId: string;
  externalCalendarId: string;
  hideDetailsFromKinfolk: true;
  isEditableByAdmin: true;
  isRemovableByAdmin: true;
  syncState: 'SYNCED';
  createdAt: string; // ISO-8601
}

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
 * Pure resolution of the calendar id from a list of business_settings docs.
 * The UI-entered value is the single source of truth:
 *   1. First doc (other than feature_flags) whose `calendarSyncId` is a
 *      non-empty trimmed string, trimmed.
 *   2. Otherwise undefined (caller fails loud).
 * Unit-testable without Firestore.
 */
export function pickCalendarIdFromDocs(
  docs: SettingsDocLike[],
): string | undefined {
  for (const doc of docs) {
    if (doc.id === FEATURE_FLAGS_DOC_ID) continue;
    const raw = doc.data()?.calendarSyncId;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > 0) return trimmed;
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
): Promise<string> {
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
 * Pure mapping from a Google freebusy Busy interval to the exact
 * `booking_time_slots` doc shape both Android (ServiceModels.kt) and the web
 * read. Time-zone: we format in UTC so the server write is deterministic and
 * test-stable; the slot is a coarse BLOCKED marker, not an exact-minute claim.
 */
export function busyIntervalToSlot(
  interval: BusyInterval,
  calendarId: string,
  nowIso: string,
): BookingTimeSlotDoc {
  const start = new Date(interval.start);
  const end = new Date(interval.end);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const externalEventId = `busy_${calendarId}_${startMs}_${endMs}`;
  return {
    date: isoDate(start),
    startTime: isoTime(start),
    endTime: isoTime(end),
    isAvailable: false,
    slotType: 'BLOCKED',
    notes: 'Imported busy event',
    source: 'GOOGLE_BUSY_IMPORT',
    externalEventId,
    externalCalendarId: calendarId,
    hideDetailsFromKinfolk: true,
    isEditableByAdmin: true,
    isRemovableByAdmin: true,
    syncState: 'SYNCED',
    createdAt: nowIso,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function isoTime(d: Date): string {
  return d.toISOString().slice(11, 16); // HH:mm (UTC)
}

export interface SyncResult {
  imported: number;
  scanned: number;
}

export async function syncGoogleCalendarBusyEventsHandler(
  req: CallableRequest<unknown>,
): Promise<SyncResult> {
  initSentry();
  const uid = req.auth?.uid;
  // defense-in-depth, wrapAdminCallable already enforces admin.
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = argsSchema.safeParse(req.data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'lookAheadDays must be a number');
  }
  const lookAheadDays = clampLookAheadDays(parsed.data.lookAheadDays);

  // UI-entered calendarSyncId (business_settings) wins over the secret. Throws
  // failed-precondition / 'calendar_id_not_configured' when neither is set.
  const calId = await resolveCalendarId(db());

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000).toISOString();

  // ADC: resolves the Functions runtime service account, no key file shipped.
  const auth = new google.auth.GoogleAuth({
    // Least privilege: free/busy only. The freebusy.query below returns busy
    // intervals (start/end) and never event titles, attendees, or descriptions.
    // The calendar is shared at "free/busy only" so no personal detail can leak
    // into the apps even via this token.
    scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  let busy: BusyInterval[];
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
    // 200 envelope. Treat that as the not-shared / not-found fail-loud case.
    if (calBlock?.errors && calBlock.errors.length > 0) {
      throw new HttpsError('permission-denied', calendarNotSharedMessage(calId));
    }
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

  const nowIso = new Date().toISOString();
  let imported = 0;
  for (const interval of busy) {
    const slot = busyIntervalToSlot(interval, calId, nowIso);
    const existing = await db()
      .collection('booking_time_slots')
      .where('externalEventId', '==', slot.externalEventId)
      .limit(1)
      .get();
    const ref = existing.docs.length === 0
      ? db().collection('booking_time_slots').doc()
      : db().collection('booking_time_slots').doc(existing.docs[0].id);
    await ref.set(slot, { merge: true });
    imported += 1;
  }

  await writeAuditEntry({
    event: AUDIT_EVENTS.INTEGRATION_CALENDAR_SYNC,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'booking_time_slots',
    description: `Imported ${imported} Google busy blocks`,
    payload: { count: imported, lookAheadDays, calendarId: calId },
  });

  logEvent({
    severity: 'info',
    function: 'syncGoogleCalendarBusyEvents',
    event: 'gcal.sync.complete',
    uid,
    extra: { imported, scanned: busy.length, lookAheadDays },
  });

  return { imported, scanned: busy.length };
}

export function calendarNotSharedMessage(calId: string): string {
  return (
    `calendar_not_shared: share calendar ${calId} with ${CALENDAR_SYNC_SA_EMAIL} ` +
    `at "See only free/busy (hide details)" so the sync service account can read availability.`
  );
}

/** Best-effort HTTP status extraction across googleapis error shapes. */
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
