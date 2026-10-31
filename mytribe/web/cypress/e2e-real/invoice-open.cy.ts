import { openInvoiceDoc } from '../fixtures/realInvoice';

/**
 * A kinfolk signs in and opens an invoice they owe, with every callable real
 * (#1194). No outside service, so this runs in every real-services run,
 * including one with no vendor keys at all.
 *
 * WHAT IT PROVES, FROM THE UI ONLY. Sign-in passes the real access chain
 * (`getMyAccess`, `getMyHome`, `setActiveTribe`) on the seeded household, which
 * the PR-time suite only ever stubs. Then the real `getMyInvoices` classifies
 * the spec's invoice as open (the PENDING chip), states its balance, and
 * offers the card checkout, resolved server-side from the business's payment
 * settings. That is the state the Stripe spec starts from, proved without
 * Stripe.
 */

const STAMP = Date.now().toString(36);
const INVOICE_ID = `e2e-real-open-${STAMP}`;
const TOTAL = 37;

describe('an open invoice in the portal (real callables)', () => {
  before(() => {
    cy.task('upsertDoc', {
      path: 'invoices',
      id: INVOICE_ID,
      doc: openInvoiceDoc(STAMP, TOTAL),
      timestampFields: ['createdAt'],
    });
  });

  after(() => {
    cy.task('deleteDoc', { path: 'invoices', id: INVOICE_ID });
  });

  it('#1194 shows the invoice as pending, with its balance and a card checkout', () => {
    cy.signInReal();
    cy.visit(`/invoices/${INVOICE_ID}`);

    cy.get('.doc-status .chip', { timeout: 20_000 }).should('have.text', 'PENDING');
    cy.contains('.totals .row.due', 'Amount Due').should('contain.text', `$${TOTAL}.00`);
    cy.contains('button', 'Pay with Credit Card').should('be.enabled');
  });
});
