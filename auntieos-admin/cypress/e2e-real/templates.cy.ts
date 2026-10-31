import { usingFixtureAdmin } from '../support/commands';

/**
 * The Template Bank (`/templates`) against the REAL `listTemplates` and
 * `listCategories` (#1195, the real-services counterpart of
 * `cypress/e2e/templates.cy.ts`).
 *
 * The PR-time spec answers both reads with a hand-written row, so what it
 * proves is the frame #716 put back: one primary action, the overflow menu, no
 * stat strip, the "Subject:" prefix and the footer Edit. Here the row is an
 * `emailTemplates/{id}` document and the real handlers read it, so each claim
 * below is made about what the server returned:
 *
 *   - the card the server listed carries the stored subject behind "Subject:";
 *   - the footer Edit opens the editor pre-filled from that document;
 *   - an edit saved through the real `saveTemplate` comes back from
 *     `listTemplates` after a reload, so the write and the read agree;
 *   - the frame (#716) holds with a real list behind it, not only a stub.
 *
 * The template id is stamped per run and the document is removed in `after`,
 * so `email-editor.cy.ts` (which runs before this file) and a re-run under
 * `cypress open` never see it.
 */

const STAMP = Date.now().toString(36);
const TEMPLATE_ID = `e2e.real.templates.${STAMP}`;
const TITLE = `Templates real ${STAMP}`;
const SUBJECT = `Reminder ${STAMP}: your visit is tomorrow`;
const EDITED_SUBJECT = `Edited ${STAMP}: your visit is tomorrow`;

/** RENDER includes the first cold start of `listTemplates` in the run. SAVE is one real `saveTemplate`. */
const BUDGET_MS = { RENDER: 12_000, SAVE: 10_000 } as const;

function openTemplates() {
  cy.signIn();
  cy.visit('/templates');
  cy.contains('.templates__card', TITLE, { timeout: BUDGET_MS.RENDER }).should('exist');
}

describe('templates (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    cy.task('upsertDoc', {
      collection: 'emailTemplates',
      id: TEMPLATE_ID,
      doc: {
        subject: SUBJECT,
        body: 'Hi {{kinfolkName}}, a reminder about tomorrow.',
        title: TITLE,
        tags: [],
        sectionDefinitions: [],
        usageInstructions: '',
      },
    });
  });

  after(() => {
    cy.task('deleteDoc', { collection: 'emailTemplates', id: TEMPLATE_ID });
  });

  it('#716 keeps one primary action and the overflow menu over a real list', () => {
    openTemplates();
    cy.get('.den-heading-trailing').within(() => {
      cy.contains('button', 'New template').should('exist');
      cy.contains('button', 'Manage assignments').should('not.exist');
      cy.get('.templates__overflow-trigger').should('have.attr', 'aria-expanded', 'false').click();
    });
    cy.get('[role="menu"]').within(() => {
      cy.contains('[role="menuitem"]', 'Manage assignments').should('exist');
      cy.contains('[role="menuitem"]', 'Import from repo').should('exist');
      cy.contains('[role="menuitem"]', 'New binding').should('exist');
    });
    cy.focused().type('{esc}');
    cy.get('[role="menu"]').should('not.exist');
    cy.get('.den-stat').should('not.exist');
    cy.get('.templates__controls').within(() => {
      cy.get('[role="tablist"]').should('exist');
      cy.get('.templates__search-input').should('exist');
    });
  });

  it('#716 shows the stored subject and opens the editor from the card footer, pre-filled from the document', () => {
    openTemplates();
    cy.contains('.templates__card', TITLE).within(() => {
      cy.get('.templates__card-subject')
        .invoke('text')
        .should('match', /^Subject:/)
        .and('include', SUBJECT);
      cy.contains('button', 'Edit').click();
    });
    cy.get('.template-editor .den-crumbs [aria-current="page"]', { timeout: BUDGET_MS.RENDER }).should(
      'have.text',
      'Edit template',
    );
    cy.get('.template-editor #template-editor-id').should('have.text', TEMPLATE_ID);
    cy.get('.template-editor #template-editor-subject').should('have.value', SUBJECT);
  });

  it('saves an edited subject through saveTemplate, and listTemplates returns it after a reload', () => {
    openTemplates();
    cy.contains('.templates__card', TITLE).within(() => cy.contains('button', 'Edit').click());
    cy.get('.template-editor #template-editor-subject', { timeout: BUDGET_MS.RENDER })
      .should('have.value', SUBJECT)
      .clear()
      .type(EDITED_SUBJECT);

    let t0 = 0;
    cy.contains('button', 'Save template')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    cy.get('.template-editor', { timeout: BUDGET_MS.SAVE }).should('not.exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Save template to the editor closing on the server answer').to.be.lessThan(
        BUDGET_MS.SAVE,
      );
    });

    // Read back through a reload: the card is built from what listTemplates
    // returned, not from the editor's local state.
    cy.reload();
    cy.contains('.templates__card', TITLE, { timeout: BUDGET_MS.RENDER })
      .find('.templates__card-subject')
      .should('contain.text', EDITED_SUBJECT)
      .and('not.contain.text', SUBJECT);
  });
});
