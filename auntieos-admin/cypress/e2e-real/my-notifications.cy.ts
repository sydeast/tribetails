import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';

/**
 * My Notifications (`/my-notifications`) against the REAL
 * `getBusinessNotificationOverrides`, `getMyAdminNotificationPrefs` and
 * `saveMyAdminNotificationPrefs` (#1195, the real-services counterpart of
 * `cypress/e2e/my-notifications.cy.ts`).
 *
 * The PR-time spec hands the screen a two-row catalog it wrote itself and reads
 * the save's request body, so it proves which field a flipped switch sends.
 * Persistence is out of its reach. Here the catalog is the functions' own
 * (`NOTIFICATION_CATALOG`), the save writes `staff/{uid}.notificationPrefs`, and
 * each claim is read back through a reload:
 *
 *   - a channel switched ON and saved is still on after a reload;
 *   - email switched OFF stays off, which only holds when the save stored an
 *     explicit false (an absent key would inherit email's default, ON);
 *   - Discard puts the draft back and nothing is stored;
 *   - a channel the catalog requires (`kincare.requested` requires email) is
 *     drawn forced: disabled, named "set by your business".
 *
 * The row under test is `kincare.requested` ("Kinfolk requested a KinCare
 * visit"), a business-audience entry with email required and SMS and push
 * open. Its title is read off the screen, not hard-coded, so a relabel in the
 * catalog moves the selector with it.
 *
 * The refused-save case (a 500 from the save) needs a server that can be told
 * to fail, so it stays in the PR-time spec only.
 *
 * `staff/{uid}.notificationPrefs` is reset before and after, so every test
 * starts from the defaults and Account (`account.cy.ts`) reads them too.
 */

/** RENDER includes the cold start of both reads. SAVE is one real `saveMyAdminNotificationPrefs`. */
const BUDGET_MS = { RENDER: 15_000, SAVE: 10_000 } as const;

/** Matches the row's email switch, which the catalog forces: its label ends with the forced suffix. */
const FORCED_EMAIL = /^Kinfolk requested a KinCare visit via Email, set by your business$/;

function resetPrefs() {
  cy.task<string>('authUid', { email: ADMIN.email }).then((uid) => {
    cy.task('upsertDoc', { collection: 'staff', id: uid, doc: { notificationPrefs: {} } });
  });
}

function channelSwitch(channelLabel: string) {
  return cy.get(`[role="switch"][aria-label="Kinfolk requested a KinCare visit via ${channelLabel}"]`, {
    timeout: BUDGET_MS.RENDER,
  });
}

/** Through Account, the way a person gets there, then waits for the server's catalog. */
function openMyNotifications() {
  cy.signIn();
  cy.visit('/account');
  cy.contains('button', 'Open my notification settings', { timeout: BUDGET_MS.RENDER }).click();
  cy.location('pathname').should('eq', '/my-notifications');
  channelSwitch('Text (SMS)').should('exist');
}

function save() {
  let t0 = 0;
  cy.contains('button', 'Save changes')
    .should('be.enabled')
    .click()
    .then(() => {
      t0 = Date.now();
    });
  cy.contains('button', 'Saved', { timeout: BUDGET_MS.SAVE }).should('exist');
  cy.then(() => {
    expect(Date.now() - t0, 'ms from Save changes to the saved state').to.be.lessThan(BUDGET_MS.SAVE);
  });
}

describe('my notifications (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  beforeEach(() => {
    resetPrefs();
  });

  after(() => {
    resetPrefs();
  });

  it('saves a channel switched on, and it is still on after a reload', () => {
    openMyNotifications();
    // Defaults with nothing saved (`userChannelChoice`): SMS off.
    channelSwitch('Text (SMS)').should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').should('be.disabled');

    channelSwitch('Text (SMS)').click();
    channelSwitch('Text (SMS)').should('have.attr', 'aria-checked', 'true');
    save();

    cy.reload();
    channelSwitch('Text (SMS)').should('have.attr', 'aria-checked', 'true');
    // Nothing else moved: push is still at its default.
    channelSwitch('Push').should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').should('be.disabled');
  });

  it('turns a default-on channel off, and it stays off after a reload', () => {
    // Email on this row is forced, so the open default-on channel is found on
    // a row the operator decides: the first email switch that is enabled and on.
    openMyNotifications();
    cy.get('[role="switch"][aria-checked="true"]:not([disabled])')
      .filter((_, el) => / via Email$/.test(el.getAttribute('aria-label') ?? ''))
      .first()
      .invoke('attr', 'aria-label')
      .then((label) => {
        const sw = () => cy.get(`[role="switch"][aria-label="${String(label)}"]`, { timeout: BUDGET_MS.RENDER });
        sw().click();
        sw().should('have.attr', 'aria-checked', 'false');
        save();
        cy.reload();
        sw().should('have.attr', 'aria-checked', 'false');
      });
  });

  it('puts the draft back on Discard, and nothing was stored', () => {
    openMyNotifications();
    channelSwitch('Text (SMS)').click();
    channelSwitch('Text (SMS)').should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Discard').should('be.enabled').click();
    channelSwitch('Text (SMS)').should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').should('be.disabled');

    cy.reload();
    channelSwitch('Text (SMS)').should('have.attr', 'aria-checked', 'false');
  });

  it('draws the channel the catalog requires as forced, and leaves its siblings to the operator', () => {
    openMyNotifications();
    cy.get('[role="switch"]')
      .filter((_, el) => FORCED_EMAIL.test(el.getAttribute('aria-label') ?? ''))
      .should('have.length.at.least', 1)
      .first()
      .should('be.disabled')
      .and('have.attr', 'aria-checked', 'true');
    channelSwitch('Text (SMS)').should('be.enabled');
  });
});
