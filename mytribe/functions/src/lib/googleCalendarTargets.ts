/**
 * The rules for the calendar AuntieOS WRITES to, and the one place their
 * operator-facing explanations are written.
 *
 * This is the OAuth half of the calendar work (Task 7.2). The service-account
 * half (Task 7.1, `lib/calendarSyncId.ts`) only ever READS free/busy, so the
 * two have different rules and the differences are deliberate:
 *
 *   - `primary` IS ALLOWED HERE and is refused there. Under the service account
 *     `primary` means the sync robot's own calendar, which is permanently
 *     empty, so it would import nothing forever. Under OAuth `primary` means
 *     the calendar of the Google account the operator just signed in with,
 *     which is a real, writable calendar and a perfectly sensible target.
 *   - THE WRITE TARGET MUST NOT BE THE FREE/BUSY CALENDAR. Writing our visits
 *     into the calendar the free/busy sync imports FROM would feed our own
 *     events back to us as imported BLOCKED slots: every pushed visit would
 *     block out the time of the visit it came from, and the Schedule would show
 *     the same hour as both a booking and as unavailable. That is the echo loop,
 *     and refusing the overlap is what prevents it. There is no field either
 *     side could carry to break the loop after the fact: `freebusy.query`
 *     returns start/end and nothing else, so an imported busy block cannot be
 *     traced back to the event that produced it.
 *
 * MIRRORED, deliberately, in the two clients so the operator is told before the
 * round trip rather than after it:
 *   - `auntieos-admin/src/lib/googleCalendarTargets.ts` (React admin)
 *   - `auntieos-admin/android/.../ui/admin/scheduling/GoogleCalendarTargets.kt`
 * This copy is the enforcement; those two are the courtesy, exactly as
 * `calendarSyncId.ts` splits them. The cases the three must agree on are frozen
 * in `test/callableContract.test.ts`. See `CALLABLE_CONTRACT.md`.
 */

/** Machine-readable `details.code`s, so clients branch on them rather than on message text. */
export const GOOGLE_OAUTH_NOT_CONFIGURED_CODE = 'google_oauth_not_configured';
export const GOOGLE_CALENDAR_NOT_CONNECTED_CODE = 'google_calendar_not_connected';
export const GOOGLE_OAUTH_REVOKED_CODE = 'google_oauth_revoked';
export const WRITE_CALENDAR_INVALID_CODE = 'write_calendar_invalid';

/** Same address shape as a free/busy id: a local part, an `@`, and a dotted domain. */
const CALENDAR_ID_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The literal Google accepts for "the signed-in account's own calendar". */
export const PRIMARY_CALENDAR_ID = 'primary';

/**
 * What `primary` actually points at, so two spellings of one calendar cannot be
 * mistaken for two calendars. The operator can share their OWN calendar with
 * the free/busy service account and then pick `primary` as the write target;
 * the raw strings differ, the calendar does not, and the echo loop would be
 * live. Comparing resolved ids is what catches that.
 *
 * Case-folded because Google treats calendar ids (they are addresses)
 * case-insensitively, while string equality does not.
 */
export function resolveCalendarId(rawId: string, connectedAccountEmail: string): string {
  const value = rawId.trim().toLowerCase();
  if (value === PRIMARY_CALENDAR_ID) return connectedAccountEmail.trim().toLowerCase();
  return value;
}

/**
 * The operator-facing reason `writeCalendarId` cannot be the calendar we write
 * visits to, or `null` when it can be.
 *
 * `freeBusyCalendarId` is `business_settings.calendarSyncId` (empty when the
 * free/busy sync is not set up, in which case there is nothing to collide with).
 * `connectedAccountEmail` is the Google account the OAuth connection belongs to,
 * used only to resolve `primary`; pass `''` before a connection exists and
 * `primary` simply cannot be compared, which is why this is also enforced
 * server-side at write time.
 */
export function writeCalendarProblem(
  writeCalendarId: string,
  freeBusyCalendarId: string,
  connectedAccountEmail: string,
): string | null {
  const value = writeCalendarId.trim();
  if (value === '') {
    return 'Pick the calendar AuntieOS should write visits to.';
  }
  if (value.toLowerCase() !== PRIMARY_CALENDAR_ID && !CALENDAR_ID_PATTERN.test(value)) {
    return (
      `"${value}" is not a Google Calendar ID. Pick one from the list of calendars on the ` +
      `connected account rather than typing it, so the ID matches what Google expects.`
    );
  }
  const freeBusy = freeBusyCalendarId.trim().toLowerCase();
  if (freeBusy === '') return null;
  if (resolveCalendarId(value, connectedAccountEmail) === freeBusy) {
    return (
      'That is the calendar the free/busy sync already imports from, so every visit written to ' +
      'it would come straight back as blocked-out time and the Schedule would show the same hour ' +
      'twice. Pick a different calendar for visits, or clear the Calendar ID above first.'
    );
  }
  return null;
}
