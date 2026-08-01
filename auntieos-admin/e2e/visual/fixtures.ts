/**
 * The constants that make the react visual surface reproducible.
 *
 * Everything here is a FIXED value that both the seed and the browser agree on.
 * If a number in this file changes, every golden changes with it, which is the
 * point: the drift is declared in one place instead of arriving through the
 * wall clock.
 */

/**
 * The instant the browser believes it is, and the instant the seed dates itself
 * against.
 *
 * `page.clock.setFixedTime(VISUAL_NOW)` pins `Date.now()` and `new Date()` in
 * the page; `E2E_SEED_NOW=VISUAL_NOW` pins the seed's relative dates. They have
 * to be the SAME instant or the two drift apart and a booking seeded "in three
 * days" renders as some other number of days. The seed's absolute `createdAt`
 * values were already fixed; only its `startTime` values were relative.
 *
 * Chosen a little after midday UTC so that no `YYYY-MM-DD` day grouping sits on
 * a midnight boundary where a one-hour zone slip would move a row to another
 * day heading.
 */
export const VISUAL_NOW = '2026-08-04T12:00:00.000Z';

/**
 * The browser's timezone and locale.
 *
 * NOT decoration. `lib/time.ts` formats with `getFullYear/getMonth/getDate/
 * getHours`, which read the LOCAL zone deliberately (the AO-18 fix), so the same
 * document renders a different day heading and a different clock time on a
 * laptop in Chicago and on a CI box in UTC. Locale pins every `Intl` call the
 * app or the platform makes: month names, number grouping, currency.
 */
export const VISUAL_TIMEZONE = 'UTC';
export const VISUAL_LOCALE = 'en-US';

/**
 * Document ids the visual seed writes and the manifest's param routes resolve
 * to. The Compose surface reads these from `VISUAL_DEMO_*_ID` environment
 * variables because it drives a live deployment whose ids only the operator
 * knows. This surface owns its database, so the ids are constants and there is
 * nothing to configure.
 *
 * Keys are the manifest's placeholder tokens, verbatim.
 */
export const VISUAL_DEMO_IDS: Readonly<Record<string, string>> = {
  __DEMO_INVOICE_ID__: 'vis-invoice-001',
  __DEMO_REPORT_ID__: 'vis-kintale-001',
  // `__DEMO_SCHEMA_ID__` is deliberately absent: the React admin has no URL for
  // one form schema (see routes.ts). An id here would resolve a route that does
  // not exist.
};

/** Where the react captures land, relative to the package root. */
export const VISUAL_OUT_DIR = 'visual/react';
