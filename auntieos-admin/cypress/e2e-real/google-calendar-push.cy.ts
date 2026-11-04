import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';
import { vendorConfigured } from '../support/e2e-real';

/**
 * Pushing the next 30 days of visits to the REAL "AuntieOS test" Google
 * calendar through `pushVisitsToGoogleCalendar` (#1517, the calendar half of
 * #1089's D3).
 *
 * THE CONNECTION IS SEEDED, NOT CONSENTED. Production connects through an
 * OAuth window this run cannot drive, so `before` writes
 * `integrations_config/googleCalendar` straight into the emulator from
 * `E2E_GOOGLE_CALENDAR_REFRESH_TOKEN` and `E2E_GOOGLE_CALENDAR_ID`
 * (`seedGoogleCalendarConnection` in `cypress.real.config.ts`). The OAuth
 * client id and secret already reach the emulator through the Secret Manager
 * allowlist, so the real callable builds a real client from that document and
 * really writes to Google. `after` removes the document again:
 * `settings-integrations.cy.ts` asserts the not-connected state and runs after
 * this file, so it only passes because the document is gone by then.
 *
 * WHAT IS PROVED, FROM THE UI ONLY (2026-09-01 ruling): the panel reads the
 * seeded connection as connected with nothing pushed yet; pressing Push gets
 * the server's own count back on screen; and after a reload the stamped
 * receipt the callable wrote to the connection document reads ok with that
 * count. The count is 1, and that is exact, not a lower bound: the run-wide
 * seed's two upcoming visits (`e2e-sess-today`, `e2e-sess-scheduled`) carry no
 * end time and no duration, so the push skips them by design and reports the
 * skip in its note; `bookings.cy.ts` runs before this file alphabetically and
 * its `after` removes the visit it booked. The one visit with a usable end in
 * the window is the one seeded here.
 *
 * THE EVENT STAYS ON GOOGLE UNTIL THE RUN ENDS. Removing the connection first
 * in `after` means deleting the visit row fires the sync trigger against no
 * connection, so nothing here calls Google on the way out.
 * `scripts/e2e-real/google-calendar-cleanup.mjs` deletes the event afterwards
 * by the private marker the push writes on it.
 *
 * NOTHING ON THE PANEL IS PRESSED BUT PUSH. The test calendar shares its
 * account and OAuth client with production (D3-d), so the control that
 * revokes the grant is never touched and never named here.
 *
 * SKIPS, NAMING THE VARIABLES, when the run has no calendar credentials.
 */

const STAMP = Date.now().toString(36);
const SESSION_ID = `e2e-real-gcal-visit-${STAMP}`;
const DAY_MS = 86_400_000;

/**
 * RENDER covers a cold `getGoogleCalendarConnection`. PUSH covers the cold
 * start of the push callable, Google's token refresh and one event write, plus
 * the functions emulator's own trigger queue ahead of it.
 */
const BUDGET_MS = { RENDER: 20_000, PUSH: 45_000 } as const;

/** One scheduled visit two days out with a real end, the shape `approveBookingSeriesCore` writes. */
function seedVisit() {
  const start = new Date(Date.now() + 2 * DAY_MS);
  start.setUTCHours(17, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  cy.task('upsertDoc', {
    collection: 'kin_care_sessions',
    id: SESSION_ID,
    doc: {
      kinfolkId: 'e2e-kf-1',
      kinfolkName: 'Wanda Thorne',
      serviceType: 'Drop-in visit',
      status: 'SCHEDULED',
      // ISO strings, as the collection stores them; see the seed's note on the
      // lexical window the push queries.
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      notes: `e2e-real calendar push ${STAMP}`,
      createdAt: new Date().toISOString(),
    },
    timestampFields: ['createdAt'],
  });
}

/** Settings, Integrations, the Calendar panels, then the editable-calendars panel once its read has settled. */
function openEditableCalendars() {
  cy.visit('/settings');
  cy.contains('[role="tab"]', 'Integrations', { timeout: BUDGET_MS.RENDER }).click();
  cy.get('.integrations__grid', { timeout: BUDGET_MS.RENDER }).should('exist');
  cy.contains('button', 'Open Google Calendar settings').click();
  cy.contains('.den-panel-title', 'Editable calendars', { timeout: BUDGET_MS.RENDER }).should('exist');
  cy.get('[role="img"][aria-label="Reading the connection…"]', { timeout: BUDGET_MS.RENDER }).should('not.exist');
  return cy.contains('.den-panel', 'Editable calendars');
}

describe('google calendar push (real callable, test calendar)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    if (!vendorConfigured('googleCalendar')) {
      cy.log(
        'SKIPPED: no Google Calendar credentials in this run (E2E_GOOGLE_OAUTH_CLIENT_ID, E2E_GOOGLE_OAUTH_CLIENT_SECRET, E2E_GOOGLE_CALENDAR_REFRESH_TOKEN, E2E_GOOGLE_CALENDAR_ID)',
      );
      this.skip();
    }
    // The visit first, then the connection. The visit's write fires the sync
    // trigger; whether that invocation finds the connection or not, the push
    // below counts the visit once (created, or updated in place).
    seedVisit();
    cy.task<string>('authUid', { email: ADMIN.email }).then((uid) => {
      cy.task('seedGoogleCalendarConnection', { connectedByUid: uid, googleAccountEmail: ADMIN.email });
    });
  });

  after(() => {
    // Connection first: the visit's delete then fires the sync trigger
    // against no connection and makes no Google call. Both are safe when the
    // `before` above skipped and neither document exists.
    cy.task('removeGoogleCalendarConnection');
    cy.task('deleteDoc', { collection: 'kin_care_sessions', id: SESSION_ID });
  });

  it('#1517 pushes the next 30 days to the test calendar, and after a reload the stamped receipt reads ok with 1 visit', () => {
    cy.signIn();
    openEditableCalendars().within(() => {
      cy.contains('Connected as', { timeout: BUDGET_MS.RENDER }).should('exist');
      cy.contains('No visits have been sent to this calendar yet.').should('exist');
      cy.contains('button', 'Push next 30 days').should('not.be.disabled');
    });

    let t0 = 0;
    cy.contains('.den-panel', 'Editable calendars')
      .contains('button', 'Push next 30 days')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    // The server's note. The skipped seed visits follow it on the same line,
    // which is why this is a substring and not the whole text.
    cy.contains('[role="status"]', 'Sent 1 visit, removed 0 cancelled visits.', { timeout: BUDGET_MS.PUSH }).should(
      'exist',
    );
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Push to the server count on screen').to.be.lessThan(BUDGET_MS.PUSH);
    });
    cy.contains('The last push failed').should('not.exist');
    cy.contains('That did not work').should('not.exist');

    // Persistence, through a reload: the receipt is the connection document's
    // own stamp, read back by getGoogleCalendarConnection, not panel state.
    cy.reload();
    openEditableCalendars().within(() => {
      cy.contains('[role="status"]', /^Last push .+\. Sent 1 visit\.$/, { timeout: BUDGET_MS.RENDER }).should('exist');
      cy.contains('No visits have been sent to this calendar yet.').should('not.exist');
      cy.contains('The last push failed').should('not.exist');
    });
  });
});
