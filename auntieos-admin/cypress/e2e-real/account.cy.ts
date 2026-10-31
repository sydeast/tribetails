import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';
import { vendorConfigured } from '../support/e2e-real';

/**
 * Account (`/account`), the callable-backed half, against the REAL
 * `getBusinessNotificationOverrides`, `getMyAdminNotificationPrefs`,
 * `saveMyAdminNotificationPrefs`, `listBusinessAdmins` and
 * `requestPasswordReset` (#1195, the real-services counterpart of
 * `cypress/e2e/account.cy.ts`).
 *
 * The PR-time spec's profile tests use no callable and already run end to end
 * against the emulator, so they are not repeated here. What it stubs is the
 * notifications panel (a one-row catalog and a save it only inspects) and the
 * reset callable (answered `ok` without sending). Here:
 *
 *   - #719: the three channel switches render from the functions' catalog;
 *   - a channel switched on the Account panel is saved for every row it
 *     covers, so after a reload the switch is still on and My Notifications
 *     shows that channel on for an open row;
 *   - the hero's "Sole admin" badge is drawn from the real admin roster
 *     (`listBusinessAdmins`), which the PR-time harness cannot reach;
 *   - Send reset email really sends, through smtp2go, to the fixture admin's
 *     inbox (e2e-admin@tribetails.com, one of the three real test inboxes).
 *     It SKIPS, naming the variables, when the run has no email credentials.
 *
 * `staff/{uid}.notificationPrefs` is reset before and after.
 */

/** RENDER includes the cold start of the reads. SAVE is one real save plus the re-read. */
const BUDGET_MS = { RENDER: 15_000, SAVE: 10_000, RESET: 20_000 } as const;

function resetPrefs() {
  cy.task<string>('authUid', { email: ADMIN.email }).then((uid) => {
    cy.task('upsertDoc', { collection: 'staff', id: uid, doc: { notificationPrefs: {} } });
  });
}

function openAccount() {
  cy.signIn();
  cy.visit('/account');
  cy.get('.account__fields', { timeout: BUDGET_MS.RENDER }).should('exist');
}

const smsSwitch = () =>
  cy.get('[role="switch"][aria-label="SMS notifications"]', { timeout: BUDGET_MS.RENDER });

describe('account (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  beforeEach(() => {
    resetPrefs();
  });

  after(() => {
    resetPrefs();
  });

  it('#719 draws all three channel switches from the server catalog', () => {
    openAccount();
    cy.get('[role="switch"][aria-label="Email notifications"]', { timeout: BUDGET_MS.RENDER }).should('exist');
    smsSwitch().should('exist').and('have.attr', 'aria-checked', 'false');
    cy.get('[role="switch"][aria-label="Push notifications"]').should('exist');
  });

  it('saves a channel switched on for every row it covers, read back after a reload and on My Notifications', () => {
    openAccount();
    smsSwitch().should('have.attr', 'aria-checked', 'false').click();
    // The panel is pessimistic: the switch only reads on once
    // saveMyAdminNotificationPrefs has resolved, so this is the save landing.
    cy.get('[role="switch"][aria-label="SMS notifications"]', { timeout: BUDGET_MS.SAVE })
      .should('have.attr', 'aria-checked', 'true')
      .and('be.enabled');

    // A reload throws local state away, so the switch reads the stored prefs
    // back through getMyAdminNotificationPrefs.
    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.RENDER }).should('exist');
    smsSwitch().should('have.attr', 'aria-checked', 'true');

    // The same stored prefs, read by the other screen that edits them.
    cy.contains('button', 'Open my notification settings').click();
    cy.location('pathname').should('eq', '/my-notifications');
    cy.get('[role="switch"][aria-label="Kinfolk requested a KinCare visit via Text (SMS)"]', {
      timeout: BUDGET_MS.RENDER,
    }).should('have.attr', 'aria-checked', 'true');
  });

  it('#719 marks the operator as the sole admin from the real roster', () => {
    openAccount();
    cy.contains('.account__hero .den-statuspill', 'Active').should('exist');
    cy.contains('.account__hero .den-statuspill', 'Sole admin', { timeout: BUDGET_MS.RENDER }).should('exist');
  });

  it('sends a real reset email to the fixture admin through requestPasswordReset', function () {
    if (!vendorConfigured('email')) {
      cy.log('SKIPPED: no email credentials in this run (E2E_SMTP2GO_API_KEY, E2E_EMAIL_FROM)');
      this.skip();
    }
    openAccount();
    cy.contains('.security__rowTitle', 'Change password').should('exist');
    cy.contains('.security__row button', 'Send reset email').click();
    // The confirmation only renders once the callable has resolved, and the
    // handler only resolves after `sendTemplatedEmail` returned: a refused send
    // throws and the screen shows the failure instead.
    cy.contains(`Reset link sent to ${ADMIN.email}`, { timeout: BUDGET_MS.RESET }).should('exist');
  });
});
