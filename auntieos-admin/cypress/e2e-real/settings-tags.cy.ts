import { usingFixtureAdmin } from '../support/commands';

/**
 * Settings > Tags, removing a household tag through the REAL `removeBusinessTag`
 * (#1089 phase 1, the pattern for a callable with no outside service).
 *
 * The PR-time `cypress/e2e/settings.cy.ts` covers the same screen with the
 * callable answered by `cy.intercept`, so what it proves is the screen's half:
 * the confirm dialog and how a `{ recordsTouched: 1 }` answer is worded. It
 * cannot prove the cascade happened, because nothing ran. This spec runs the
 * handler under the functions emulator and proves the cascade from the UI:
 *
 *   - the count on screen is the server's own count of households it changed;
 *   - after a reload the tag is gone from the Tags list, which is the
 *     `business_settings.householdTags` write;
 *   - the Directory's tag filter no longer offers it, and that list is built
 *     from the households' own `tags` (`tagFilterOptions` in Directory.tsx), so
 *     it is the `kinfolk/{id}.tags` write.
 *
 * The tag name is stamped per run, so the spec survives `cypress open`
 * re-runs against a database the seed did not just wipe.
 */

const STAMP = Date.now().toString(36);
const TAG_NAME = `E2E Real ${STAMP}`;

/**
 * Budgets, in ms, from `Date.now()` around the command chain. REMOVE covers a
 * real callable round trip that may include the emulator's cold start of the
 * function on its first call in the run, which a stub never paid.
 */
const BUDGET_MS = { RENDER: 10_000, REMOVE: 12_000 } as const;

function openTags() {
  cy.visit('/settings');
  cy.contains('[role="tab"]', 'Tags', { timeout: BUDGET_MS.RENDER }).click();
}

describe('settings tags (real callable)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  beforeEach(() => {
    cy.task('upsertDoc', {
      collection: 'business_settings',
      id: 'business_settings',
      doc: {
        householdTags: [{ name: TAG_NAME, color: { token: 'teal', css: '#0f766e' }, icon: '🏷️' }],
      },
    });
    cy.task('upsertDoc', { collection: 'kinfolk', id: 'e2e-kf-1', doc: { tags: [TAG_NAME] } });
  });

  after(() => {
    cy.task('upsertDoc', { collection: 'business_settings', id: 'business_settings', doc: { householdTags: [] } });
    cy.task('upsertDoc', { collection: 'kinfolk', id: 'e2e-kf-1', doc: { tags: [] } });
  });

  it('#1089 removes a household tag from the list and from the household it was on, through removeBusinessTag', () => {
    cy.signIn();

    // Precondition, from the UI: the household really carries the tag, so its
    // absence at the end is the callable's doing and not a seed that never had it.
    cy.visit('/directory');
    cy.get('[aria-label="Filter kinfolk by tag"]', { timeout: BUDGET_MS.RENDER })
      .find('option')
      .should('contain.text', TAG_NAME);

    openTags();
    cy.contains('.tagsEditor__row', TAG_NAME, { timeout: BUDGET_MS.RENDER })
      .contains('button', 'Remove')
      .click();
    cy.contains(`Remove "${TAG_NAME}"?`).should('exist');

    let t0 = 0;
    cy.contains('button', 'Remove everywhere')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    cy.contains('Tag removed', { timeout: BUDGET_MS.REMOVE }).should('exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Remove everywhere to the server answer on screen').to.be.lessThan(
        BUDGET_MS.REMOVE,
      );
    });
    // The server's count, not the screen's guess: exactly the one seeded household.
    cy.contains('It came off 1 household.').should('exist');

    // Persistence, read back through a reload rather than from local state.
    // This spec set the household list to the one tag, so an empty list is
    // the exact expected state, and its hint only renders once the read is in.
    cy.reload();
    cy.contains('[role="tab"]', 'Tags', { timeout: BUDGET_MS.RENDER }).click();
    cy.contains('.tagsEditor__hint', 'No household tags yet', { timeout: BUDGET_MS.RENDER }).should('exist');

    // The filter only renders while some household carries a tag, so wait for
    // the directory's rows (the stream is in) and then read whatever is there.
    cy.visit('/directory');
    cy.contains('.directory__card', 'Wanda Thorne', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('body').then(($body) => {
      const offered = $body.find('[aria-label="Filter kinfolk by tag"] option').text();
      expect(offered, 'tags the Directory filter offers').not.to.contain(TAG_NAME);
    });
  });
});
