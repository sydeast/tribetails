import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';
import { takeConsoleErrors } from '../support/e2e';

/**
 * The operator's own Account screen (`/account`): inline profile edit, its
 * validation, the notification switches, and the Security rows.
 *
 * THIS IS THE FIRST FEATURE SPEC IN THE SUITE, and it is shaped by the ruling
 * that shrank the last one (see `smoke.cy.ts`): every test below asserts that
 * something CHANGED, on a round trip through the emulator, inside a budget.
 * Nothing here passes because an element was on the page.
 *
 * THE PROFILE HALF USES NO CALLABLE. It is a direct `users/{uid}` read and
 * `setDoc`, so it runs against the real `isAuntie()` rules with nothing
 * stubbed, and a green there is earned end to end. Issue #719 added three
 * callables to this screen (the admin roster behind the "Sole admin" badge and
 * the two notification reads), and this harness pins callables at a dead port
 * by design (docs/runbooks/e2e.md). The two notification reads and their save
 * are therefore intercepted below, by the same operator ruling of 2026-09-01
 * that covers `my-notifications.cy.ts`. `listBusinessAdmins` is deliberately
 * left unstubbed: its only effect is a badge the screen omits when the roster
 * cannot be read, which is exactly the behaviour worth proving here.
 *
 * VALUES ARE UNIQUE PER RUN. The seed writes no profile fields, but the seed
 * runs once per node process, and under `cypress open` this file is re-run
 * against whatever the last run saved. A run stamp lets each test assert
 * "absent before, present after" without needing a clean database.
 *
 * ORDER MATTERS AT THE END. The Security sign-out test is last because it ends
 * the browser signed OUT.
 */

/** Per-run suffix; see the file comment. */
const STAMP = Date.now().toString(36);
const NEW_NAME = `E2E Operator ${STAMP}`;
const NEW_TITLE = `Lead sitter ${STAMP}`;

/**
 * Budgets, in ms. These are MEASURED with `Date.now()` around the command chain
 * and asserted as numbers, because a `{ timeout }` alone is not a budget:
 * Cypress's default is already 4000ms, so a 5000ms timeout would be looser
 * than doing nothing.
 *
 * `PROFILE_RENDER` covers the lazy `Account` chunk (vite transforms it on the
 * first request of a run) plus one `getDoc` against the emulator. `SAVE` covers
 * one `setDoc` plus the re-read the screen does after it. Both are generous
 * against a warm laptop and tight against the fifteen-second screens the suite
 * was rebuilt to catch.
 */
const BUDGET_MS = { PROFILE_RENDER: 6_000, SAVE: 3_000 } as const;

const CALLABLE = (name: string) => `**/us-central1/${name}`;

/** One editable notification with all three channels open, in the owner hat. */
const MATRIX = {
  catalog: [
    {
      key: 'e2e.visit.reminder',
      label: 'Visit reminder (e2e)',
      category: 'visit',
      audience: 'business',
      audiences: { business: true },
      allowedChannels: ['email', 'sms', 'push'],
      required: {},
      description: 'A reminder the morning of a visit.',
    },
  ],
  overrides: {},
  ungated: [],
  businessAdminCount: 1,
  updatedAtMs: null,
};

const EMPTY_PREFS = { prefs: { byKey: {}, byCategory: {}, marketingOptIn: {} }, updatedAtMs: null };

/** Intercepts the two notification reads and the save; `@save` carries the body. */
function stubNotificationCallables() {
  cy.intercept('POST', CALLABLE('getBusinessNotificationOverrides'), {
    statusCode: 200,
    body: { result: MATRIX },
  });
  cy.intercept('POST', CALLABLE('getMyAdminNotificationPrefs'), {
    statusCode: 200,
    body: { result: EMPTY_PREFS },
  });
  cy.intercept('POST', CALLABLE('saveMyAdminNotificationPrefs'), {
    statusCode: 200,
    body: { result: { ok: true } },
  }).as('savePrefs');
}

/**
 * A string that would break a screen which builds markup from profile text
 * or trusts the shape of a name: quotes of both kinds, an HTML tag with an
 * entity inside it, and a supplementary-plane emoji. Every field it goes into
 * must come back byte-identical, and the tag must land as text.
 */
const HOSTILE_NAME = `O'Brien "Kit" <b>&amp;</b> 🐾 ${STAMP}`;
const HOSTILE_BIO = `Line one ${STAMP}\nLine two, with a comma; and a semicolon.`;
const HOSTILE_PHONE = '+1 (805) 555-0100';

