import { usingFixtureAdmin } from '../support/commands';

/**
 * My Notifications (`/my-notifications`): the operator's own receive switches.
 *
 * BOTH SIDES OF THIS SCREEN ARE CALLABLES (`getBusinessNotificationOverrides`,
 * `getMyAdminNotificationPrefs`, `saveMyAdminNotificationPrefs`), and this
 * harness pins callables at a dead port by design (docs/runbooks/e2e.md). So
 * the three are intercepted here, by operator ruling on 2026-09-01, and what
 * this file proves is the SCREEN: that a switch the operator flips is the
 * field the save sends, that a refused save keeps the draft and re-arms Save,
 * that Discard puts the draft back, and that a channel the business forces
 * cannot be flipped at all. Persistence is not proven here; it is the deployed
 * host's to prove.
 *
 * THE FIXTURE IS THE WIRE SHAPE, not the decoded one: it is what the callable
 * would have returned, run through the app's real decoders. A fixture in the
 * decoded shape would pass while the decoder was broken.
 *
 * EMULATOR RUNS ONLY. The intercept pattern matches the emulator's
 * `/<project>/us-central1/<name>` path, not `us-central1-<project>
 * .cloudfunctions.net`, so against a deployed host the stubs would never fire,
 * the real catalog would come back, and every assertion on the fixture rows
 * would fail on content. An unstubbed variant that asserts against a deployed
 * catalog is not written; the file skips itself under the deployed-host
 * overrides (docs/runbooks/e2e.md, "Pointing a Cypress run at a deployed host").
 */

const CALLABLE = (name: string) => `**/us-central1/${name}`;

/** One editable notification with all three channels open, in the owner hat. */
const ENTRY_KEY = 'e2e.visit.reminder';
const ENTRY_TITLE = 'Visit reminder (e2e)';
/** One the business has locked email on for: forced, cannot be flipped. */
const FORCED_KEY = 'e2e.invoice.sent';
const FORCED_TITLE = 'Invoice sent (e2e)';

const MATRIX = {
  catalog: [
    {
      key: ENTRY_KEY,
      label: ENTRY_TITLE,
      category: 'visit',
      audience: 'business',
      audiences: { business: true },
      allowedChannels: ['email', 'sms', 'push'],
      required: {},
      description: 'A reminder the morning of a visit.',
    },
    {
      key: FORCED_KEY,
      label: FORCED_TITLE,
      category: 'invoice',
      audience: 'business',
      audiences: { business: true },
      allowedChannels: ['email', 'sms'],
      required: { email: true },
      description: 'Sent when an invoice goes out.',
    },
  ],
  overrides: {},
  ungated: [],
  businessAdminCount: 1,
  updatedAtMs: null,
};

const EMPTY_PREFS = {
  prefs: { byKey: {}, byCategory: {}, marketingOptIn: {} },
  updatedAtMs: null,
};

/** The `role="switch"` for one notification's channel, by its accessible name. */
function channelSwitch(title: string, channelLabel: string, suffix = '') {
  return cy.get(`[role="switch"][aria-label="${title} via ${channelLabel}${suffix}"]`);
}

/** Intercepts the two reads and the save; `@save` carries the request body. */
function stubCallables(saveResponse: { statusCode: number; body: unknown } = { statusCode: 200, body: { result: { ok: true } } }) {
  cy.intercept('POST', CALLABLE('getBusinessNotificationOverrides'), { statusCode: 200, body: { result: MATRIX } });
  cy.intercept('POST', CALLABLE('getMyAdminNotificationPrefs'), { statusCode: 200, body: { result: EMPTY_PREFS } });
  cy.intercept('POST', CALLABLE('saveMyAdminNotificationPrefs'), saveResponse).as('save');
}

/** Through Account, the way a person gets there. */
function openMyNotifications() {
  cy.signIn();
  cy.visit('/account');
  cy.contains('button', 'Open my notification settings').click();
  cy.location('pathname').should('eq', '/my-notifications');
  channelSwitch(ENTRY_TITLE, 'Email', '').should('exist');
}

describe('my notifications', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  // The support file's global afterEach reads and asserts on `console.error`
  // for every test in every spec; nothing extra is needed here.

  it('sends exactly the switch that was flipped, and nothing else', () => {
    stubCallables();
    openMyNotifications();

    // Defaults with no saved prefs: email on, the rest off (`userChannelChoice`).
    channelSwitch(ENTRY_TITLE, 'Email').should('have.attr', 'aria-checked', 'true');
    channelSwitch(ENTRY_TITLE, 'Text (SMS)').should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').should('be.disabled');

    channelSwitch(ENTRY_TITLE, 'Text (SMS)').click();
    channelSwitch(ENTRY_TITLE, 'Text (SMS)').should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Save changes').should('be.enabled').click();

    cy.wait('@save').then(({ request }) => {
      const prefs = (request.body as { data: { prefs: { byKey: Record<string, Record<string, boolean>> } } })
        .data.prefs;
      expect(prefs.byKey[ENTRY_KEY], 'the flipped key').to.deep.equal({ sms: true });
      expect(Object.keys(prefs.byKey), 'no other key was touched').to.deep.equal([ENTRY_KEY]);
    });
    cy.contains('button', 'Saved').should('exist');
  });

  it('turns a channel off, and the save says so', () => {
    stubCallables();
    openMyNotifications();

    channelSwitch(ENTRY_TITLE, 'Email').click();
    channelSwitch(ENTRY_TITLE, 'Email').should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').click();
    cy.wait('@save').then(({ request }) => {
      const prefs = (request.body as { data: { prefs: { byKey: Record<string, Record<string, boolean>> } } })
        .data.prefs;
      // An explicit false, not an absent key: absent means "inherit the
      // default", which for email is ON, so a save that dropped the key would
      // silently turn the channel back on.
      expect(prefs.byKey[ENTRY_KEY]).to.deep.equal({ email: false });
    });
  });

  it('keeps the draft and re-arms Save when the save is refused', () => {
    stubCallables({
      statusCode: 500,
      body: { error: { message: 'e2e: refused on purpose', status: 'INTERNAL' } },
    });
    openMyNotifications();

    channelSwitch(ENTRY_TITLE, 'Push').click();
    cy.contains('button', 'Save changes').click();
    cy.wait('@save');
    cy.get('[role="alert"]').should('contain.text', "save your notification settings");
    // The operator's edit survived the failure and can be retried.
    channelSwitch(ENTRY_TITLE, 'Push').should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Save changes').should('be.enabled');
  });

  it('puts the draft back on Discard without a round trip', () => {
    stubCallables();
    openMyNotifications();

    channelSwitch(ENTRY_TITLE, 'Text (SMS)').click();
    cy.contains('button', 'Discard').should('be.enabled').click();
    channelSwitch(ENTRY_TITLE, 'Text (SMS)').should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').should('be.disabled');
    // Nothing was sent. `cy.get('@save.all')` is the count of matched calls.
    cy.get('@save.all').should('have.length', 0);
  });

  it('cannot flip a channel the business forces', () => {
    stubCallables();
    openMyNotifications();

    channelSwitch(FORCED_TITLE, 'Email', ', set by your business')
      .should('be.disabled')
      .and('have.attr', 'aria-checked', 'true');
    // Its sibling is still the operator's to decide.
    channelSwitch(FORCED_TITLE, 'Text (SMS)').should('be.enabled');
  });
});
