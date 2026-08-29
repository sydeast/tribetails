/**
 * The account `seed.ts` creates in the auth emulator, and the household it
 * belongs to, named once so a spec, the seeder and the callable stubs can never
 * drift apart.
 *
 * These are emulator-only credentials for a database that is destroyed when the
 * run ends. They are checked in on purpose: a harness that reads its login out
 * of the environment fails on a fresh clone with a message about a missing
 * variable, and the next person's fix is to invent one.
 */

/**
 * ONE kinfolk, ONE tribe, and not an operator.
 *
 * That is the portal's only supported shape for a kinfolk (operator ruling
 * 2026-08-06, "one kinfolk, one tribe"), and it is also the only shape that
 * routes to `/home`. `resolveLaunchDestination` sends 0 ids to `/no-tribes`,
 * an operator to `/pick`, and a non-operator with 2+ ids to `/error` as a data
 * defect. A seed that got this wrong would not fail; it would quietly route
 * every spec to a dead-end screen that renders perfectly.
 */
export const KINFOLK = {
  email: 'e2e-kinfolk@mytribe.test',
  password: 'e2e-emulator-kinfolk-pw',
  kinfolkId: 'e2e-portal-kf-1',
  displayName: 'The Wren Household',
} as const;
