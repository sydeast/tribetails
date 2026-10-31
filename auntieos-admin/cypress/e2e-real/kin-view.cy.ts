import { usingFixtureAdmin } from '../support/commands';

/**
 * The kin (pet) detail screen's tags (#686), with the functions emulator
 * running every trigger behind the write (#1195, the real-services counterpart
 * of `cypress/e2e/kin-view.cy.ts`).
 *
 * The PR-time spec intercepts the Firestore WebChannel only to WAIT for the
 * tag write to be acknowledged before it re-opens the pet. Nothing else in it
 * is stubbed, so its other tests are not repeated here. What that spec cannot
 * prove is that the tag survives the server side: the flat `kin/{id}` write
 * fires `onFlatKinWrite` (the reverse mirror into the household's own kin
 * record) here, and a trigger that rewrote the document would take the tag
 * with it. So the claim is read back from a fresh page load:
 *
 *   - a tag added through Edit tags is on the pet after a full reload, read
 *     straight from Firestore by `getKin`;
 *   - removed through the same control, it is gone after a full reload, so the
 *     fixture is left as `e2e/seed.ts` wrote it.
 *
 * No intercept: the wait for the write is the screen's own re-read inside the
 * running app (Back, then open the pet again), which never tears the page
 * down mid-write the way a `cy.visit` would.
 */

const STAMP = Date.now().toString(36);
const TAG = `Cuddly ${STAMP}`;
const KIN_NAME = 'h1.den-heading-title';
const KIN_LOAD = { timeout: 15_000 } as const;

/** Opens KinView from the Directory's Kin tab, by the pet's name. */
function openKinFromDirectory(petName: string) {
  cy.visit('/directory');
  cy.get('.directory__tab', KIN_LOAD).eq(1).click(); // Kinfolk, Kin
  cy.contains('.directory__card', petName, KIN_LOAD).click();
  cy.get(KIN_NAME, KIN_LOAD).should('have.text', petName);
}

/** Leaves the pet and opens it again without a page load: a fresh `getKin` in the same app. */
function reopenInApp(petName: string) {
  cy.contains('button', /^Back/).click();
  cy.get('.directory__tab', KIN_LOAD).eq(1).click();
  cy.contains('.directory__card', petName, KIN_LOAD).click();
  cy.get(KIN_NAME, KIN_LOAD).should('have.text', petName);
}

describe('kin view tags (real triggers)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  after(() => {
    cy.task('upsertDoc', { collection: 'kin', id: 'vis-kin-1', doc: { tags: [] } });
  });

  it('#686 a pet tag survives the server side: on the pet after a full reload, and gone after removal', () => {
    cy.signIn();
    openKinFromDirectory('Biscuit');
    cy.contains('.den-heading-badges .den-statuspill', TAG).should('not.exist');

    cy.contains('button', 'Edit tags', KIN_LOAD).click();
    cy.get('[aria-label="Add a pet tag"]').type(`${TAG}{enter}`);
    cy.contains('.tag-chip__name', TAG).should('exist');
    cy.contains('button', 'Done').click();
    cy.contains('.den-panel-title', 'Tags').should('not.exist');

    reopenInApp('Biscuit');
    cy.contains('.den-heading-badges .den-statuspill', TAG, KIN_LOAD).should('exist');

    // A full page load: no SDK cache, no pending write, only what the server holds.
    openKinFromDirectory('Biscuit');
    cy.contains('.den-heading-badges .den-statuspill', TAG, KIN_LOAD).should('exist');

    cy.contains('button', 'Edit tags').click();
    cy.get(`[aria-label="Remove ${TAG} tag"]`).click();
    cy.contains('.tag-chip__name', TAG).should('not.exist');
    cy.contains('button', 'Done').click();

    reopenInApp('Biscuit');
    cy.contains('.den-heading-badges .den-statuspill', TAG).should('not.exist');
    openKinFromDirectory('Biscuit');
    // Edit tags renders once `getKin` has answered, so the absence below is read off the record.
    cy.contains('button', 'Edit tags', KIN_LOAD).should('exist');
    cy.contains('.den-heading-badges .den-statuspill', TAG).should('not.exist');
  });
});
