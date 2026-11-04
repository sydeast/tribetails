/**
 * Deletes the events a real-services run wrote to the "AuntieOS test" Google
 * calendar (#1517, the calendar half of #1089's D3).
 *
 * `run.sh` calls it from its EXIT trap, right after the Cloudinary cleanup,
 * so it runs whatever the run did. It never decides the run's verdict: a
 * failed delete is printed and the script exits 1, and `run.sh` reports that
 * and keeps the exit code it already had.
 *
 * WHAT IT MAY TOUCH. Only events on the calendar in `E2E_GOOGLE_CALENDAR_ID`
 * whose private extended property `tribetailsSessionId` names an e2e session
 * (`isE2eSessionId` below). That property is the marker the push writes on
 * every event it creates (`buildEventBody` in
 * `mytribe/functions/src/lib/googleCalendarVisitSync.ts`, pinned by
 * `test/pushVisitsToGoogleCalendar.test.ts`), and the e2e ids are the only
 * session ids the run's databases ever hold (`e2e-sess-*` from the run-wide
 * seed, `e2e-real-*` from a spec's own fixtures, `vis_e2e-real-*` from a
 * booking a spec accepted). An event with any other marker, or with none, is
 * listed and left alone: it is not ours to delete, whatever calendar it is on.
 * Every DELETE goes through `guardedDelete`, which refuses an event id that
 * did not come out of that filtered listing.
 *
 * WHY LIST AND FILTER, NOT QUERY BY PROPERTY. Google's `privateExtendedProperty`
 * filter is an exact match on `name=value`, and the ids carry a per-run stamp,
 * so there is no one value to ask for. The listing is bounded to the window
 * the push can write into (its look-ahead clamps at 90 days) plus a margin on
 * each side for a cleanup that failed on an earlier run. Listing reads the
 * calendar; it changes nothing.
 *
 * REFUSES `primary`. That is the connected account's own calendar. The seed
 * refuses it too, so a run pointed there pushes nothing and this script says
 * why instead of quietly listing a real calendar.
 *
 * NO CREDENTIALS IS A SKIP. With any of the four variables unset it prints
 * one line naming them and exits 0. The OAuth client values arrive from
 * Secret Manager by allowlist (`E2E_GOOGLE_OAUTH_*`), the token and the id
 * from the `e2e-real` GitHub environment; `run.sh`'s trap can fire before
 * either has been read, and that is a skip, not a failure.
 *
 * PRINTS COUNTS ONLY. Never the calendar id, the token, or an event's text.
 *
 * SELF-CONTAINED ON PURPOSE, like cloudinary-cleanup.mjs: standard library
 * only, no `@googleapis/calendar`, so it runs from the admin's scripts
 * directory with nothing installed beyond Node.
 */

/** The env variables the script reads: the OAuth client pair, then the two vendor extras. */
export const ENV_NAMES = [
  'E2E_GOOGLE_OAUTH_CLIENT_ID',
  'E2E_GOOGLE_OAUTH_CLIENT_SECRET',
  'E2E_GOOGLE_CALENDAR_REFRESH_TOKEN',
  'E2E_GOOGLE_CALENDAR_ID',
];

/** The private extended property the push writes on every event. */
export const MARKER = 'tribetailsSessionId';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
/** The push's look-ahead clamps at 90 days; a week either side covers a cleanup that failed last time. */
const WINDOW_BEFORE_MS = 7 * 86_400_000;
const WINDOW_AFTER_MS = 97 * 86_400_000;
const PAGE_SIZE = 250;

/**
 * True for the session ids the run's databases hold and nothing else: the
 * run-wide seed's `e2e-sess-*`, a spec's own `e2e-real-*`, and the `vis_`
 * prefix `manageBookingSeries` puts on a visit a spec accepted.
 */
export function isE2eSessionId(id) {
  return typeof id === 'string' && /^(vis_)?e2e-/.test(id);
}

