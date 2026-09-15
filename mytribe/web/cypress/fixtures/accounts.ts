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

/**
 * #892: accounts whose passwords the reset spec CHANGES. Kept apart from
 * KINFOLK because the seed runs once per run, and a spec that reset the shared
 * login would sign every later spec out of the suite.
 *
 * RESET_KINFOLK carries KINFOLK's household claim, so after the reset it signs
 * in to the same stubbed /home. STAFF carries the admin claim and never signs
 * in to the portal: its reset link continues to the admin site.
 */
export const RESET_KINFOLK = {
  email: 'e2e-reset-kinfolk@mytribe.test',
  password: 'e2e-emulator-reset-kinfolk-pw',
  kinfolkId: 'e2e-portal-kf-1',
} as const;

export const STAFF = {
  email: 'e2e-staff@mytribe.test',
  password: 'e2e-emulator-staff-pw',
} as const;
