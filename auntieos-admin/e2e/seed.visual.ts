import baseSeed from './seed';
import { VISUAL_NOW } from './visual/fixtures';

/**
 * One instant, named once. The browser freezes its clock at `VISUAL_NOW` and the
 * seed dates itself against the same value, so neither the npm script nor
 * anything else has to repeat the literal and get it subtly wrong. An explicit
 * `E2E_SEED_NOW` still wins, for the operator who wants to see what a different
 * "today" looks like before recording.
 *
 * It has to be set BEFORE `baseSeed` runs, which is why it is a module-level
 * statement and not the first line of the function: `seed.ts` reads it through
 * `seedNow()` on every row it writes.
 */
process.env.E2E_SEED_NOW ??= VISUAL_NOW;

/**
 * globalSetup for the REACT VISUAL surface only (`VISUAL_CAPTURE=1`).
 *
 * Until 2026-08-01 this file also carried every invoice, notification, activity
 * and KinTale row in the harness, so the ordinary `npm run e2e` database had
 * two households and three visits and every list screen rendered empty. Those
 * rows now live in `seed.rows.ts` and `seed.ts` writes them, so both surfaces
 * see one database with one set of content. The only thing left that is
 * capture-specific is the frozen clock above.
 *
 * It is kept as a distinct globalSetup rather than collapsed into `seed.ts`
 * because that clock is exactly what must NOT leak into the ordinary run: a
 * suite pinned to a fixed "today" stops testing the rolling windows the screens
 * compute from the real one.
 */
export default async function seedForVisuals(): Promise<void> {
  await baseSeed();
}