describe('account', () => {
  afterEach(() => {
    // The support file records `console.error` on every page and filters the
    // harness's own noise out; this is the first spec to read the result. A
    // React effect that throws on this screen fails here, not silently.
    expect(takeConsoleErrors(), 'unexpected console.error lines').to.deep.equal([]);
  });

  // Needs a signed-OUT browser. A fresh `cypress run` gives one, but under
  // `cypress open` this file can follow one that ended signed in, and `/signin`
  // has no guard that bounces a live session. So it makes its own precondition
  // the same way `signInAs` reads the page: wait for whichever of rail or card
  // appears, and sign out if it was the rail.
  it('refuses a wrong password at the front door', () => {
    cy.visit('/home', { failOnStatusCode: true });
    cy.get('.shell__rail, .signin__card', { timeout: 30_000 }).should('exist');
    cy.get('body').then(($body) => {
      if ($body.find('.shell__rail').length > 0) cy.signOut();
    });
    cy.get('.signin__card', { timeout: 30_000 }).should('exist');
    cy.get('.signin__form input[type="email"]').type(ADMIN.email);
    cy.get('.signin__form input[type="password"]').type('not-the-password', { log: false });
    cy.contains('.signin__form button', 'Sign in').click();
    // The mapped line, not a raw `auth/invalid-credential`: proves
    // `SignIn.authMessage` was reached, not just that something red appeared.
    cy.get('.signin__card [role="alert"]').should('contain.text', 'Email or password is incorrect.');
    cy.location('pathname').should('eq', '/signin');
    cy.get('.shell__rail').should('not.exist');
  });

  it('is reached from the topbar chip and renders the profile inside budget', () => {
    cy.signIn();
    // The way a person gets there: Account is contextual (absent from the
    // rail), the chip is its only entry point.
    const t0 = Date.now();
    cy.get('.shell__account').click();
    cy.location('pathname').should('eq', '/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from chip click to profile fields').to.be.lessThan(
        BUDGET_MS.PROFILE_RENDER,
      );
    });
    // Baseline for the edit below: this run's value is not there yet.
    cy.get('#account-display-name').invoke('val').should('not.contain', STAMP);
    // The fields are editable where they are read. There is no dialog.
    cy.get('#account-first-name').should('be.enabled');
    cy.contains('button', 'Edit profile').should('not.exist');
  });

  it('saves an inline profile edit through Firestore and reads it back after a reload', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    // Nothing typed yet, so there is nothing to save.
    cy.contains('button', 'Save profile').should('be.disabled');
    cy.get('#account-display-name').clear().type(NEW_NAME);
    cy.get('#account-title').clear().type(NEW_TITLE);

    const t0 = Date.now();
    cy.contains('button', 'Save profile').click();
    // The banner appears only after `setDoc` resolved, so "banner shown" is
    // "the write landed", and it is timed.
    cy.contains('Profile saved.', { timeout: BUDGET_MS.SAVE }).should('exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Save to the saved banner').to.be.lessThan(BUDGET_MS.SAVE);
    });
    cy.get('.account__heroName').should('have.text', NEW_NAME);
    cy.get('.account__heroRole').should('contain.text', NEW_TITLE);

    // Local state could show all of the above with the write dropped on the
    // floor. A reload throws that state away and reads `users/{uid}` again.
    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    cy.get('#account-display-name').should('have.value', NEW_NAME);
    cy.get('#account-title').should('have.value', NEW_TITLE);
  });

  it('saves First and Last name as two separate fields', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    cy.get('#account-first-name').clear().type(`Nora${STAMP}`);
    cy.get('#account-last-name').clear().type(`Brooks${STAMP}`);
    cy.contains('button', 'Save profile').click();
    cy.contains('Profile saved.', { timeout: BUDGET_MS.SAVE }).should('exist');

    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    cy.get('#account-first-name').should('have.value', `Nora${STAMP}`);
    cy.get('#account-last-name').should('have.value', `Brooks${STAMP}`);
  });

  it('round-trips quotes, a tag, an emoji and newlines verbatim, and trims padding', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    // `parseSpecialCharSequences: false`: the value has no Cypress key
    // sequences in it, but a name with braces would otherwise be eaten.
    cy.get('#account-display-name').clear().type(HOSTILE_NAME, { parseSpecialCharSequences: false });
    cy.get('#account-phone').clear().type(HOSTILE_PHONE);
    // Padded on purpose: the save trims before writing and the screen must show
    // the trimmed value, or every operator with a trailing space gets a title
    // that does not match what they typed the next time they edit it.
    cy.get('#account-title').clear().type(`   Padded title ${STAMP}   `);
    cy.get('#account-bio').clear().type(HOSTILE_BIO);
    cy.contains('button', 'Save profile').click();
    cy.contains('Profile saved.', { timeout: BUDGET_MS.SAVE }).should('exist');

    // After a reload, so the values below came out of Firestore, not state.
    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    cy.get('#account-display-name').should('have.value', HOSTILE_NAME);
    cy.get('#account-phone').should('have.value', HOSTILE_PHONE);
    cy.get('#account-title').should('have.value', `Padded title ${STAMP}`);
    cy.get('#account-bio').should('have.value', HOSTILE_BIO);
    // The `<b>` arrived as text in the hero. A screen that set innerHTML from
    // the profile would render a bold element there instead.
    cy.get('.account__heroName').should('have.text', HOSTILE_NAME);
    cy.get('.account__heroName b').should('not.exist');
  });

  it('refuses a blank display name and leaves the saved one alone', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    // Read the current value rather than assuming the previous test's, so a
    // failure there does not cascade into a false failure here.
    cy.get('#account-display-name')
      .invoke('val')
      .then((before) => {
        cy.get('#account-display-name').clear();
        cy.contains('button', 'Save profile').click();
        cy.get('#account-display-name-error[role="alert"]').should(
          'have.text',
          "Display name can't be blank.",
        );
        // The gate held: nothing was written.
        cy.reload();
        cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
        cy.get('#account-display-name').should('have.value', before);
      });
  });

  it('carries the business profile fields on this page, seeded from business_settings', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    // Read only here: writing `business_settings` would move a document every
    // other spec in this suite reads. The write path has vitest coverage.
    cy.contains('.den-panel-title', 'Business profile').should('exist');
    cy.contains('.settingsEdit__fieldLabel', 'Business name').should('exist');
    cy.contains('.settingsEdit__fieldLabel', 'Address').should('exist');
  });

  it('sends exactly the notification channel that was switched', () => {
    stubNotificationCallables();
    cy.signIn();
    cy.visit('/account');
    cy.get('[role="switch"][aria-label="SMS notifications"]', {
      timeout: BUDGET_MS.PROFILE_RENDER,
    })
      .should('have.attr', 'aria-checked', 'false')
      .click();

    cy.wait('@savePrefs').then(({ request }) => {
      const body = request.body as { data: { prefs: { byKey: Record<string, unknown> } } };
      expect(body.data.prefs.byKey).to.deep.equal({ 'e2e.visit.reminder': { sms: true } });
    });
    cy.get('[role="switch"][aria-label="SMS notifications"]').should(
      'have.attr',
      'aria-checked',
      'true',
    );
  });

  it('hands off to My Notifications', () => {
    stubNotificationCallables();
    cy.signIn();
    cy.visit('/account');
    cy.contains('button', 'Open my notification settings').click();
    cy.location('pathname').should('eq', '/my-notifications');
  });

  describe('security', () => {
    it('refuses a wrong current password on the login-email form', () => {
      cy.signIn();
      cy.visit('/account');
      cy.get('#security-new-email').type(`rotated-${STAMP}@auntieos.test`);
      cy.get('#security-email-password').type('not-the-password', { log: false });
      cy.contains('button', 'Send verification link').click();
      cy.contains('.security__section [role="alert"]', 'Current password is incorrect.', {
        timeout: 10_000,
      }).should('exist');
    });

    it('keeps the Send button disabled for a malformed new email', () => {
      cy.signIn();
      cy.visit('/account');
      cy.get('#security-new-email').type('not-an-address');
      cy.get('#security-email-password').type(ADMIN.password, { log: false });
      cy.contains('button', 'Send verification link').should('be.disabled');
    });

    it('offers a reset link instead of a typed password form', function () {
      // FIXTURE ONLY. Against a deployed host this would mail a real reset
      // link to the real operator, which is not something a test gets to do.
      // `this.skip()` rather than an early return: a return would report green.
      if (!usingFixtureAdmin()) this.skip();
      cy.signIn();
      cy.visit('/account');
      cy.contains('.security__rowTitle', 'Change password').should('exist');
      cy.get('#security-new-password').should('not.exist');
      cy.contains('button', 'Send reset email').click();
      // The auth emulator accepts the request and mails nothing.
      cy.contains(`Reset link sent to ${ADMIN.email}`, { timeout: 10_000 }).should('exist');
    });

    // LAST: it ends the browser signed out.
    it('signs the operator out from the Security panel', () => {
      cy.signIn();
      cy.visit('/account');
      cy.contains('.security__rowTitle', 'Sign out').should('exist');
      cy.contains('.security__row button', 'Sign out').click();
      // The card, not the URL: `signOut` reloads, and the path is not settled
      // until the route guard has decided (see `cy.signOut`).
      cy.get('.signin__card', { timeout: 30_000 }).should('exist');
      cy.get('.shell__rail').should('not.exist');
    });
  });
});
