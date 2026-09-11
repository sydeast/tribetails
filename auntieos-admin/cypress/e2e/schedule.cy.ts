/**
 * The admin Schedule (`/schedule`): the Today agenda panel moved above the
 * calendar grid and the Busy blocks stat card wired to a click (#695, #697,
 * PR #724), then the month view rebuilt as a real calendar (#696, PR #744).
 *
 * A BUSY BLOCK IS SEEDED THROUGH A DIRECT FIRESTORE WRITE, not through the
 * app. `booking_time_slots` has no create/edit surface a client can drive:
 * `firestore.rules` denies every client write to it (`allow write: if
 * false`), Google Calendar sync and `createBlockedTimeSlot` are the only two
 * writers, and neither runs here (no Functions emulator, no real calendar).
 * So this uses the one Firestore path this repo's own e2e harness already
 * relies on for exactly this reason: `e2e/seed.ts`'s owner-bearer REST
 * bypass, the same emulator superpower that lets it wipe and reseed the whole
 * database. The visit this spec reads for #696, by contrast, is already in
 * the fixture (`SEEDED_BOOKINGS.today`, `e2e/fixtures/accounts.ts`): Schedule
 * shares `kin_care_sessions` with Sessions.tsx and the bookings spec, and that
 * row exists precisely so a day with something on it is never three days out
 * of view.
 */

// A module, not a global script: this file's top-level constants must not
// collide with the same-named ones `gallery.cy.ts` and `packages.cy.ts`
// declare for their own Firestore REST setup.
export {};

const FIRESTORE = 'http://127.0.0.1:8385';
const PROJECT = 'auntieos-ttpc';
const OWNER = { Authorization: 'Bearer owner' };

/** Local `YYYY-MM-DD`, the same construction `lib/scheduleFormat.ts#localDateIso` and `lib/coveragePackage.ts#todayIso` use. */
function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TODAY_ISO = localIso(new Date());
/**
 * A day in the CURRENT local month that is not today, so a click that
 * selects it is provably a move rather than a no-op. The 5th and 6th always
 * exist and always fall inside the anchor month `MonthGrid` renders,
 * regardless of which day of the month "today" happens to be.
 */
const busyDayNum = new Date().getDate() === 5 ? 6 : 5;
const BUSY_DAY_ISO = localIso(new Date(new Date().getFullYear(), new Date().getMonth(), busyDayNum));

const STAMP = Date.now().toString(36);
const BUSY_ID = `e2e-busy-${STAMP}`;

/** Writes one `booking_time_slots` doc straight past `firestore.rules` with the emulator's owner bearer, mirroring `e2e/seed.ts#put`. */
function seedBusySlot(): void {
  const fields = {
    date: BUSY_DAY_ISO,
    startTime: '10:00',
    endTime: '11:00',
    slotType: 'BLOCKED',
    source: 'INTERNAL_MANUAL',
  };
  const encoded = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }]));
  cy.request({
    method: 'POST',
    url: `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/booking_time_slots?documentId=${BUSY_ID}`,
    headers: { ...OWNER, 'Content-Type': 'application/json' },
    body: { fields: encoded },
  });
}

function cleanupBusySlot(): void {
  cy.request({
    method: 'DELETE',
    url: `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/booking_time_slots/${BUSY_ID}`,
    headers: OWNER,
    failOnStatusCode: false,
  });
}

describe('schedule', () => {
  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here.

  before(() => seedBusySlot());
  after(() => cleanupBusySlot());

  it('#695 the Today agenda panel renders above the calendar grid, in week view and in month view', () => {
    cy.signIn();
    cy.visit('/schedule');

    // Week is the view Schedule opens on.
    cy.get('.schedule-grid[role="group"]').should('exist');
    cy.contains('.schedule__agenda-panel .den-panel-title', 'Today').should('exist');
    cy.get('.schedule__agenda-panel, .schedule-grid').first().should('have.class', 'schedule__agenda-panel');

    cy.contains('[role="tab"]', 'Month').click();
    cy.get('.schedule__month[role="group"]').should('exist');
    cy.get('.schedule__agenda-panel, .schedule__month').first().should('have.class', 'schedule__agenda-panel');
  });

  it('#697 the Busy blocks stat card is a button, and clicking it highlights a busy day', () => {
    cy.signIn();
    cy.visit('/schedule');
    cy.contains('[role="tab"]', 'Month').click();
    cy.get('.schedule__month[role="group"]').should('exist');

    // Today is selected by default, and it is not the seeded busy day.
    cy.get(`.schedule__day-cell[data-day="${TODAY_ISO}"]`).should('have.class', 'schedule__day-cell--selected');

    cy.contains('.den-stat', 'Busy blocks').as('busyCard');
    cy.get('@busyCard').invoke('prop', 'tagName').should('eq', 'BUTTON');
    cy.get('@busyCard').click();

    cy.get(`.schedule__day-cell[data-day="${BUSY_DAY_ISO}"]`).should('have.class', 'schedule__day-cell--selected');
    cy.get(`.schedule__day-cell[data-day="${TODAY_ISO}"]`).should('not.have.class', 'schedule__day-cell--selected');
  });

  it('#696 in month view a seeded visit renders as a block inside its day cell, and the legend is present', () => {
    cy.signIn();
    cy.visit('/schedule');
    cy.contains('[role="tab"]', 'Month').click();
    cy.get('.schedule__month[role="group"]').should('exist');

    // The fixture's `today` session (kin_care_sessions/e2e-sess-today),
    // scoped by household name rather than by date: its `startTime` is a UTC
    // instant and the cell it lands in is keyed by the LOCAL day, which can
    // diverge from a naive UTC date string on a run near midnight.
    cy.contains('.schedule__month-block--visit', 'Constance Fairweather-Okonkwo')
      .should('have.attr', 'data-tone', 'purple')
      .closest('.schedule__day-cell')
      .invoke('attr', 'data-day')
      .should('have.length.greaterThan', 0);

    cy.get('.schedule__legend[aria-label="Service type legend"]').should('exist');
    cy.get('.schedule__legend').contains('.schedule__legend-item', 'Busy').should('exist');
  });
});
