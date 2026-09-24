import { RESET_KINFOLK, STAFF } from '../fixtures/accounts';
import { stubCallables } from '../support/callables';

/**
 * #892, end to end against the Auth emulator: a reset link opens the email
 * action page, the page sets the password, and the new password signs in.
 *
 * The links are the emulator's own. Each test asks the emulator to send a reset
 * (accounts:sendOobCode, the same call `sendPasswordResetEmail` makes), reads
 * the link back from `/emulator/v1/projects/<id>/oobCodes`, and opens its query
 * string on /account/secure-reset, which is where the project's callbackUri
 * points in production. Nothing is mocked except the confirmSecureReset
 * endpoint, which this harness does not serve.
 *
 * #905: every portal client now ASKS for a reset through the
 * `requestPasswordReset` callable, and the email goes out from our own
 * template. This harness serves no functions (see e2e.firebase.json), so the
 * "asking" tests at the bottom stub that callable with `cy.intercept` and
 * judge only what the page shows. The link tests above it still use the
 * emulator's own links, which have the same shape the callable's Admin SDK
 * link has.
 */

const AUTH = 'http://127.0.0.1:9499';
const PROJECT = 'auntieos-ttpc';

interface OobCode {
  email: string;
  oobCode: string;
  oobLink: string;
  requestType: string;
}

/** Sends a reset through the emulator and yields the query string of the link it produced. */
function requestResetLink(email: string, continueUrl?: string): Cypress.Chainable<string> {
  return cy
    .request('POST', `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=fake-api-key`, {
      requestType: 'PASSWORD_RESET',
      email,
      ...(continueUrl ? { continueUrl } : {}),
    })
    .then(() => cy.request(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`))
    .then((res) => {
      const codes = (res.body as { oobCodes: OobCode[] }).oobCodes.filter(
        (c) => c.email === email && c.requestType === 'PASSWORD_RESET',
      );
      expect(codes.length, `oob codes for ${email}`).to.be.greaterThan(0);
      const link = codes[codes.length - 1]!.oobLink;
      // Written out so a run leaves the exact links it opened on disk for review.
      return cy
        .writeFile('cypress/.artifacts/oob-links.txt', `${email} ${link}\n`, { flag: 'a+' })
        .then(() => new URL(link).search);
    });
}

/** Signs in over REST, which is all a staff account needs to prove its new password works. */
function restSignIn(email: string, password: string): Cypress.Chainable<Cypress.Response<unknown>> {
  return cy.request({
    method: 'POST',
    url: `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    body: { email, password, returnSecureToken: true },
    failOnStatusCode: false,
  });
}

function setNewPassword(password: string): void {
  cy.get('#newpw').type(password, { log: false });
  cy.get('#confpw').type(password, { log: false });
  cy.contains('button', 'Set new password').click();
  cy.contains('Your password is updated.', { timeout: 20_000 }).should('be.visible');
}