/** The marker on an event as listed, or '' when it carries none. */
export function markerOf(event) {
  const raw = event?.extendedProperties?.private?.[MARKER];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Deletes the run's events. Never throws for an HTTP failure: every failure
 * is collected in `errors` so the caller can report it.
 *
 * Returns `{ skipped, missing, listed, deleted, kept, errors }`: `listed` is
 * every event in the window, `deleted` those with an e2e marker that are now
 * gone, `kept` the rest.
 */
export async function cleanupE2eCalendarEvents({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  now = Date.now(),
} = {}) {
  const missing = ENV_NAMES.filter((k) => (env[k] ?? '').trim() === '');
  if (missing.length > 0) {
    return { skipped: true, missing, listed: 0, deleted: 0, kept: 0, errors: [] };
  }
  const calendarId = env.E2E_GOOGLE_CALENDAR_ID.trim();
  const errors = [];
  if (calendarId.toLowerCase() === 'primary') {
    errors.push("E2E_GOOGLE_CALENDAR_ID is primary, the account's own calendar; refusing to list or delete anything on it");
    return { skipped: false, missing: [], listed: 0, deleted: 0, kept: 0, errors };
  }

  async function call(method, url, init = {}) {
    const res = await fetchImpl(url, { method, ...init });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  }

  function describe(what, r) {
    const msg = r.body?.error?.message ?? r.body?.error_description ?? r.body?.error ?? '';
    return `${what}: HTTP ${r.status}${typeof msg === 'string' && msg !== '' ? ` ${msg}` : ''}`;
  }

  // 1. An access token from the refresh token, as calendarClientForRefreshToken does.
  let accessToken = '';
  try {
    const r = await call('POST', TOKEN_URL, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.E2E_GOOGLE_OAUTH_CLIENT_ID.trim(),
        client_secret: env.E2E_GOOGLE_OAUTH_CLIENT_SECRET.trim(),
        refresh_token: env.E2E_GOOGLE_CALENDAR_REFRESH_TOKEN.trim(),
        grant_type: 'refresh_token',
      }),
    });
    if (!r.ok || typeof r.body?.access_token !== 'string' || r.body.access_token === '') {
      errors.push(describe('refresh the access token', r));
      return { skipped: false, missing: [], listed: 0, deleted: 0, kept: 0, errors };
    }
    accessToken = r.body.access_token;
  } catch (err) {
    errors.push(`refresh the access token: ${err.message}`);
    return { skipped: false, missing: [], listed: 0, deleted: 0, kept: 0, errors };
  }
  const auth = { Authorization: `Bearer ${accessToken}` };
  const events = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

  // 2. Every event in the window, following the page token.
  const ours = new Map();
  let listed = 0;
  let pageToken = null;
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({
      timeMin: new Date(now - WINDOW_BEFORE_MS).toISOString(),
      timeMax: new Date(now + WINDOW_AFTER_MS).toISOString(),
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: String(PAGE_SIZE),
      fields: 'nextPageToken,items(id,extendedProperties/private)',
    });
    if (pageToken) params.set('pageToken', pageToken);
    let r;
    try {
      r = await call('GET', `${events}?${params}`, { headers: auth });
    } catch (err) {
      errors.push(`list events: ${err.message}`);
      return { skipped: false, missing: [], listed, deleted: 0, kept: listed, errors };
    }
    if (!r.ok) {
      errors.push(describe('list events', r));
      return { skipped: false, missing: [], listed, deleted: 0, kept: listed, errors };
    }
    for (const item of r.body?.items ?? []) {
      if (typeof item?.id !== 'string' || item.id === '') continue;
      listed += 1;
      if (isE2eSessionId(markerOf(item))) ours.set(item.id, markerOf(item));
    }
    pageToken = typeof r.body?.nextPageToken === 'string' && r.body.nextPageToken !== '' ? r.body.nextPageToken : null;
    if (pageToken === null) break;
  }

  /** The one DELETE path. Refuses an id the filtered listing did not produce. */
  async function guardedDelete(eventId) {
    if (!ours.has(eventId)) throw new Error(`refused: ${eventId} was not listed with an e2e marker`);
    return call('DELETE', `${events}/${encodeURIComponent(eventId)}`, { headers: auth });
  }

  // 3. Ours, one by one. Already gone (404, 410) is the state we wanted.
  let deleted = 0;
  for (const eventId of ours.keys()) {
    try {
      const r = await guardedDelete(eventId);
      if (r.ok || r.status === 404 || r.status === 410) deleted += 1;
      else errors.push(describe(`delete event ${eventId}`, r));
    } catch (err) {
      errors.push(`delete event ${eventId}: ${err.message}`);
    }
  }

  const kept = listed - ours.size;
  log(`google-calendar-cleanup: listed ${listed} events on the test calendar, deleted ${deleted} with an e2e marker, left ${kept} alone`);
  return { skipped: false, missing: [], listed, deleted, kept, errors };
}

/** CLI: exit 0 on success or skip, 1 when any request failed. */
async function main() {
  const result = await cleanupE2eCalendarEvents();
  if (result.skipped) {
    console.log(`google-calendar-cleanup: skipped, ${result.missing.join(', ')} not set`);
    return 0;
  }
  if (result.errors.length > 0) {
    console.error(`google-calendar-cleanup: FAILED to clear the run's events from the test calendar (${result.errors.length}):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
