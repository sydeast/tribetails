import { usingFixtureAdmin } from '../support/commands';

/**
 * Bookings (`/bookings`), the visit-requests block, against the REAL
 * `listPendingBookingRequests`, `listRescheduleRequests`, `listCancelRequests`
 * and `manageBookingSeries` (#1195, the real-services counterpart of
 * `cypress/e2e/bookings.cy.ts`).
 *
 * The PR-time spec answers the three reads with a hand-written request and the
 * decision with a hand-written verdict, so it proves the dialog (#700: an empty
 * reason is allowed) and the payload. Here the request is a real booking
 * envelope with a requested visit under it, the shape the portal writes, so the
 * envelope triggers run when it is seeded, the queue is the server's scan of
 * `kinCares` and the decision really rules on the envelope:
 *
 *   - #700: Decline with an empty reason goes through; the server's verdict is
 *     on screen, and after a reload the request is no longer in the queue;
 *   - Accept books the request: after a reload it has left the queue and the
 *     Scheduled section counts one more visit, which is the session
 *     `manageBookingSeries` created;
 *   - #698, resolved half: with every request answered, the block settles on
 *     its plain empty line from the real reads.
 *
 * #698's in-flight half (the loading shape held on screen for a second) needs a
 * read that can be told to wait, so it stays in the PR-time spec only.
 *
 * The household gate (`householdNotificationsLive`) is off in this database, so
 * the verdict may say the household was not told. Both wordings start with the
 * same clause, and that clause is what is asserted.
 */

const STAMP = Date.now().toString(36);
const DAY_MS = 86_400_000;

/** RENDER covers the cold start of the three list callables. DECIDE is one `manageBookingSeries`. */
const BUDGET_MS = { RENDER: 15_000, DECIDE: 15_000 } as const;

interface SeededRequest {
  batchId: string;
  visitId: string;
  serviceType: string;
}

const DECLINE: SeededRequest = {
  batchId: `e2e-real-decline-${STAMP}`,
  visitId: `e2e-real-decline-visit-${STAMP}`,
  serviceType: `Drop-in visit ${STAMP} decline`,
};
const ACCEPT: SeededRequest = {
  batchId: `e2e-real-accept-${STAMP}`,
  visitId: `e2e-real-accept-visit-${STAMP}`,
  serviceType: `Drop-in visit ${STAMP} accept`,
};

const ENVELOPES = 'families/e2e-kf-1/bookings';
const visitsPath = (r: SeededRequest) => `families/e2e-kf-1/bookings/${r.batchId}/kinCares`;

/** One requested envelope with one visit [daysOut] days from now, as the portal's booking wizard writes it. */
function seedRequest(r: SeededRequest, daysOut: number) {
  const start = new Date(Date.now() + daysOut * DAY_MS);
  start.setUTCHours(17, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  cy.task('upsertDoc', {
    collection: ENVELOPES,
    id: r.batchId,
    doc: {
      kinfolkId: 'e2e-kf-1',
      envelopeStatus: 'requested',
      serviceName: r.serviceType,
      kinNames: ['Biscuit'],
      notes: null,
      visitCount: 1,
      createdAt: new Date().toISOString(),
    },
    timestampFields: ['createdAt'],
  });
  cy.task('upsertDoc', {
    collection: visitsPath(r),
    id: r.visitId,
    doc: {
      kinfolkId: 'e2e-kf-1',
      batchId: r.batchId,
      status: 'requested',
      serviceType: r.serviceType,
      kinNames: ['Biscuit'],
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
    timestampFields: ['startTime', 'endTime'],
  });
}

function removeRequest(r: SeededRequest) {
  cy.task('deleteDoc', { collection: visitsPath(r), id: r.visitId });
  cy.task('deleteDoc', { collection: ENVELOPES, id: r.batchId });
  cy.task('deleteDoc', { collection: 'kin_care_sessions', id: `vis_${r.visitId}` });
}

/** The visit-requests block once its three real reads have answered. */
function openBookings() {
  cy.signIn();
  cy.visit('/bookings');
  cy.get('[role="group"][aria-label="Bookings list"]', { timeout: BUDGET_MS.RENDER }).should('be.visible');
  cy.contains('.visit-requests__skeleton-label', 'Checking for requests…', { timeout: BUDGET_MS.RENDER }).should(
    'not.exist',
  );
}

/** Opens the queue (it starts folded behind "Review N") and yields the row for [r]. */
function requestRow(r: SeededRequest) {
  cy.contains('button', /^Review \d+$/, { timeout: BUDGET_MS.RENDER }).click();
  return cy.contains('.visit-requests__row', r.serviceType, { timeout: BUDGET_MS.RENDER });
}

function scheduledCount() {
  return cy
    .get('#bookings-section-scheduled .bookings__section-count', { timeout: BUDGET_MS.RENDER })
    .invoke('text')
    .then((text) => Number(text));
}

describe('bookings visit requests (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  after(() => {
    removeRequest(DECLINE);
    removeRequest(ACCEPT);
  });

  it('#700 declines a real request with an empty reason, and the request is gone from the queue after a reload', () => {
    seedRequest(DECLINE, 4);
    openBookings();

    requestRow(DECLINE).within(() => {
      cy.contains('button', 'Decline').click();
    });
    cy.get('[role="dialog"]').should('contain.text', 'Turn down this request');
    cy.get('#visit-request-note').should('have.value', '');

    let t0 = 0;
    cy.contains('[role="dialog"] button', 'Send the decline')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    cy.get('[role="dialog"]', { timeout: BUDGET_MS.DECIDE }).should('not.exist');
    cy.contains('Declined. Nothing was booked', { timeout: BUDGET_MS.DECIDE }).should('exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Send the decline to the server verdict on screen').to.be.lessThan(
        BUDGET_MS.DECIDE,
      );
    });

    // The server's queue, not the block's local state.
    cy.reload();
    cy.contains('.visit-requests__skeleton-label', 'Checking for requests…', { timeout: BUDGET_MS.RENDER }).should(
      'not.exist',
    );
    cy.contains('.visit-requests__row', DECLINE.serviceType).should('not.exist');
  });

  it('books a real request: it leaves the queue and the Scheduled section counts one more visit', () => {
    seedRequest(ACCEPT, 5);
    openBookings();

    scheduledCount().then((before) => {
      requestRow(ACCEPT).within(() => {
        cy.contains('button', 'Accept').click();
      });
      cy.get('[role="dialog"]').should('contain.text', 'Book this request');
      cy.contains('[role="dialog"] button', 'Book it').click();
      cy.get('[role="dialog"]', { timeout: BUDGET_MS.DECIDE }).should('not.exist');
      cy.contains('Approved. The visit is on the schedule', { timeout: BUDGET_MS.DECIDE }).should('exist');

      cy.reload();
      cy.contains('.visit-requests__skeleton-label', 'Checking for requests…', { timeout: BUDGET_MS.RENDER }).should(
        'not.exist',
      );
      cy.contains('.visit-requests__row', ACCEPT.serviceType).should('not.exist');
      // The Scheduled list streams `kin_care_sessions`, which only the server's
      // approval writes; the count is the proof the session exists.
      cy.get('#bookings-section-scheduled .bookings__section-count', { timeout: BUDGET_MS.RENDER }).should(
        'have.text',
        String(before + 1),
      );
    });
  });

  it('#698 settles on the plain empty line once the real reads answer with nothing waiting', () => {
    openBookings();
    cy.contains('.visit-requests__empty', 'No visit requests waiting.', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('.visit-requests__skeleton-label').should('not.exist');
  });
});
