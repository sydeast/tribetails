import type { GetBookingPolicyResult, GetServiceCatalogResult } from '../../src/api/bookingApi';
import type { GetMyKinResult, KinDto } from '../../src/api/types';
import { ACCESS, HOME, SET_ACTIVE_TRIBE } from '../fixtures/access';
import { stubCallables } from '../support/callables';

/**
 * The booking wizard's step row (#1918, #1933).
 *
 * WHY A BROWSER SPEC. jsdom has no layout. Whether the step row sits behind the
 * sticky top bar after a step change, and whether five steps fit a phone, can
 * only be known by measuring the real page. The callables are stubbed
 * (`support/callables.ts`), typed against the app's own interfaces.
 *
 * The lists are long on purpose (eight Kin, nine KinCares) so the page really
 * scrolls: on a short step the old bug is invisible.
 */

function kin(i: number): KinDto {
  return {
    id: `k${i}`,
    name: `Buddy ${i}`,
    species: 'dog',
    breed: 'Mixed',
    ageYears: 3,
    photoUrl: null,
    status: 'active',
    feedingInstructions: null,
    walkingInstructions: null,
    medications: null,
    allergies: null,
    emergencyNotes: null,
    sitterNotes: null,
    sex: null,
    weight: null,
    colorMarkings: null,
    spayedNeutered: false,
    vetInfo: null,
  };
}

const KIN: GetMyKinResult = { kin: [1, 2, 3, 4, 5, 6, 7, 8].map(kin) };

const CATALOG: GetServiceCatalogResult = {
  pricesVisible: true,
  services: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
    id: `s${i}`,
    name: `Daily Visit ${i}`,
    category: 'Held Down at Home',
    description: 'A full daily routine at home with all the trimmings.',
    priceCents: 4200,
    priceMinCents: null,
    priceMaxCents: null,
    durationMinutes: null,
    isOvernight: false,
    iconKey: 'sun',
  })),
};

const POLICY: GetBookingPolicyResult = {
  allowTimeBlockBooking: false,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  timeBlocks: [],
};

function openWizard() {
  cy.signIn();
  stubCallables({
    getMyAccess: ACCESS,
    getMyHome: HOME,
    setActiveTribe: SET_ACTIVE_TRIBE,
    getMyKin: KIN,
    getServiceCatalog: CATALOG,
    getBookingPolicy: POLICY,
    getBusinessClosures: { closures: [] },
    getMyBookings: { liveVisit: null, upcoming: [], recent: [], envelopes: [] },
  });
  cy.visit('/schedule/book');
  cy.contains('h3.title', 'Select Kin', { timeout: 30_000 }).should('be.visible');
}

/**
 * The step row is fully readable: not under the sticky bar, all five steps on
 * screen, and the page does not scroll sideways. Retried by Cypress, because the
 * scroll to the row is smooth and takes a moment to land.
 */
function assertStepperClear(width: number, step: number) {
  cy.get('.stepper').should(($stepper) => {
    const nav = document.querySelector('.nav')!.getBoundingClientRect();
    const row = $stepper[0]!.getBoundingClientRect();
    expect(row.top, `step ${step}: stepper top vs nav bottom`).to.be.at.least(nav.bottom - 0.5);
  });
  cy.get('.stepper .step').should('have.length', 5).each(($step) => {
    const r = $step[0]!.getBoundingClientRect();
    expect(r.left, 'step left edge').to.be.at.least(0);
    expect(r.right, 'step right edge').to.be.at.most(width + 0.5);
  });
  cy.document().then((doc) => {
    expect(doc.documentElement.scrollWidth, 'page scrollWidth').to.be.at.most(width);
  });
  cy.get('.stepper').then(($s) => {
    expect($s[0]!.scrollWidth, 'stepper has no sideways scroll').to.be.at.most($s[0]!.clientWidth);
  });
}

function next() {
  cy.contains('button', 'Next').scrollIntoView().click();
}

for (const [label, width, height] of [
  ['phone', 390, 844],
  ['desktop', 1280, 800],
] as const) {
  describe(`Booking wizard step row at ${label} width (${width}px)`, () => {
    beforeEach(() => {
      cy.viewport(width, height);
    });

    it('stays clear of the top bar and inside the screen on every step', () => {
      openWizard();
      assertStepperClear(width, 1);

      next();
      cy.contains('h3.title', 'Choose KinCare Duration').should('be.visible');
      assertStepperClear(width, 2);

      cy.contains('.svc', 'Daily Visit 1').click();
      next();
      cy.contains('h3.title', 'Schedule Dates').should('be.visible');
      assertStepperClear(width, 3);

      cy.get('button[aria-label="Next month"]').click();
      cy.get('button.mp-day:not([disabled])').first().click();
      next();
      assertStepperClear(width, 4);

      next();
      assertStepperClear(width, 5);
    });
  });
}
