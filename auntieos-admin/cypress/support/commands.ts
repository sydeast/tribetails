import { ADMIN } from '../../e2e/fixtures/accounts';

/**
 * The admin this suite signs in as.
 *
 * Defaults to the EMULATOR FIXTURE, which is the account `e2e/seed.ts` creates
 * and the only one `npm run e2e:cy` can authenticate. A run pointed at a
 * deployed host (`CYPRESS_baseUrl=https://auntie.tribetails.com`) overrides both
 * halves from the environment, because that fixture exists nowhere but the auth
 * emulator and a real password must never be checked in. See
 * docs/runbooks/e2e.md for where the deployed one is kept.
 *
 * HALF-SET IS AN ERROR, NOT A FALLBACK. Silently dropping back to the fixture
 * when only one variable is exported would authenticate a prod run with an
 * account prod has never heard of, and the run would fail at the form with a
 * bad-credentials banner, which reads as an app defect rather than as the
 * export the operator forgot.
 *
 * `Cypress.expose`, NOT the `Cypress.env` this read until Cypress 16 removed
 * that method. Nothing changes for whoever runs this: the same two
 * `CYPRESS_`-prefixed variables are still what the runbook says to export, and
 * they still spell the same names here. What changed is that a prefixed
 * variable now lands in Cypress's Node-side `env` rather than anywhere the
 * browser can see, so `cypress.config.ts` carries the pair across into
 * `expose`. Its comment holds the argument for why they go there rather than
 * through an asynchronous `cy.env()` read - in short, because
 * `usingFixtureAdmin()` below is read where no command chain exists yet.
 */
function adminCredentials(): { email: string; password: string } {
  const email = Cypress.expose('E2E_ADMIN_EMAIL') as string | undefined;
  const password = Cypress.expose('E2E_ADMIN_PW') as string | undefined;
  if (email && password) return { email, password };
  if (email || password) {
    throw new Error(
      'Set both CYPRESS_E2E_ADMIN_EMAIL and CYPRESS_E2E_ADMIN_PW, or neither (emulator fixture).',
    );
  }
  return { email: ADMIN.email, password: ADMIN.password };
}

/**
 * True when the run is authenticating as the seeded emulator account rather than
 * as a deployed one. A spec that MUTATES the account it signs in with (the
 * password change in `account.cy.ts`) must only ever do that to the fixture:
 * the emulator is wiped on the next seed and `resetAdminPassword` can put the
 * password back over REST, neither of which is true of a deployed admin.
 */
export function usingFixtureAdmin(): boolean {
  return adminCredentials().email === ADMIN.email;
}

/**
 * The commands the specs in this suite are written on top of.
 *
 * Every one of them is an assertion helper rather than a convenience wrapper.
 * The suite exists because screens were reported healthy when they were not, so
 * a helper here that only navigates and returns is a helper that reintroduces
 * the problem.
 */

/**
 * Signs in THROUGH THE REAL FORM as the given account, and only if a session
 * is not already live.
 *
 * NOT `cy.session()`, and the reason is specific rather than stylistic: the
 * Firebase Auth web SDK persists its session to IndexedDB
 * (`firebaseLocalStorageDb`), and `cy.session()` caches cookies, localStorage
 * and sessionStorage only. A session cached that way restores nothing, every
 * dependent spec lands back on the sign-in form, and the failure reads as an
 * app defect. `e2e/auth.setup.ts` records Playwright hitting the same wall from
 * the other side: it has to ask for `indexedDB: true` explicitly.
 *
 * What makes the plain form affordable is that Cypress does NOT clear IndexedDB
 * between tests, so one sign-in survives the whole spec file and the probe below
 * short-circuits on every call after the first.
 *
 * Driving the form is also the only way the thing most likely to break gets
 * exercised: `SignIn.doSignIn` calls `resolveAccess(user, true)`, which force-
 * refreshes the ID token and reads the custom claim. A fabricated session skips
 * claim propagation entirely, which is the portal's O-37 lesson.
 *
 * THE SHORT-CIRCUIT DOES NOT CHECK WHO IS SIGNED IN. A live session for any
 * account satisfies it. A spec that needs to prove a specific credential works
 * (a just-changed password) has to sign out first, or it proves nothing.
 */
Cypress.Commands.add('signInAs', (email: string, password: string) => {
  cy.visit('/home', { failOnStatusCode: true });

  // WAIT FOR A RENDERED SCREEN, NOT FOR A URL. The route guard is async (it
  // awaits `waitForAuthReady()` before it can redirect), so for the first
  // moments of the visit the URL still reads `/home` on a signed-OUT browser
  // and only becomes `/signin` once Firebase has restored (or failed to
  // restore) a session. An earlier version of this command read the pathname
  // straight after the visit, saw `/home`, concluded a session was live and
  // returned without signing in; every spec then ran against the sign-in form
  // and failed on a missing nav rail. Exactly one of these two elements can be
  // on the page, and neither is until the guard has decided, so waiting for
  // either is what makes the branch below deterministic.
  cy.get('.shell__rail, .signin__card', { timeout: 30_000 }).should('exist');
  cy.get('body').then(($body) => {
    if ($body.find('.shell__rail').length > 0) return; // already signed in
    cy.get('.signin__form input[type="email"]').type(email);
    cy.get('.signin__form input[type="password"]').type(password, { log: false });
    cy.contains('.signin__form button', 'Sign in').click();
    // The route change is the gate's verdict. Asserting on it, rather than on
    // "no error banner appeared", means a denial cannot pass as a pass.
    cy.location('pathname', { timeout: 30_000 }).should('eq', '/home');
    cy.get('.signin__card').should('not.exist');
  });
});

/** `signInAs` with the run's admin credentials (fixture, or the env override). */
Cypress.Commands.add('signIn', () => {
  const { email, password } = adminCredentials();
  cy.signInAs(email, password);
});

/**
 * Signs out through the topbar button and waits for the form to come back.
 *
 * `signOut` in `src/lib/auth.ts` reloads the page after clearing the session,
 * so the guard runs again and lands on `/signin`. Waiting for the card rather
 * than the URL for the same reason `signInAs` does: the URL is not settled
 * until the guard has decided.
 */
Cypress.Commands.add('signOut', () => {
  cy.contains('.shell__topbar button', 'Sign out').click();
  cy.get('.signin__card', { timeout: 30_000 }).should('exist');
  cy.get('.shell__rail').should('not.exist');
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      signIn(): Chainable<void>;
      signInAs(email: string, password: string): Chainable<void>;
      signOut(): Chainable<void>;
    }
  }
}

export {};
