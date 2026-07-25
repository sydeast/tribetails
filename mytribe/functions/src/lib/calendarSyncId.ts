/**
 * The one rule for what counts as a Google Calendar ID, and the one place the
 * operator-facing explanation of a bad one is written.
 *
 * Why this exists at all: the free/busy sync reads whatever string
 * `business_settings.calendarSyncId` holds and hands it to Google. A mistyped
 * id does not error in an obvious way. Google answers a `freebusy.query` for an
 * id it cannot see with `notFound` in a 200 envelope, and an id that happens to
 * resolve to an empty calendar answers with an empty `busy` array. Both land in
 * the admin as "Imported 0 busy blocks", which reads as "the calendar is clear"
 * rather than "you typed it wrong". Checking the SHAPE before the call is what
 * separates those two, so a typo can never be reported as an empty calendar.
 *
 * `primary` is called out on its own because it is the one wrong value that is
 * a legal calendar id. It means "the authenticated identity's own calendar",
 * and the authenticated identity here is the sync service account, whose
 * calendar is permanently empty. It would sync forever, successfully, and
 * import nothing.
 *
 * MIRRORED, deliberately, in two clients so the operator is told before the
 * round trip rather than after it:
 *   - `auntieos-admin/src/lib/calendarSyncId.ts` (React admin)
 *   - `auntieos-admin/android/.../ui/admin/scheduling/CalendarSyncId.kt`
 * This copy is the enforcement; those two are the courtesy. See
 * `CALLABLE_CONTRACT.md`.
 */

/** Machine-readable `details.code` on the rejection, so clients branch on it rather than the message. */
export const CALENDAR_ID_INVALID_CODE = 'calendar_id_invalid';

/** The shape every shared Google Calendar id takes. Used in copy, not as a default. */
export const CALENDAR_ID_EXAMPLE = 'name@group.calendar.google.com';

/**
 * A Google Calendar id is an address: a local part, an `@`, and a dotted
 * domain. Shared calendars are `<hash>@group.calendar.google.com`; a person's
 * primary calendar is their email address. Nothing else Google issues is
 * addressable through `freebusy.query`.
 */
const CALENDAR_ID_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns the operator-facing reason `raw` cannot be a calendar id, or `null`
 * when it can be. Never throws, and never guesses at a correction: an id that
 * passes this may still be one the service account cannot see, which is the
 * `notFound` path the sync itself reports.
 */
export function calendarIdProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === '') {
    return `Enter the shared calendar's ID first. It looks like ${CALENDAR_ID_EXAMPLE}.`;
  }
  if (value.toLowerCase() === 'primary') {
    return (
      '"primary" means the sync service account\'s own calendar, which is always empty, so every ' +
      `sync would import nothing and report success. Paste the shared calendar's ID instead, the ` +
      `one that looks like ${CALENDAR_ID_EXAMPLE}.`
    );
  }
  if (!CALENDAR_ID_PATTERN.test(value)) {
    return (
      `"${value}" is not a Google Calendar ID, so a sync would import nothing and look like an ` +
      `empty calendar. Copy the ID from Google Calendar under Settings, Integrate calendar. It ` +
      `looks like ${CALENDAR_ID_EXAMPLE}, or the calendar owner's email address.`
    );
  }
  return null;
}
