/**
 * The calendar the e2e harness's "today" is on: the BUSINESS's, never the
 * machine's (#1231).
 *
 * Since #1158 the admin Schedule draws "today", its selected day and every
 * agenda row on `business_settings.timeZone`. The seed writes no
 * `business_settings` doc and no spec writes a `timeZone`, so the screen
 * resolves the server's default, `DEFAULT_BUSINESS_TIME_ZONE` in
 * `src/lib/businessOperations.ts`. A fixture that names "today" by the
 * runner's own date (UTC on CI) names TOMORROW from midnight UTC until 05:00
 * or 06:00, when Chicago has not reached midnight yet, and every Schedule
 * assertion about today fails in that window, whatever the day of the month.
 *
 * Written with `Intl` here rather than imported from `src/lib/businessZoneTime`
 * on purpose. That module's import chain reaches `src/lib/firebase.ts`, which
 * neither the Playwright nor the Cypress tsconfig can type (no `vite/client`),
 * and an oracle that is the app's own function would agree with the app even
 * when the app is wrong. The unit tests pin the app's function with literals.
 */
export const E2E_BUSINESS_ZONE = 'America/Chicago';

interface ZonedParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function zonedParts(ms: number): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: E2E_BUSINESS_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const get = (type: string) => Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Today's `YYYY-MM-DD` on the business calendar at `nowMs`. */
export function e2eBusinessTodayIso(nowMs: number): string {
  const p = zonedParts(nowMs);
  return `${String(p.y)}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/**
 * Noon on the business calendar's today, as a UTC ISO instant. Noon so a run
 * that takes a few minutes, or a DST change that night, cannot move the row
 * onto another business day.
 */
export function e2eBusinessNoonIso(nowMs: number): string {
  const p = zonedParts(nowMs);
  // Guess noon as if the zone were UTC, then correct by the zone's offset at
  // that instant. Noon is hours away from any DST change, so one pass is exact.
  const guess = Date.UTC(p.y, p.mo - 1, p.d, 12, 0);
  const at = zonedParts(guess);
  const offset = Date.UTC(at.y, at.mo - 1, at.d, at.h, at.mi) - guess;
  return new Date(guess - offset).toISOString();
}
