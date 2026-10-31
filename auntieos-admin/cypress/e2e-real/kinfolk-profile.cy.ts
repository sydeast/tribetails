import { usingFixtureAdmin } from '../support/commands';

/**
 * The household profile (`/directory/{kinfolkId}`), the callable-backed half,
 * against the REAL `getAccountCreditHistory`, `listUnappliedPayments`,
 * `giveAccountCredit`, `listEmergencyContacts` and `saveEmergencyContacts`
 * (#1195, the real-services counterpart of `cypress/e2e/kinfolk-profile.cy.ts`).
 *
 * The PR-time spec stubs the account-credit reads with an empty history and
 * the emergency-contact save with a canned answer, and asserts the payload the
 * Edit form sent. Here each claim is the server's state read back through a
 * reload:
 *
 *   - #678 #682: the right column's order holds with the real credit reads
 *     behind the Account credit card, and the card shows the server's balance;
 *   - Give credit: a credit given through the dialog is listed by
 *     `getAccountCreditHistory` after a reload, with its reason, and the
 *     balance on the card rose by exactly that amount;
 *   - #829 / Q2: an emergency contact saved through the household's Edit form
 *     is on the profile's Emergency Contacts panel after a reload.
 *
 * The PR-time spec's other tests (#676, #679, #680, #681, #683, #685, #689,
 * #677) stub nothing and are not repeated. `mapboxSearch` was stubbed there
 * only because that spec types a service address; this one never touches the
 * address field, so no address lookup should be made. Until #1226 lands, the
 * Edit form looks the stored address up on open in a dev build (StrictMode
 * runs the field's effect twice), `mapboxSearch` fails under the placeholder
 * token, and the #829 test fails on that error line. That failure is the
 * defect, not this spec.
 *
 * Phone numbers are in the 555-01xx range reserved for fiction, in an area
 * code that is neither the business line's nor the private line's.
 */

const STAMP = Date.now().toString(36);
const CREDIT_REASON = `E2E goodwill ${STAMP}`;
const CREDIT_DOLLARS = 7;
const HOUSEHOLD = { phone: '2125550147', address: '123 Meadow Lane, Solvang, CA 93463' } as const;
const EC = { name: `Priya Shah ${STAMP}`, phone: '2125550199', relationship: 'Sister' } as const;

/** RENDER covers the cold start of the credit and contact reads. WRITE is one real save plus the re-read. */
const BUDGET_MS = { RENDER: 15_000, WRITE: 15_000 } as const;

/** "$12.34 on account" -> 1234. */
function centsOf(detail: string): number {
  const match = /\$([\d,]+)\.(\d{2}) on account/.exec(detail);
  if (!match) throw new Error(`no balance in "${detail}"`);
  return Number(match[1]!.replace(/,/g, '')) * 100 + Number(match[2]);
}

function creditPanel() {
  return cy.contains('.den-panel', 'Account credit', { timeout: BUDGET_MS.RENDER });
}

/** The card's detail line, once `getAccountCreditHistory` has answered (it only renders then). */
function balanceCents() {
  return creditPanel()
    .contains(/on account/, { timeout: BUDGET_MS.RENDER })
    .invoke('text')
    .then((text) => centsOf(text));
}

describe('kinfolk profile (real callables)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
  });

  after(() => {
    cy.task('upsertDoc', {
      collection: 'kinfolk',
      id: 'e2e-kf-1',
      doc: { emergencyContacts: [], phoneNumber: '', serviceAddress: '' },
    });
  });

  it('#678 #682 keeps the right column order with the real credit reads, and the card shows the server balance', () => {
    cy.signIn();
    cy.visit('/directory/e2e-kf-1');
    cy.get('.kprofile__cols .kprofile__col', { timeout: BUDGET_MS.RENDER })
      .eq(1)
      .find('.den-panel-title')
      .then(($titles) => {
        expect([...$titles].map((el) => el.textContent)).to.deep.equal([
          'Kin',
          'Upcoming KinCare',
          'Recent KinTales',
          'Invoices',
          'Account credit',
        ]);
      });
    creditPanel().contains('Loading account credit…').should('not.exist');
    creditPanel().contains('Could not load account credit').should('not.exist');
    balanceCents().should('be.at.least', 0);
  });

  it('gives a credit through giveAccountCredit: listed with its reason after a reload, and the balance rose by its amount', () => {
    cy.signIn();
    cy.visit('/directory/e2e-kf-1');
    balanceCents().then((before) => {
      creditPanel().contains('button', 'Give credit').click();
      cy.get('[role="dialog"]').within(() => {
        cy.get('[aria-label="Credit amount in dollars"]').type(String(CREDIT_DOLLARS));
        cy.get('[aria-label="Reason for the credit"]').type(CREDIT_REASON);
        cy.contains('button', 'Review').click();
        cy.contains('button', 'Give credit').click();
      });
      cy.get('[role="dialog"]', { timeout: BUDGET_MS.WRITE }).should('not.exist');
      creditPanel().find('.acredit__notice[role="status"]', { timeout: BUDGET_MS.WRITE }).should('exist');

      // The ledger, read back through the server after a reload.
      cy.reload();
      creditPanel()
        .contains('.acredit__row', CREDIT_REASON, { timeout: BUDGET_MS.RENDER })
        .find('.acredit__amount')
        .should('have.text', `$${CREDIT_DOLLARS}.00`);
      balanceCents().should('eq', before + CREDIT_DOLLARS * 100);
    });
  });

  it('#829 saves an emergency contact through the Edit form, and the profile lists it after a reload', () => {
    // The Edit form refuses to save a household with no phone or service
    // address, and the seed carries neither. They go in as stored facts, so
    // the form has nothing of its own to change and the only write is the
    // contact. Nothing is typed into the address field.
    cy.task('upsertDoc', {
      collection: 'kinfolk',
      id: 'e2e-kf-1',
      doc: { phoneNumber: HOUSEHOLD.phone, serviceAddress: HOUSEHOLD.address },
    });
    cy.signIn();
    cy.visit('/directory/e2e-kf-1');
    cy.contains('.den-panel', 'Emergency Contacts', { timeout: BUDGET_MS.RENDER }).should(
      'not.contain.text',
      EC.name,
    );
    cy.contains('button', 'Edit').click();
    cy.get('#kfedit-ec-0-name', { timeout: BUDGET_MS.RENDER }).should('exist');
    cy.get('#kfedit-ec-0-name').clear().type(EC.name);
    cy.get('#kfedit-ec-0-phone').clear().type(EC.phone);
    cy.get('#kfedit-ec-0-relationship').clear().type(EC.relationship);

    let t0 = 0;
    cy.contains('button', 'Save changes')
      .click()
      .then(() => {
        t0 = Date.now();
      });
    // Back on the read-only profile: a refused save leaves the form up.
    cy.get('.kprofile__hero', { timeout: BUDGET_MS.WRITE }).should('exist');
    cy.then(() => {
      expect(Date.now() - t0, 'ms from Save changes to the profile').to.be.lessThan(BUDGET_MS.WRITE);
    });

    cy.reload();
    cy.contains('.den-panel', 'Emergency Contacts', { timeout: BUDGET_MS.RENDER }).within(() => {
      cy.get('[data-testid="ec-name"]').should('contain.text', EC.name);
      cy.contains('.kprofile__fact-value', /555.?0199/).should('exist');
      cy.contains('.kprofile__fact-value', EC.relationship).should('exist');
    });
  });
});
