/**
 * #1935: a template's text message and push notification, read and saved from
 * the Template Bank editor. Every read and write is a callable, and this
 * harness pins callables at a dead port by design (docs/runbooks/e2e.md), so
 * each one is intercepted. Assertions are on the UI only (operator ruling
 * 2026-09-01).
 */
export {};

const CALLABLE = (name: string) => `**/us-central1/${name}`;
const BUDGET_MS = { RENDER: 6_000 } as const;

const CONFIRM = {
  templateId: 'kincare.booking.confirm',
  subject: 'Your booking is confirmed',
  body: '',
  html: null,
  title: 'Booking confirmed',
  description: null,
  tags: [],
  category: null,
  usageInstructions: '',
  sectionDefinitions: [],
  format: 'visual',
  headline: 'Confirmed',
  content: '<p>Hi {{kinfolkName}}</p>',
};

/** A template the operator made: no notification sends it. */
const OWN = { ...CONFIRM, templateId: 'e2e.my.own', title: 'My own (e2e)' };

const LIMITS = { maxLength: 1600 };
const PUSH_LIMITS = { titleMaxLength: 100, bodyMaxLength: 500 };

function channels(templateId: string) {
  if (templateId === OWN.templateId) {
    return {
      templateId,
      notificationLabel: null,
      fields: [],
      sms: { supported: false, set: false, text: '', ...LIMITS },
      push: { supported: false, set: false, title: '', body: '', ...PUSH_LIMITS },
    };
  }
  return {
    templateId,
    notificationLabel: 'KinCare booking confirmed',
    fields: ['kinName', 'serviceType'],
    sms: { supported: true, set: true, text: 'Booked for {{kinName}}.', ...LIMITS },
    // Sent by this notification, and nobody has written it yet.
    push: { supported: true, set: false, title: '', body: '', ...PUSH_LIMITS },
  };
}

function stub() {
  cy.intercept('POST', CALLABLE('listTemplates'), {
    statusCode: 200,
    body: { result: { templates: [CONFIRM, OWN], nextCursor: null, total: 2 } },
  });
  cy.intercept('POST', CALLABLE('listCategories'), { statusCode: 200, body: { result: { categories: [], schemaVersion: 1 } } });
  cy.intercept('POST', CALLABLE('getBusinessNotificationOverrides'), {
    statusCode: 200,
    body: { result: { catalog: [], overrides: {}, ungated: [] } },
  });
  cy.intercept('POST', CALLABLE('previewEmailTemplate'), {
    statusCode: 200,
    body: { result: { subject: CONFIRM.subject, html: '<html><body></body></html>', text: '', issues: [] } },
  });
  // A deliberate delay, so the loading cue is on screen long enough to see.
  cy.intercept('POST', CALLABLE('getTemplateChannels'), (req) => {
    const { templateId } = req.body.data as { templateId: string };
    req.reply({ statusCode: 200, delay: 600, body: { result: channels(templateId) } });
  }).as('read');
}

function openEditor(title: string) {
  stub();
  cy.signIn();
  cy.visit('/templates');
  cy.get('.templates__card', { timeout: BUDGET_MS.RENDER }).should('have.length', 2);
  cy.contains('.templates__card', title).within(() => cy.contains('button', 'Edit').click());
}

describe('template channels', () => {
  it('reads the text message behind a loading cue, then saves an edit to it alone', () => {
    cy.intercept('POST', CALLABLE('saveTemplateChannels'), (req) => {
      const payload = req.body.data as Record<string, unknown>;
      expect(payload).to.have.property('sms');
      expect(payload).not.to.have.property('push');
      const saved = channels(CONFIRM.templateId);
      saved.sms.text = 'See you soon, {{kinName}}.';
      req.reply({ statusCode: 200, body: { result: saved } });
    }).as('save');
    openEditor(CONFIRM.title);

    cy.get('[role="tab"]').should('have.length', 3);
    cy.contains('[role="tab"]', 'Text message').click();
    cy.get('#template-channel-panel-sms [role="status"]').should('contain.text', 'Loading');
    cy.get('#template-channel-smsText', { timeout: BUDGET_MS.RENDER }).should('have.value', 'Booked for {{kinName}}.');
    cy.contains('h1', 'Text message template').should('exist');

    cy.get('#template-channel-smsText').clear().type('See you soon, ');
    cy.get('#template-channel-panel-sms').contains('button', '{{kinName}}').click();
    cy.get('#template-channel-smsText').type('.');
    cy.contains('button', 'Save text message').click();
    cy.wait('@save').its('request.body.data.sms.text').should('eq', 'See you soon, {{kinName}}.');
    cy.contains('Text message saved.').should('exist');
    cy.get('.template-editor').should('exist');
  });

  it('adds a push notification that was not set, and shows a refusal beside its field', () => {
    cy.intercept('POST', CALLABLE('saveTemplateChannels'), {
      statusCode: 400,
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: '{{nope}} is not a field this notification fills in. You can use {{kinName}}, {{serviceType}}.',
          details: {
            reason: 'template-wording-refused',
            fieldErrors: {
              pushBody: '{{nope}} is not a field this notification fills in. You can use {{kinName}}, {{serviceType}}.',
            },
          },
        },
      },
    }).as('save');
    openEditor(CONFIRM.title);

    cy.contains('[role="tab"]', 'Push notification').click();
    cy.get('[data-testid="template-channel-push-notset"]', { timeout: BUDGET_MS.RENDER }).should('contain.text', 'Not set');
    cy.contains('button', 'Add push notification').click();
    cy.get('#template-channel-pushTitle').type('Booked');
    // '{{}' is how Cypress types one literal brace.
    cy.get('#template-channel-pushBody').type('Hi {{}{{}nope}}');
    cy.contains('button', 'Save push notification').click();
    cy.wait('@save');
    cy.get('#template-channel-pushBody-error').should('contain.text', 'is not a field this notification fills in');
    cy.get('#template-channel-pushBody').should('have.attr', 'aria-invalid', 'true');
    cy.get('#template-channel-pushTitle').should('not.have.attr', 'aria-invalid');
  });

  it('a template no notification sends says so, with nothing to add', () => {
    openEditor(OWN.title);
    cy.contains('[role="tab"]', 'Text message').click();
    cy.get('[data-testid="template-channel-sms-notset"]', { timeout: BUDGET_MS.RENDER })
      .should('contain.text', 'No notification sends this template, so it has no text message.')
      .find('button')
      .should('not.exist');
    cy.contains('[role="tab"]', 'Push notification').click();
    cy.get('[data-testid="template-channel-push-notset"]')
      .should('contain.text', 'No notification sends this template, so it has no push notification.')
      .find('button')
      .should('not.exist');
  });
});
