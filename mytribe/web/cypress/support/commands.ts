import { ACCESS, HOME, SET_ACTIVE_TRIBE } from '../fixtures/access';
import { KINFOLK } from '../fixtures/accounts';
import { stubCallables } from './callables';

/**
 * The commands the portal specs are written on top of.
 *
 * Every one of them is an assertion helper rather than a convenience wrapper.
 * The suite exists because screens were reported healthy when they were not, so
 * a helper that only navigates and returns would reintroduce the problem.
 */

/**
 * Installs the access-chain stubs. Call before any `cy.visit`.
 *
 * `getMyHome` is in the set because the tribe picker and the home screen both
 * read it, and because `PortalNav` (the chrome the crawl walks) is rendered
 * from it. The other 55 call sites are deliberately left unstubbed; see
 * `callables.ts`.
 */
Cypress.Commands.add('stubAccess', () => {
  stubCallables({
    getMyAccess: ACCESS,
    getMyHome: HOME,
    setActiveTribe: SET_ACTIVE_TRIBE,
  });
});

/**
 * Signs the kinfolk in THROUGH THE REAL FORM, and only if a session is not
 * already live.
 *
 * NOT `cy.session()`, and the reason is specific rather than stylistic: the
 * Firebase Auth web SDK persists its session to IndexedDB
 * (`firebaseLocalStorageDb`), and `cy.session()` caches cookies, localStorage
 * and sessionStorage only. A session cached that way restores nothing and every
 * dependent spec lands back on the sign-in form, where the failure reads as an
 * app defect. What makes the plain form affordable is that Cypress does NOT
 * clear IndexedDB between tests, so one sign-in survives the whole spec file.
 *
 * WAIT FOR A RENDERED SCREEN, NOT FOR A URL. `waitForAuthReady()` is awaited
 * inside the route guard, so for the first moments of a visit the URL still
 * reads `/home` on a signed-OUT browser and only becomes `/signin` once
 * Firebase has decided. Reading the pathname straight after the visit sees
 * `/home`, concludes a session is live, and returns without signing in, which
 * is exactly the bug the admin harness shipped with for one afternoon.
 */
Cypress.Commands.add('signIn', () => {
  cy.stubAccess();
  cy.visit('/home');

  cy.get('.nav, .authcard, .errshell', { timeout: 30_000 }).should('exist');

  cy.get('body').then(($body) => {
    if ($body.find('.nav').length > 0) return; // already signed in
    // `.errshell` here means the guard resolved to LaunchError, which with the
    // access chain stubbed can only be a real failure. Fail on it rather than
    // typing into a form that is not on the page.
    expect($body.find('.errshell').length, 'portal rendered LaunchError before sign-in').to.equal(0);

    cy.get('#email').type(KINFOLK.email);
    cy.get('#password').type(KINFOLK.password, { log: false });
    cy.get('.authcard button[type="submit"]').click();

    // The route change is the gate's verdict. Asserting on it, rather than on
    // "no error banner appeared", means a denial cannot pass as a pass.
    cy.location('pathname', { timeout: 30_000 }).should('eq', '/home');
    cy.get('.nav').should('exist');
  });
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      stubAccess(): Chainable<void>;
      signIn(): Chainable<void>;
    }
  }
}

export {};