describe('password reset link (#892)', () => {
  it('kinfolk: the native Firebase link sets the password, files nothing, and the new password signs in', () => {
    const newPassword = 'e2e-reset-kinfolk-new-1';
    requestResetLink(RESET_KINFOLK.email).then((search) => {
      expect(search).to.contain('mode=resetPassword');
      expect(search, 'native links carry no email param').not.to.contain('email=');

      let securePosted = false;
      cy.intercept('POST', '**/confirmSecureReset', () => {
        securePosted = true;
      });

      cy.visit(`/account/secure-reset${search}`);
      cy.contains('This link is incomplete').should('not.exist');
      cy.get('.secaccount', { timeout: 20_000 }).should('have.text', RESET_KINFOLK.email);
      setNewPassword(newPassword);
      cy.then(() => expect(securePosted, 'a normal reset files no security incident').to.equal(false));

      restSignIn(RESET_KINFOLK.email, RESET_KINFOLK.password).its('status').should('eq', 400);

      // A bare native link cannot say whose account it is, so both sign-ins (#892 review).
      cy.contains('a', 'Staff sign-in').should('have.attr', 'href', 'https://auntie.tribetails.com/signin');
      cy.contains('a', 'Household sign-in').should('have.attr', 'href', '/signin').click();
      cy.stubAccess();
      cy.location('pathname').should('eq', '/signin');
      cy.get('#email').type(RESET_KINFOLK.email);
      cy.get('#password').type(newPassword, { log: false });
      cy.get('.authcard button[type="submit"]').click();
      cy.location('pathname', { timeout: 30_000 }).should('eq', '/home');
      cy.get('.nav').should('exist');
    });
  });

  it('kinfolk: the pre-#905 requestPasswordReset link shape still works, and a used link says so', () => {
    const newPassword = 'e2e-reset-kinfolk-new-2';
    const continueUrl = `https://kinfolk.tribetails.com/account/secure-reset?email=${encodeURIComponent(RESET_KINFOLK.email)}`;
    requestResetLink(RESET_KINFOLK.email, continueUrl).then((search) => {
      expect(search).to.contain('continueUrl=');

      cy.visit(`/account/secure-reset${search}`);
      cy.get('.secaccount', { timeout: 20_000 }).should('have.text', RESET_KINFOLK.email);
      setNewPassword(newPassword);
      cy.contains('a', 'Sign in with your new password').should(
        'have.attr',
        'href',
        'https://kinfolk.tribetails.com/signin',
      );
      restSignIn(RESET_KINFOLK.email, newPassword).its('status').should('eq', 200);

      // The same link again: the code is spent.
      cy.visit(`/account/secure-reset${search}`);
      cy.contains('This reset link has already been used or is not valid.', { timeout: 20_000 }).should('be.visible');
      cy.contains('button', 'Send a new link').should('be.visible');
    });
  });

  it('portal: the link requestPasswordReset sends a household lands on the portal sign-in (#905)', () => {
    // Since #905 the callable mints the link with the Admin SDK and
    // `continueUrl=https://kinfolk.tribetails.com/signin` for a household (the
    // admin sign-in for staff). This is that exact link shape, made by the
    // emulator, opened on the page #903 built.
    const newPassword = 'e2e-reset-kinfolk-new-911';
    requestResetLink(RESET_KINFOLK.email, 'https://kinfolk.tribetails.com/signin').then((search) => {
      expect(search).to.contain('continueUrl=');
      expect(search, 'no account travels in the link').not.to.contain('email=');

      let securePosted = false;
      cy.intercept('POST', '**/confirmSecureReset', () => {
        securePosted = true;
      });

      cy.visit(`/account/secure-reset${search}`);
      cy.get('.secaccount', { timeout: 20_000 }).should('have.text', RESET_KINFOLK.email);
      setNewPassword(newPassword);
      cy.then(() => expect(securePosted, 'a normal reset files no security incident').to.equal(false));

      cy.contains('a', 'Sign in with your new password').should(
        'have.attr',
        'href',
        'https://kinfolk.tribetails.com/signin',
      );
      restSignIn(RESET_KINFOLK.email, newPassword).its('status').should('eq', 200);
    });
  });

  it('staff: the admin link continues to the admin sign-in, with no household copy, and the new password signs in', () => {
    const newPassword = 'e2e-reset-staff-new-1';
    requestResetLink(STAFF.email, 'https://auntie.tribetails.com/signin').then((search) => {
      cy.visit(`/account/action${search}`);
      cy.get('.secaccount', { timeout: 20_000 }).should('have.text', STAFF.email);
      cy.get('main').invoke('text').should('not.match', /contact Tribe Tails/i);
      setNewPassword(newPassword);
      cy.get('main').invoke('text').should('not.match', /contact Tribe Tails/i);
      cy.contains('a', 'Sign in with your new password').should(
        'have.attr',
        'href',
        'https://auntie.tribetails.com/signin',
      );

      restSignIn(STAFF.email, STAFF.password).its('status').should('eq', 400);
      restSignIn(STAFF.email, newPassword).then((res) => {
        expect(res.status).to.eq(200);
        expect((res.body as { idToken?: string }).idToken, 'staff idToken').to.be.a('string');
      });
    });
  });

  it('"I did not ask for this reset" is an explicit choice that posts only the oobCode', () => {
    requestResetLink(STAFF.email).then((search) => {
      const oobCode = new URLSearchParams(search).get('oobCode');
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
      cy.intercept('OPTIONS', '**/confirmSecureReset', { statusCode: 204, headers: cors });
      cy.intercept('POST', '**/confirmSecureReset', {
        statusCode: 200,
        headers: cors,
        body: { ok: true, incidentId: 'e2e-incident-1' },
      }).as('secure');

      cy.visit(`/account/secure-reset${search}`);
      cy.get('.secaccount', { timeout: 20_000 }).should('have.text', STAFF.email);
      cy.contains('button', 'I did not ask for this reset').click();
      cy.contains('Secure your account').should('be.visible');
      cy.get('#newpw').type('e2e-secured-pw-1', { log: false });
      cy.get('#confpw').type('e2e-secured-pw-1', { log: false });
      cy.contains('button', 'Secure my account').click();

      cy.wait('@secure').then(({ request }) => {
        expect(Object.keys(request.body as object).sort()).to.deep.equal(['newPassword', 'oobCode', 'userAgent']);
        expect((request.body as { oobCode: string }).oobCode).to.equal(oobCode);
      });
      cy.contains('Your account is secured.').should('be.visible');
    });
  });

  it('fits a phone-width screen', () => {
    requestResetLink(RESET_KINFOLK.email).then((search) => {
      cy.viewport(375, 740);
      cy.visit(`/account/secure-reset${search}`);
      cy.get('.secaccount', { timeout: 20_000 }).should('be.visible');
      cy.document().then((doc) => {
        expect(doc.documentElement.scrollWidth, 'no sideways scroll at 375px').to.be.at.most(375);
      });
      cy.contains('button', 'Set new password').should('be.visible');
      cy.contains('button', 'I did not ask for this reset').should('be.visible');
    });
  });
});

