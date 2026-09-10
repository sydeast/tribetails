/**
 * Coverage Package Builder (`/packages`): the Start date opens on today and
 * the second "Visit menu" rate card is gone (#693, PR #728), and a fresh
 * quote auto-builds the Lean, Balance and Premium tiers again beside a
 * hand-built package (#694, PR #733).
 *
 * A SERVICE RATE IS SEEDED THROUGH SETTINGS, not written straight to
 * Firestore. `e2e/seed.ts` carries no `business_settings` doc at all
 * (`getBusinessSettings` defaults `serviceRates` to `{}`), and the three
 * tiers only build when there is at least one priced visit-kind KinCare type
 * to sell (`buildDayPatterns`'s one precondition). Settings > KinCare types
 * (`KinCareRatesEditor`) is the screen's own path for adding one, so setup
 * drives that real form once for the whole file rather than writing the
 * document directly, and an `after` hook removes exactly the row it added.
 *
 * THE QUOTE ITSELF NEEDS NO CLEANUP. It lives in `localStorage`
 * (`tt-coverage-quote-v1`), which Cypress's default test isolation clears
 * before every test in this file, so each test opens on a genuinely fresh
 * quote without this spec touching storage itself.
 */

// A module, not a global script: this file's top-level constants must not
// collide with the same-named ones `gallery.cy.ts` and `schedule.cy.ts`
// declare for their own Firestore REST setup.
export {};

const STAMP = Date.now().toString(36);
const RATE_NAME = `E2E Dog Walk ${STAMP}`;
const RATE_DURATION_MIN = '30';
const RATE_PRICE = '25';

function goToKinCareSettings(): void {
  cy.signIn();
  cy.visit('/settings?section=kinCare');
  cy.contains('.den-panel-title', 'KinCare types', { timeout: 10_000 }).should('exist');
}

describe('packages', () => {
  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here.

  before(() => {
    goToKinCareSettings();
    cy.get('.kinCareRates__addRow').within(() => {
      cy.get('input[placeholder="e.g. Drop-in visit"]').type(RATE_NAME);
      cy.get('input[placeholder="e.g. 30"]').type(RATE_DURATION_MIN);
      cy.get('input[placeholder="0.00"]').type(RATE_PRICE);
      cy.contains('button', 'Add').click();
    });
    cy.contains('.settingsEdit__saveRow button', 'Save').click();
    cy.get('.settingsEdit__savedNote').should('have.text', 'Saved');
  });

  after(() => {
    goToKinCareSettings();
    // Found by its VALUE, not a `[value=...]` attribute selector: a React
    // controlled input does not reliably mirror its current value onto the
    // DOM attribute, only onto the live DOM property.
    cy.get('.kinCareRates__row input')
      .filter((_, el) => (el as HTMLInputElement).value === RATE_NAME)
      .closest('.kinCareRates__row')
      .within(() => cy.contains('button', 'Remove').click());
    cy.contains('.settingsEdit__saveRow button', 'Save').click();
  });

  it('#693 opens the Start date on today’s date', () => {
    cy.signIn();
    cy.visit('/packages');

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const expected = `${y}-${m}-${d}`;

    cy.contains('.den-panel', 'Coverage window').within(() => {
      cy.contains('.cpb__field', 'Start').find('input[type="date"]').should('have.value', expected);
    });
  });

  it('#693 has no Visit menu panel', () => {
    cy.signIn();
    cy.visit('/packages');

    cy.contains('Visit menu').should('not.exist');
    cy.contains('Restore defaults').should('not.exist');
  });

  it('#694 a fresh quote shows Lean, Balance and Premium package cards beside New package', () => {
    cy.signIn();
    cy.visit('/packages');

    cy.contains('.den-panel', 'Packages').within(() => {
      cy.contains('button', 'New package').should('exist');
    });

    cy.get('input[aria-label="Package name"]').should('have.length.at.least', 3);
    cy.get('input[aria-label="Package name"]').then(($inputs) => {
      const names = [...$inputs].map((el) => (el as HTMLInputElement).value);
      expect(names, 'seeded tier names').to.include.members(['Lean', 'Balance', 'Premium']);
    });
  });
});
