import { usingFixtureAdmin } from '../support/commands';

/**
 * Settings > Integrations against the REAL `getIntegrationsHealth` and
 * `getGoogleCalendarConnection` (#1195, the real-services counterpart of the
 * Integrations and loading tests in `cypress/e2e/settings.cy.ts`; its Tags
 * test has `settings-tags.cy.ts`).
 *
 * The PR-time spec hands the section a one-row health result and a canned
 * "not connected" answer, and holds that answer open to see the spinner. Here
 * both are the functions' own reads, so:
 *
 *   - the cards are the server's integration list, and a secret the run's
 *     secrets file sets reads as set on its card (the server checked it);
 *   - #715: the Calendar panels open in place from inside Integrations;
 *   - #714, resolved half: once the real connection read answers, the spinner
 *     is gone and the not-connected state offers Connect. Nothing is pressed:
 *     the connection controls reach Google, and the "AuntieOS test" calendar
 *     shares its account with production (D3-d).
 *
 * #714's in-flight half (the spinner held while the read is pending) needs a
 * read that can be told to wait, so it stays in the PR-time spec only.
 *
 * NO VENDOR CALL. `getIntegrationsHealth` makes no network call (its probes
 * sign locally or read Firestore), and `getGoogleCalendarConnection` reads the
 * stored connection, which this database has none of. So this file runs
 * whether or not the run has Calendar credentials.
 */

/** RENDER includes the cold start of `getIntegrationsHealth`, which declares every integration secret. */
const BUDGET_MS = { RENDER: 20_000 } as const;

function openIntegrations() {
  cy.signIn();
  cy.visit('/settings');
  cy.contains('[role="tab"]', 'Integrations', { timeout: BUDGET_MS.RENDER }).click();
  cy.get('.integrations__grid', { timeout: BUDGET_MS.RENDER }).should('exist');
}

describe('settings integrations (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  it('lists the server integrations, and a secret this run set reads as set on its card', () => {
    openIntegrations();
    cy.get('.integrations__card .integrations__name').then(($names) => {
      const names = [...$names].map((el) => el.textContent ?? '');
      expect(names, 'integration cards').to.include.members(['Stripe', 'Cloudinary']);
    });
    cy.contains('.integrations__card', 'Cloudinary')
      .contains('.integrations__secret', 'CLOUDINARY_API_SECRET')
      .find('.integrations__secretState')
      .should('have.attr', 'data-set', 'yes');
  });

  it('#715 #714 opens the Calendar panels in place, and the real connection read settles on Connect', () => {
    openIntegrations();
    cy.get('[role="tab"]').should('not.contain.text', 'Calendar');
    cy.contains('.den-panel-title', 'Free/busy import').should('not.exist');

    cy.contains('button', 'Open Google Calendar settings').click();
    cy.contains('.den-panel-title', 'Free/busy import', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.contains('.den-panel-title', 'Editable calendars').should('exist');

    cy.contains('button', 'Connect Google Calendar', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('[role="img"][aria-label="Reading the connection…"]').should('not.exist');
  });
});
