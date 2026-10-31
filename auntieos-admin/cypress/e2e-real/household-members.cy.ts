import { usingFixtureAdmin } from '../support/commands';

/**
 * Household members (`/household-members/{kinfolkId}`) against the REAL
 * `listMembers`, `listInvites`, `listSecondaryKinfolk`, `saveSecondaryKinfolk`
 * and `removeSecondaryKinfolk` (#1195, the real-services counterpart of
 * `cypress/e2e/household-members.cy.ts`).
 *
 * The PR-time spec stubs all five with empty or hand-written lists, so it
 * proves the screen's structure (#684, #829) and the payload the Add dialog
 * sends (Q3/Q4). Here the screen gets past its loading state on the real
 * reads, and the Add and Remove round trips are proved by what the server
 * lists afterwards, through a reload:
 *
 *   - #684 / #829: with real reads behind it, the typed-email form and the
 *     contacts list are still gone and the portal invite holds the primary slot;
 *   - Q3/Q4: a secondary kinfolk added through the dialog is listed by the
 *     server after a reload, with no portal access and no invite control, and
 *     Remove takes it off the server's list.
 *
 * The phone uses the 555-01xx range reserved for fiction, in an area code that
 * is neither the business line's nor the private line's. No email is typed,
 * because the suite may only use the three real test inboxes and this test
 * has no reason to.
 */

const STAMP = Date.now().toString(36);
const PERSON = `Jo Park ${STAMP}`;
const PHONE = '2125550147';

/** RENDER covers the cold start of the three list callables. WRITE is one save or remove plus the re-list. */
const BUDGET_MS = { RENDER: 12_000, WRITE: 10_000 } as const;

function openMembers() {
  cy.signIn();
  cy.visit('/household-members/e2e-kf-1');
  cy.contains('.den-panel-title', 'Primary contact', { timeout: BUDGET_MS.RENDER }).should('exist');
  // The secondary list has answered (its loading row is gone), so what follows
  // reads the server's list, not a placeholder.
  cy.get('[data-testid="secondary-kinfolk"]', { timeout: BUDGET_MS.RENDER })
    .contains('Loading', { matchCase: false })
    .should('not.exist');
}

describe('household members (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  it('#684 #829 has no typed-email invite form and no contacts list, and the portal invite holds the primary slot', () => {
    openMembers();
    cy.contains('.den-heading button', 'Invite to portal')
      .should('be.enabled')
      .and('have.class', 'auntie-btn--primary');
    cy.contains('Invite a primary by email').should('not.exist');
    cy.contains('button', 'Add secondary contact').should('not.exist');
    cy.get('.hmembers__addrow').should('not.exist');
    cy.get('#hmcontact-name').should('not.exist');
  });

  it('Q3/Q4 adds a secondary kinfolk through saveSecondaryKinfolk, lists it after a reload, and removes it', () => {
    openMembers();
    cy.contains('.den-panel-title', 'Secondary kinfolk').should('exist');
    cy.contains('[data-testid="secondary-kinfolk-row"]', PERSON).should('not.exist');

    cy.contains('button', 'Add secondary kinfolk').click();
    cy.get('#skin-name').type(PERSON);
    cy.get('#skin-phone').type(PHONE);
    let t0 = 0;
    cy.contains('[role="dialog"] button', 'Save')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    cy.get('[role="dialog"]', { timeout: BUDGET_MS.WRITE }).should('not.exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Save to the dialog closing on the server answer').to.be.lessThan(BUDGET_MS.WRITE);
    });

    // Read back from the server, not the dialog's local state.
    cy.reload();
    cy.contains('[data-testid="secondary-kinfolk-row"]', PERSON, { timeout: BUDGET_MS.RENDER }).within(() => {
      cy.contains('No portal access').should('exist');
      cy.get('.skin__contact').invoke('text').should('match', /555.?0147/);
    });
    // Only their primary can invite them (Q3): no invite control on the list.
    cy.get('[data-testid="secondary-kinfolk"]').contains('button', /invite/i).should('not.exist');

    cy.contains('[data-testid="secondary-kinfolk-row"]', PERSON).contains('button', 'Remove').click();
    cy.get('[role="dialog"]').should('contain.text', `Remove ${PERSON}?`);
    cy.contains('[role="dialog"] button', 'Remove').click();
    cy.get('[role="dialog"]', { timeout: BUDGET_MS.WRITE }).should('not.exist');

    cy.reload();
    cy.contains('.den-panel-title', 'Secondary kinfolk', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.contains('button', 'Add secondary kinfolk', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.contains('[data-testid="secondary-kinfolk-row"]', PERSON).should('not.exist');
  });
});
