import { ADMIN } from '../../e2e/fixtures/accounts';
import { usingFixtureAdmin } from '../support/commands';
import { vendorConfigured } from '../support/e2e-real';

/**
 * The operator's profile photo on `/account`, uploaded to the REAL Cloudinary
 * test account (#1195, the real-services counterpart of
 * `cypress/e2e/account-photo.cy.ts`).
 *
 * The PR-time spec answers both the signer and Cloudinary with stubs and hands
 * the avatar a `data:` URI. Here the file really goes to Cloudinary, the
 * returned `secure_url` is what the app writes to `users/{uid}.photoUrl`, and
 * the reload proves the screen reads that write back and the image loads from
 * Cloudinary's CDN.
 *
 * NOTHING IS ANSWERED HERE. The sign request goes to the admin's real
 * `signCloudinaryUpload` (#1201): the dev server proxies
 * `/api/cloudinary/sign-upload` to the admin functions codebase, which this run
 * serves beside `mytribe/functions`. Under the run's `demo-` project id that
 * signer prefixes the folder it validated with `e2e/` (#1202), so the upload
 * lands in `e2e/tribetails/user/<uid>/`. A URL under that folder is itself the
 * proof the real signer answered: the client asks for `tribetails/user/<uid>`
 * and only the signer adds the prefix.
 *
 * The refused-upload case (a 500 from Cloudinary) needs a vendor that can be
 * told to fail, so it stays in the PR-time spec only.
 *
 * SKIPS, naming the variables, when the run has no Cloudinary credentials. The
 * uploaded asset is destroyed in `after` (the task refuses anything outside
 * `e2e/`), and the run's own cleanup empties `e2e/` too.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** UPLOAD covers a real sign (cold start included), a real Cloudinary upload and two Firestore writes. */
const BUDGET_MS = { RENDER: 15_000, UPLOAD: 30_000 } as const;

const AVATAR_IMG = '.account__hero .den-heading-leading img';

/** `https://res.cloudinary.com/<cloud>/image/upload/v123/e2e/tribetails/user/<uid>/abc.png` -> `e2e/tribetails/user/<uid>/abc`. */
function publicIdOf(url: string): string {
  const match = /\/upload\/(?:v\d+\/)?(e2e\/.+?)(?:\.[a-z0-9]+)?$/i.exec(url);
  if (!match) throw new Error(`not an e2e/ Cloudinary URL: ${url}`);
  return match[1]!;
}

let uploadedPublicId: string | null = null;

describe('account photo (real Cloudinary upload)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    if (!vendorConfigured('cloudinary')) {
      cy.log(
        'SKIPPED: no Cloudinary credentials in this run (E2E_CLOUDINARY_CLOUD_NAME, E2E_CLOUDINARY_API_KEY, E2E_CLOUDINARY_API_SECRET)',
      );
      this.skip();
    }
  });

  after(() => {
    if (uploadedPublicId === null) return;
    cy.task('cloudinaryDestroy', { publicId: uploadedPublicId });
    cy.task<string>('authUid', { email: ADMIN.email }).then((uid) => {
      cy.task('upsertDoc', { collection: 'users', id: uid, doc: { photoUrl: null } });
    });
  });

  it('uploads a picked image to Cloudinary, shows it, and it loads from Cloudinary after a reload', () => {
    cy.signIn();
    cy.visit('/account');
    cy.get('.account__fields', { timeout: BUDGET_MS.RENDER }).should('exist');

    let t0 = 0;
    cy.get('input[aria-label="Change photo"]')
      .selectFile(
        { contents: Cypress.Buffer.from(PNG_BASE64, 'base64'), fileName: 'me.png', mimeType: 'image/png' },
        { force: true }, // the input is visually hidden behind its button
      )
      .then(() => {
        t0 = Date.now();
      });

    cy.get(AVATAR_IMG, { timeout: BUDGET_MS.UPLOAD })
      .should('have.attr', 'src')
      .and('match', /^https:\/\/res\.cloudinary\.com\/.+\/e2e\/tribetails\/user\/[^/]+\//);
    cy.then(() => {
      expect(Date.now() - t0, 'ms from picking the file to the avatar showing the upload').to.be.lessThan(
        BUDGET_MS.UPLOAD,
      );
    });
    cy.get(AVATAR_IMG)
      .invoke('attr', 'src')
      .then((src) => {
        uploadedPublicId = publicIdOf(String(src));
      });

    // The write, not the state: the reload re-reads `users/{uid}`, and the
    // image must actually load from Cloudinary (Avatar falls back to initials
    // when it does not, which removes the <img>).
    cy.reload();
    cy.get('.account__fields', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get(AVATAR_IMG, { timeout: BUDGET_MS.RENDER })
      .should('have.attr', 'src')
      .and('match', /\/e2e\/tribetails\/user\/[^/]+\//);
    cy.get(AVATAR_IMG).should(($img) => {
      expect(($img[0] as HTMLImageElement).naturalWidth, 'the image loaded from Cloudinary').to.be.greaterThan(0);
    });
  });
});
