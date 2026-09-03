import { usingFixtureAdmin } from '../support/commands';
import { takeConsoleErrors } from '../support/e2e';

/**
 * The operator's profile photo on `/account`: pick a file, it lands on the
 * avatar, and it is still there after a reload.
 *
 * THE TRANSPORT IS INTERCEPTED, THE PERSISTENCE IS NOT. The upload goes
 * sign (`/api/cloudinary/sign-upload`, a hosting rewrite the vite dev server
 * does not have) then Cloudinary (an external host). Neither exists on the
 * emulator, so both are answered by `cy.intercept`, by operator ruling on
 * 2026-09-01. The `media_files` doc and the `users/{uid}.photoUrl` write are
 * real Firestore writes through the real rules, and the reload at the end is
 * what proves them: the screen re-reads `users/{uid}` on mount.
 *
 * THE FAKE URL IS A `data:` URI ON PURPOSE. `Avatar` swaps to initials when
 * its image fails to load, so a made-up https URL would make the `<img>`
 * vanish and fail this test on a healthy app. A data URI loads everywhere.
 *
 * EMULATOR RUNS ONLY. Against a deployed host the intercepts still fire, so the
 * real Firestore write would put that `data:` URI into the real e2e admin's
 * profile and add a `media_files` row pointing at a Cloudinary asset that does
 * not exist. The file skips itself under the deployed-host overrides
 * (docs/runbooks/e2e.md, "Pointing a Cypress run at a deployed host").
 */

/** A 1x1 transparent PNG. `fixturesFolder` is off, so the bytes live here. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

const STAMP = Date.now().toString(36);
/** Unique per run so a reload cannot be satisfied by a previous run's photo. */
const PUBLIC_ID = `tribetails/user/e2e/photo-${STAMP}`;

describe('account photo', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  afterEach(() => {
    expect(takeConsoleErrors(), 'unexpected console.error lines').to.deep.equal([]);
  });

  it('uploads a picked image, shows it, and it survives a reload', () => {
    cy.intercept('POST', '**/api/cloudinary/sign-upload', (req) => {
      req.reply({
        statusCode: 200,
        body: {
          cloudName: 'e2e-cloud',
          apiKey: 'e2e-key',
          timestamp: 1,
          signature: 'e2e-sig',
          folder: req.body.folder,
          entityType: req.body.entityType,
        },
      });
    }).as('sign');
    cy.intercept('POST', 'https://api.cloudinary.com/v1_1/e2e-cloud/auto/upload', {
      statusCode: 200,
      body: {
        secure_url: PNG_DATA_URI,
        public_id: PUBLIC_ID,
        resource_type: 'image',
        format: 'png',
        bytes: 68,
        width: 1,
        height: 1,
      },
    }).as('cloudinary');

    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: 6_000 }).should('exist');

    cy.get('input[aria-label="Change photo"]').selectFile(
      { contents: Cypress.Buffer.from(PNG_BASE64, 'base64'), fileName: 'me.png', mimeType: 'image/png' },
      { force: true }, // the input is visually hidden behind its button
    );

    // The sign request is the contract with the server: the operator's own
    // uid as the entity, under the USER folder, the same as Android sends.
    cy.wait('@sign').then(({ request }) => {
      const body = request.body as { entityType: string; entityId: string; folder: string };
      expect(body.entityType).to.eq('USER');
      expect(body.folder).to.eq(`tribetails/user/${body.entityId}`);
      expect(body.entityId).to.have.length.greaterThan(0);
    });
    cy.wait('@cloudinary');

    cy.get('.account__identity img', { timeout: 6_000 }).should('have.attr', 'src', PNG_DATA_URI);

    // The write, not the state. A screen that showed the returned URL and
    // never saved it would pass everything above.
    cy.reload();
    cy.get('.account__fields', { timeout: 6_000 }).should('exist');
    cy.get('.account__identity img').should('have.attr', 'src', PNG_DATA_URI);
  });

  it('keeps the current photo and says why when Cloudinary refuses', () => {
    cy.intercept('POST', '**/api/cloudinary/sign-upload', {
      statusCode: 200,
      body: { cloudName: 'e2e-cloud', apiKey: 'k', timestamp: 1, signature: 's', folder: 'x', entityType: 'USER' },
    });
    cy.intercept('POST', 'https://api.cloudinary.com/v1_1/e2e-cloud/auto/upload', {
      statusCode: 500,
      body: { error: { message: 'e2e: refused on purpose' } },
    }).as('cloudinary');

    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: 6_000 }).should('exist');
    // Whatever the avatar is right now: an <img> if an earlier test or run
    // uploaded one, the initials fallback on a fresh seed. Captured as markup
    // so "unchanged" holds for either, and this test does not depend on the
    // upload test having run first.
    cy.get('.account__identity')
      .find('img, [role="img"]')
      .first()
      .invoke('prop', 'outerHTML')
      .then((before) => {
        cy.get('input[aria-label="Change photo"]').selectFile(
          { contents: Cypress.Buffer.from(PNG_BASE64, 'base64'), fileName: 'me.png', mimeType: 'image/png' },
          { force: true },
        );
        cy.wait('@cloudinary');
        // The server's own reason reaches the operator, not a generic line:
        // `uploadToCloudinary` lifts `error.message` off the response body.
        cy.get('.account__identity [role="alert"]').should('contain.text', 'e2e: refused on purpose');
        cy.get('.account__identity').find('img, [role="img"]').first().invoke('prop', 'outerHTML').should('eq', before);
        cy.reload();
        cy.get('.account__fields', { timeout: 6_000 }).should('exist');
        cy.get('.account__identity').find('img, [role="img"]').first().invoke('prop', 'outerHTML').should('eq', before);
      });
  });
});
