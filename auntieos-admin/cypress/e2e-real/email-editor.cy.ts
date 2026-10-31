import { usingFixtureAdmin } from '../support/commands';

/**
 * The visual email editor (#953) on the Template Bank against the REAL
 * `listTemplates`, `listCategories`, `getBusinessNotificationOverrides`,
 * `previewEmailTemplate`, `saveTemplate` and `convertTemplateToVisual`
 * (#1195, the real-services counterpart of `cypress/e2e/email-editor.cy.ts`).
 *
 * The PR-time spec stubs all six and checks the shape of what the save sent
 * (a visual save carries no `body` and no `html`). Here every template is an
 * `emailTemplates/{id}` document, the preview is the server's render, and
 * each save is read back through `listTemplates` after a reload:
 *
 *   - the "Old format" badge is the server's reading of a stored document
 *     (no `format`), not of a fixture;
 *   - a new visual template, formatted and with a button, is listed after a
 *     reload, opens in the visual editor with its headline, and keeps its
 *     bold text and its button;
 *   - the preview is the server's render of the stored headline;
 *   - Convert, compare and save turns an old template visual for good; Convert
 *     then Leave keeps it old for good.
 *
 * The button links to a web address rather than a merge field: merge fields
 * come from the notification catalog for the template's own key, and these
 * stamped ids are in no catalog. Every id is stamped per run, filtered to
 * with the search box, and removed in `after`.
 */

const STAMP = Date.now().toString(36);

/** RENDER includes the cold start of `listTemplates`. PREVIEW and SAVE are one real call each. */
const BUDGET_MS = { RENDER: 15_000, PREVIEW: 15_000, SAVE: 10_000 } as const;

const NEW_ID = `e2e.real.welcome.${STAMP}`;
const VISUAL = {
  id: `e2e.real.visual.${STAMP}`,
  title: `Visual reminder ${STAMP}`,
  subject: `Your visit ${STAMP}`,
  headline: `See you soon ${STAMP}`,
  content: '<p>Hi {{kinfolkName}}, a reminder about tomorrow.</p>',
};
const OLD = {
  id: `e2e.real.old.${STAMP}`,
  title: `Old reminder ${STAMP}`,
  subject: `Reminder ${STAMP}: your visit is tomorrow`,
  body: 'Hi {{kinfolkName}}, a reminder about tomorrow.',
};
const OLD_KEPT = {
  id: `e2e.real.oldkept.${STAMP}`,
  title: `Old kept ${STAMP}`,
  subject: `Kept ${STAMP}: your visit is tomorrow`,
  body: 'Hi {{kinfolkName}}, see you tomorrow.',
};

/** The headline the old frame's header carries, which the converter lifts out. */
const OLD_HEADLINE = 'Visit reminder';

/**
 * An old-format row in the seeds' shared frame: a `.header` with its `<h2>`
 * and a `.content` box. That frame is what `convertLegacyTemplate` reads; a
 * bare `<p>` is answered "unreadable". The picture is not on Cloudinary, so the
 * server drops it and says so, which is the warning the compare view shows.
 */
function legacyHtml(body: string): string {
  return [
    `<div class="header"><h2>${OLD_HEADLINE}</h2></div>`,
    `<div class="content"><p>${body}</p><img src="https://tribetails.com/visit-photo.png" alt="the visit photo"></div>`,
  ].join('');
}

function seedOld(t: typeof OLD) {
  cy.task('upsertDoc', {
    collection: 'emailTemplates',
    id: t.id,
    doc: {
      subject: t.subject,
      body: t.body,
      html: legacyHtml(t.body),
      title: t.title,
      tags: [],
      sectionDefinitions: [],
      usageInstructions: '',
    },
  });
}

/** The bank, filtered to this run's templates once the real list is in. */
function openTemplates() {
  cy.signIn();
  cy.visit('/templates');
  cy.get('.templates__card', { timeout: BUDGET_MS.RENDER }).should('have.length.at.least', 1);
  cy.get('input[aria-label="Search templates by title or key"]').clear().type(STAMP);
}

function card(title: string) {
  return cy.contains('.templates__card', title, { timeout: BUDGET_MS.RENDER });
}

function editCard(title: string) {
  card(title).within(() => cy.contains('button', 'Edit').click());
  cy.get('.template-editor', { timeout: BUDGET_MS.RENDER }).should('exist');
}

/** The preview is in once the server's render has replaced the loading state. */
function previewSettled() {
  cy.get('section[aria-label="Preview"]', { timeout: BUDGET_MS.PREVIEW }).should('have.attr', 'aria-busy', 'false');
  return cy.get('iframe[title="The email as it will be sent"]', { timeout: BUDGET_MS.PREVIEW }).should(
    'have.attr',
    'srcdoc',
  );
}

function saveAndClose() {
  let t0 = 0;
  cy.contains('button', 'Save template')
    .should('not.be.disabled')
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
}

