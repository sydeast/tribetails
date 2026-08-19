/**
 * The fixed instant `callableStubs.ts` dates every stubbed response against.
 *
 * This file used to carry the whole react capture surface's determinism pins:
 * timezone, locale, output directory, demo document ids. That surface went with
 * the visual golden system on 2026-08-18, and the one constant with a caller
 * left is the clock.
 *
 * It stays a NAMED CONSTANT rather than a literal inside the stubs because
 * every fixture derived from it has to move together. A stub that computed
 * "three days from now" against the wall clock would hand a different answer to
 * every run of `phone-layout.spec.ts`, which is the flake a pinned instant
 * exists to prevent.
 *
 * Chosen a little after midday UTC so that no `YYYY-MM-DD` day grouping sits on
 * a midnight boundary where a one-hour zone slip would move a row to another
 * day heading.
 */
export const VISUAL_NOW = '2026-08-04T12:00:00.000Z';
