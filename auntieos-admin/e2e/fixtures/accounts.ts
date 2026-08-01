/**
 * The accounts `seed.mjs` creates in the auth emulator, named once so a spec and
 * the seeder can never drift apart.
 *
 * These are emulator-only credentials for a database that is destroyed when the
 * run ends. They are checked in on purpose: a harness that reads its login out
 * of the environment fails on a fresh clone with a message about a missing
 * variable, and the next person's fix is to invent one, which is how the visual
 * harness came to need a `.env` nobody has.
 */

export const ADMIN = {
  email: 'e2e-admin@auntieos.test',
  password: 'e2e-emulator-admin-pw',
} as const;

/**
 * A kinfolk account: authenticates fine, carries no `admin` claim and no
 * `testTribeId`, and so must be REFUSED by the admin gate. The portal and the
 * admin share one Firebase project, so this is not a hypothetical user, it is
 * every kinfolk who mistypes the admin URL.
 */
export const KINFOLK = {
  email: 'e2e-kinfolk@auntieos.test',
  password: 'e2e-emulator-kinfolk-pw',
} as const;

/**
 * Seeded `kin_care_sessions` rows the bookings spec asserts against.
 *
 * `today` was added on 2026-08-01 and is not decoration. Schedule's agenda
 * lists the SELECTED day and the selection defaults to today, so a database
 * whose nearest visit is three days out renders an empty agenda and its row
 * grid cannot be measured at any viewport. Its household name is long on
 * purpose: a two-word name fits any layout, so a row that only ever holds one
 * proves nothing about the column widths.
 */
export const SEEDED_BOOKINGS = {
  today: {
    id: 'e2e-sess-today',
    kinfolkName: 'Constance Fairweather-Okonkwo',
    serviceType: 'Overnight stay',
  },
  scheduled: { id: 'e2e-sess-scheduled', kinfolkName: 'Wanda Thorne', serviceType: 'Drop-in visit' },
  completed: { id: 'e2e-sess-completed', kinfolkName: 'Nora Halbrook', serviceType: 'Overnight stay' },
  cancelled: { id: 'e2e-sess-cancelled', kinfolkName: 'Tessa Brooks', serviceType: 'Dog walk' },
} as const;