/**
 * #905: asking for a reset from the portal's own screens. The callable is
 * stubbed; the assertions are on what the page says, plus the one request
 * body the stub received, since "only the address goes up" is the contract.
 */
const CALLABLE = '**/auntieos-ttpc/us-central1/requestPasswordReset';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-firebase-appcheck',
};

/** The callable's per-IP refusal, in the callable protocol's own error envelope. */
function refuseWithRateLimit(): void {
  cy.intercept('OPTIONS', CALLABLE, { statusCode: 204, headers: CORS });
  cy.intercept('POST', CALLABLE, {
    statusCode: 429,
    headers: CORS,
    body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Too many requests. Try again later.' } },
  }).as('reset');
}

/** Opens the sign-in form signed out, whatever an earlier spec left in IndexedDB. */
function visitSignedOut(path: string): void {
  cy.visit(path, {
    onBeforeLoad(win) {
      // Queued before the app's own open, so the app waits for it and starts
      // with no persisted session.
      win.indexedDB.deleteDatabase('firebaseLocalStorageDb');
    },
  });
}

describe('asking for a reset link (#905)', () => {
  it('sign-in: "Forgot password?" sends only the typed address and says the link is on its way', () => {
    const payloads: unknown[] = [];
    stubCallables({
      requestPasswordReset: (payload: unknown) => {
        payloads.push(payload);
        return { ok: true };
      },
    });
    visitSignedOut('/signin');
    cy.get('#email', { timeout: 20_000 }).type(`  ${RESET_KINFOLK.email} `);
    cy.contains('a', 'Forgot password?').click();
    cy.contains('Reset link sent. Check your inbox.').should('be.visible');
    cy.then(() => expect(payloads).to.deep.equal([{ email: RESET_KINFOLK.email }]));
  });

  it('sign-in: a rate-limited reset says to wait, not that something went wrong', () => {
    refuseWithRateLimit();
    visitSignedOut('/signin');
    cy.get('#email', { timeout: 20_000 }).type(RESET_KINFOLK.email);
    cy.contains('a', 'Forgot password?').click();
    cy.wait('@reset');
    cy.contains('Too many tries for now.').should('be.visible');
    cy.contains('Wait a few minutes, then try again.').should('be.visible');
    cy.contains("Couldn't send reset email.").should('not.exist');
    cy.contains('Reset link sent. Check your inbox.').should('not.exist');
  });

  it('email action page: "Send a new link" on a dead link asks the callable and confirms', () => {
    const payloads: unknown[] = [];
    stubCallables({
      requestPasswordReset: (payload: unknown) => {
        payloads.push(payload);
        return { ok: true };
      },
    });
    visitSignedOut('/account/secure-reset?mode=resetPassword&oobCode=e2e-not-a-real-code&apiKey=fake-api-key');
    cy.contains('This reset link has already been used or is not valid.', { timeout: 20_000 }).should('be.visible');
    cy.get('#resend-email').type(STAFF.email);
    cy.contains('button', 'Send a new link').click();
    cy.contains('A new link is on its way.').should('be.visible');
    // No continue URL travels: the server sends staff back to the admin sign-in itself.
    cy.then(() => expect(payloads).to.deep.equal([{ email: STAFF.email }]));
  });

  it('email action page: a rate-limited "Send a new link" says to wait', () => {
    refuseWithRateLimit();
    visitSignedOut('/account/secure-reset?mode=resetPassword&oobCode=e2e-not-a-real-code&apiKey=fake-api-key');
    cy.contains('This reset link has already been used or is not valid.', { timeout: 20_000 }).should('be.visible');
    cy.get('#resend-email').type(RESET_KINFOLK.email);
    cy.contains('button', 'Send a new link').click();
    cy.wait('@reset');
    cy.contains('Too many tries for now. Wait a few minutes, then try again.').should('be.visible');
    cy.contains('A new link is on its way.').should('not.exist');
  });
});
