import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';

/**
 * The operator's own Account screen (`/account`): profile edit, its validation,
 * the notifications hand-off, and a real password change.
 *
 * THIS IS THE FIRST FEATURE SPEC IN THE SUITE, and it is shaped by the ruling
 * that shrank the last one (see `smoke.cy.ts`): every test below asserts that
 * something CHANGED, on a round trip through the emulator, inside a budget.
 * Nothing here passes because an element was on the page.
 *
 * WHY THIS SCREEN FIRST. It is the one admin screen with no callable anywhere
 * on it: the profile is a direct `users/{uid}` read and `setDoc`, the password
 * change is Firebase Auth client-side. So it runs against the real
 * `isAuntie()` rules and the real auth emulator with nothing stubbed, and a
 * green here is earned end to end.
 *
 * VALUES ARE UNIQUE PER RUN. The seed writes no profile fields, but the seed
 * runs once per node process, and under `cypress open` this file is re-run
 * against whatever the last run saved. A baseline of "(not set)" would fail on
 * a healthy app the second time through. A run stamp lets each test assert
 * "absent before, present after" without needing a clean database.
 *
 * ORDER MATTERS AT THE END. The password test is last because it ends the
 * browser signed OUT with the fixture password changed, and `after()` puts the
 * password back over REST so the next spec file's `cy.signIn()` still works.
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
 * one `setDoc` plus the reload the screen does on `onSaved`. Both are generous
 * against a warm laptop and tight against the fifteen-second screens the suite
 * was rebuilt to catch.
 */
const BUDGET_MS = { PROFILE_RENDER: 6_000, SAVE: 3_000 } as const;