describe('email editor (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    seedOld(OLD);
    seedOld(OLD_KEPT);
    cy.task('upsertDoc', {
      collection: 'emailTemplates',
      id: VISUAL.id,
      doc: {
        subject: VISUAL.subject,
        title: VISUAL.title,
        format: 'visual',
        headline: VISUAL.headline,
        content: VISUAL.content,
        tags: [],
        sectionDefinitions: [],
        usageInstructions: '',
      },
    });
  });

  after(() => {
    for (const id of [NEW_ID, VISUAL.id, OLD.id, OLD_KEPT.id]) cy.task('deleteDoc', { collection: 'emailTemplates', id });
  });

  it('badges only the stored old-format template', () => {
    openTemplates();
    card(OLD.title).should('contain.text', 'Old format');
    card(VISUAL.title).should('not.contain.text', 'Old format');
  });

  it('creates a visual template with bold text and a button, and it comes back that way after a reload', () => {
    const headline = `Welcome aboard ${STAMP}`;
    openTemplates();
    cy.contains('button', 'New template').click();

    cy.get('#template-editor-id').type(NEW_ID);
    cy.get('#template-editor-subject').type(`Welcome ${STAMP}`);
    cy.get('#template-editor-headline').type(headline);
    cy.get('[aria-label="Email content"]').click().type('Glad to have you here');
    cy.get('[aria-label="Email content"]').type('{selectall}');
    cy.get('button[aria-label="Bold"]').click();
    cy.get('[aria-label="Email content"] strong').should('contain.text', 'Glad to have you here');

    cy.get('[aria-label="Email content"]').type('{moveToEnd}');
    cy.get('button[aria-label="Button"]').click();
    cy.get('[role="dialog"]').contains('label', 'Button text').find('input').type('Get started');
    cy.get('[role="dialog"]').contains('label', 'A web address').find('input[type="radio"]').check();
    cy.get('[role="dialog"]').contains('label', 'Address').find('input').type('https://tribetails.com');
    cy.get('[role="dialog"]').contains('button', 'Done').click();
    cy.get('[aria-label="Email content"] a.button').should('have.text', 'Get started');

    // The server's render of what is in the editor.
    previewSettled().and('contain', headline);
    saveAndClose();

    cy.reload();
    cy.get('input[aria-label="Search templates by title or key"]', { timeout: BUDGET_MS.RENDER }).type(NEW_ID);
    cy.get('.templates__card', { timeout: BUDGET_MS.RENDER })
      .should('have.length', 1)
      .and('not.contain.text', 'Old format')
      .within(() => cy.contains('button', 'Edit').click());
    cy.get('#template-editor-headline', { timeout: BUDGET_MS.RENDER }).should('have.value', headline);
    cy.get('#template-editor-body').should('not.exist');
    cy.get('[aria-label="Email content"] strong').should('contain.text', 'Glad to have you here');
    cy.get('[aria-label="Email content"] a.button')
      .should('have.text', 'Get started')
      .and('have.attr', 'href')
      .and('match', /^https:\/\/tribetails\.com\/?$/);
  });

  it('edits a stored visual template: the preview is the server render, and the added line is there after a reload', () => {
    const added = `Added line ${STAMP}`;
    openTemplates();
    editCard(VISUAL.title);
    cy.get('#template-editor-headline').should('have.value', VISUAL.headline);
    cy.get('[aria-label="Email content"] .merge-chip').should('contain.text', '{{kinfolkName}}');
    previewSettled().and('contain', VISUAL.headline);

    cy.get('[aria-label="Email content"]').click().type(`{moveToEnd}{enter}${added}`);
    saveAndClose();

    cy.reload();
    cy.get('input[aria-label="Search templates by title or key"]', { timeout: BUDGET_MS.RENDER }).type(STAMP);
    editCard(VISUAL.title);
    cy.get('[aria-label="Email content"]', { timeout: BUDGET_MS.RENDER }).should('contain.text', added);
  });

  it('converts an old template through convertTemplateToVisual and saves it: it is visual for good', () => {
    openTemplates();
    editCard(OLD.title);
    cy.get('#template-editor-body').should('have.value', OLD.body);
    cy.contains('button', 'Convert').click();

    // The compare view, from the server's conversion. Save is off mid-compare.
    cy.get('iframe[title="The old email"]', { timeout: BUDGET_MS.PREVIEW })
      .should('have.attr', 'srcdoc')
      .and('contain', 'a reminder about tomorrow');
    cy.get('section[aria-label="Converted email"]').should('exist');
    // The server dropped the off-Cloudinary picture and said so.
    cy.contains('.convert-compare__warnings', 'Removed an image').should('exist');
    cy.contains('button', 'Save template').should('be.disabled');

    cy.contains('button', 'Use the converted version').click();
    cy.get('#template-editor-body').should('not.exist');
    cy.get('#template-editor-headline').should('have.value', OLD_HEADLINE);
    cy.contains('Not carried over:').should('exist');
    saveAndClose();

    cy.reload();
    cy.get('input[aria-label="Search templates by title or key"]', { timeout: BUDGET_MS.RENDER }).type(STAMP);
    card(OLD.title).should('not.contain.text', 'Old format');
    editCard(OLD.title);
    cy.get('#template-editor-body').should('not.exist');
    cy.get('#template-editor-headline').should('have.value', OLD_HEADLINE);
    cy.get('[aria-label="Email content"]').should('contain.text', 'a reminder about tomorrow');
  });

  it('leaving after Convert without saving keeps the template old, read back after a reload', () => {
    openTemplates();
    editCard(OLD_KEPT.title);
    cy.contains('button', 'Convert').click();
    cy.contains('button', 'Use the converted version', { timeout: BUDGET_MS.PREVIEW }).click();

    cy.contains('.template-editor button', 'Cancel').click();
    cy.get('[role="dialog"]').should('contain.text', 'Leave without saving?');
    cy.contains('[role="dialog"] button', 'Leave').click();
    cy.get('.template-editor').should('not.exist');

    cy.reload();
    cy.get('input[aria-label="Search templates by title or key"]', { timeout: BUDGET_MS.RENDER }).type(STAMP);
    card(OLD_KEPT.title).should('contain.text', 'Old format');
  });
});