/** The `<dd>` for one labelled row of an `account__fields` list. */
function field(label: string) {
  return cy.contains('dt.account__field-label', label).parent().find('dd');
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
  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here. A React
  // effect that throws on this screen fails there, not silently.

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
    field('Display name').should('not.contain.text', STAMP);
  });

  it('saves a profile edit through Firestore and reads it back after a reload', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    cy.contains('button', 'Edit profile').click();
    cy.get('[role="dialog"]').should('exist');
    cy.get('#edit-profile-display-name').clear().type(NEW_NAME);
    cy.get('#edit-profile-title').clear().type(NEW_TITLE);

    const t0 = Date.now();
    cy.contains('[role="dialog"] button', 'Save').click();
    // The dialog closes only from `onSaved`, which fires only after `setDoc`
    // resolved. So "dialog gone" is "the write landed", and it is timed.
    cy.get('[role="dialog"]', { timeout: BUDGET_MS.SAVE }).should('not.exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Save to dialog closed').to.be.lessThan(BUDGET_MS.SAVE);
    });
    field('Display name').should('have.text', NEW_NAME);
    field('Title').should('have.text', NEW_TITLE);
    cy.get('.account__identity-name').should('have.text', NEW_NAME);
    cy.get('.account__identity-title').should('have.text', NEW_TITLE);

    // Local state could show all of the above with the write dropped on the
    // floor. A reload throws that state away and reads `users/{uid}` again.
    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    field('Display name').should('have.text', NEW_NAME);
    field('Title').should('have.text', NEW_TITLE);
  });

  it('round-trips quotes, a tag, an emoji and newlines verbatim, and trims padding', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    cy.contains('button', 'Edit profile').click();
    // `parseSpecialCharSequences: false`: the value has no Cypress key
    // sequences in it, but a name with braces would otherwise be eaten.
    cy.get('#edit-profile-display-name').clear().type(HOSTILE_NAME, { parseSpecialCharSequences: false });
    cy.get('#edit-profile-phone').clear().type(HOSTILE_PHONE);
    // Padded on purpose: the dialog trims before saving and the screen must
    // show the trimmed value, or every operator with a trailing space gets a
    // title that does not match what they typed the next time they edit it.
    cy.get('#edit-profile-title').clear().type(`   Padded title ${STAMP}   `);
    cy.get('#edit-profile-bio').clear().type(HOSTILE_BIO);
    cy.contains('[role="dialog"] button', 'Save').click();
    cy.get('[role="dialog"]', { timeout: BUDGET_MS.SAVE }).should('not.exist');

    // After a reload, so the values below came out of Firestore, not state.
    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    field('Display name').should('have.text', HOSTILE_NAME);
    // The `<b>` arrived as text. A screen that set innerHTML from the profile
    // would render a bold element here instead, and `have.text` alone would
    // still pass because the entity decodes to the same characters.
    field('Display name').find('b').should('not.exist');
    cy.get('.account__identity-name').should('have.text', HOSTILE_NAME);
    cy.get('.account__identity-name b').should('not.exist');
    field('Phone').should('have.text', HOSTILE_PHONE);
    field('Title').should('have.text', `Padded title ${STAMP}`);
    field('Bio').should('have.text', HOSTILE_BIO);

    // And the editor reopens with exactly what was saved, tag and all: the
    // next edit starts from the truth, not from a rendering of it.
    cy.contains('button', 'Edit profile').click();
    cy.get('#edit-profile-display-name').should('have.value', HOSTILE_NAME);
    cy.get('#edit-profile-bio').should('have.value', HOSTILE_BIO);
    cy.contains('[role="dialog"] button', 'Cancel').click();
  });

  it('refuses a blank display name and leaves the saved one alone', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');

    // Read the current value rather than assuming the previous test's, so a
    // failure there does not cascade into a false failure here.
    field('Display name')
      .invoke('text')
      .then((before) => {
        cy.contains('button', 'Edit profile').click();
        cy.get('#edit-profile-display-name').clear();
        cy.contains('[role="dialog"] button', 'Save').click();
        cy.get('#edit-profile-name-error[role="alert"]').should(
          'have.text',
          "Display name can't be blank.",
        );
        // The gate held: the dialog is still open, nothing was written.
        cy.get('[role="dialog"]').should('exist');
        cy.contains('[role="dialog"] button', 'Cancel').click();
        cy.get('[role="dialog"]').should('not.exist');
        field('Display name').should('have.text', before);
      });
  });

  it('hands off to My Notifications', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.PROFILE_RENDER }).should('exist');
    cy.contains('button', 'Open my notification settings').click();
    cy.location('pathname').should('eq', '/my-notifications');
  });

  describe('password', () => {
    // Only ever against the fixture. A deployed admin's password changed by a
    // spec, with the REST reset pointed at an emulator that is not there, is
    // an operator locked out. See `usingFixtureAdmin`.
    const NEW_PW = `e2e-rotated-${STAMP}`;

    before(function () {
      if (!usingFixtureAdmin()) this.skip();
    });

    after(function () {
      // Mocha still runs this hook when `before` skipped the block, and on a
      // deployed host the task would dial an emulator that is not there and
      // mark the whole file red from the hook. Same gate, same reason.
      if (!usingFixtureAdmin()) return;
      // Over REST, not through the form. Operator's call (2026-09-01): the
      // form path would prove the reverse rotation works, but it only runs if
      // the rotation itself succeeded, which is exactly when a restore matters
      // least. The task runs in the node process and does not care what state
      // the browser was left in. Any later spec file's `cy.signIn()` then finds
      // the fixture password live again.
      cy.task('resetAdminPassword');
    });

    it('keeps the Update button disabled for a new password under six characters', () => {
      cy.signIn();
      cy.visit('/account');
      cy.get('#security-current-password').type(ADMIN.password, { log: false });
      cy.get('#security-new-password').type('short', { log: false });
      cy.get('#security-confirm-password').type('short', { log: false });
      // Six is the floor `changePassword` enforces before any round trip. The
      // button gate is the only thing standing between a five-character
      // password and a wasted reauth, so it is what gets asserted.
      cy.contains('button', 'Update password').should('be.disabled');
    });

    it('refuses a wrong current password and changes nothing', () => {
      cy.signIn();
      cy.visit('/account');
      cy.get('#security-current-password').type('not-the-password', { log: false });
      cy.get('#security-new-password').type(NEW_PW, { log: false });
      cy.get('#security-confirm-password').type(NEW_PW, { log: false });
      cy.contains('button', 'Update password').click();
      cy.contains('.security__section [role="alert"]', 'Current password is incorrect.', {
        timeout: 10_000,
      }).should('exist');

      // "Changes nothing" is not a banner. Sign out and back in with the
      // ORIGINAL password: if the reauth had been skipped and the update
      // applied anyway, this is the step that fails.
      cy.signOut();
      cy.signInAs(ADMIN.email, ADMIN.password);
      cy.location('pathname').should('eq', '/home');
    });

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

    it('rejects a mismatched confirmation before any round trip', () => {
      cy.signIn();
      cy.visit('/account');
      cy.get('#security-new-password').type(NEW_PW, { log: false });
      cy.get('#security-confirm-password').type(`${NEW_PW}x`, { log: false });
      cy.get('#security-confirm-error[role="alert"]').should(
        'have.text',
        "New passwords don't match.",
      );
      cy.contains('button', 'Update password').should('be.disabled');
    });

    it('changes the password, and the new one signs in', () => {
      cy.signIn();
      cy.visit('/account');
      cy.get('#security-current-password').type(ADMIN.password, { log: false });
      cy.get('#security-new-password').type(NEW_PW, { log: false });
      cy.get('#security-confirm-password').type(NEW_PW, { log: false });
      cy.contains('button', 'Update password').click();
      cy.contains('Password updated.', { timeout: 10_000 }).should('exist');

      // The banner says the SDK resolved. The proof is the front door: sign
      // out (which also empties the IndexedDB session, so `signInAs` cannot
      // short-circuit), then come back in with the new password only.
      cy.signOut();
      cy.signInAs(ADMIN.email, NEW_PW);
      cy.location('pathname').should('eq', '/home');

      // End signed out. The next spec file signs in with the fixture password
      // that `after()` restores; a session minted under the rotated one must
      // not be left in IndexedDB for it to find.
      cy.signOut();
    });
  });
});
