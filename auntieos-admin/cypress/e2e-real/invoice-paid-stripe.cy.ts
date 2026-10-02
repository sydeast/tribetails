import { usingFixtureAdmin } from '../support/commands';
import { serverLogStartOffset, vendorConfigured } from '../support/e2e-real';

/**
 * Recording a payment on an invoice that still has an open Stripe checkout
 * (#1089 phase 1, the pattern for a Stripe test-mode path from the admin).
 *
 * WHY THIS PATH. The admin has no control that calls Stripe and shows Stripe's
 * answer. Its one Stripe path is indirect: Record payment calls
 * `markInvoicePaid`, the invoice becomes paid, and the
 * `onInvoicePaidExpireCheckouts` trigger asks Stripe to expire every checkout
 * session still open on it (docket Q5, a paid invoice takes no payment). So the
 * spec mints a real TEST-MODE session first, the way `payInvoice` does when a
 * household opens the pay page and leaves it, and records the payment through
 * the real screen.
 *
 * WHAT IS PROVED FROM THE UI: the real callable settled the invoice. The notice
 * is the server's own verdict, and after a reload the invoice is paid and offers
 * no further collection action.
 *
 * WHAT THE UI CANNOT SHOW, and how the run sees it anyway. The trigger runs
 * after the screen has its answer and writes nothing any admin screen renders.
 * So the test waits for the trigger's own log line naming this session as
 * `expired`, which is Stripe accepting the call. If Stripe refused, the trigger
 * logs at `error` instead, and the support file's server check fails the test
 * (D3-e: our integration breaking stops the release). That log read is the one
 * departure from "assert from the UI only", made because no screen exists to
 * assert on; it is flagged in the PR for the operator.
 *
 * SKIPS, WITH THE REASON IN THE LOG, when the run has no Stripe test keys.
 * Absent keys are never a pass and never a red run.
 */

const STAMP = Date.now().toString(36);
const INVOICE_ID = `e2e-real-inv-${STAMP}`;
const TOTAL = 42;

const BUDGET_MS = { RENDER: 10_000, RECORD: 15_000, SWEEP: 30_000 } as const;

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('invoice payment closes the open Stripe checkout (real callable, Stripe test mode)', () => {
  before(function () {
    if (!usingFixtureAdmin()) this.skip();
    if (!vendorConfigured('stripe')) {
      cy.log('SKIPPED: no Stripe test keys in this run (STRIPE_TEST_SECRET_KEY, STRIPE_TEST_PUBLISHABLE_KEY)');
      this.skip();
    }
  });

  after(() => {
    cy.task('deleteDoc', { collection: 'invoices', id: INVOICE_ID });
  });

  it('#1089 records a payment through markInvoicePaid and Stripe expires the checkout left open on it', () => {
    cy.task<string>('stripeTestCheckoutSession', { invoiceId: INVOICE_ID, amountCents: TOTAL * 100 }).then(
      (sessionId) => {
        cy.task('upsertDoc', {
          collection: 'invoices',
          id: INVOICE_ID,
          doc: {
            kinfolkId: 'e2e-kf-1',
            kinfolkName: 'Wanda Thorne',
            client: 'Wanda Thorne',
            invoiceNumber: `AO-E2E-${STAMP}`,
            date: today(),
            dueDate: today(),
            total: TOTAL,
            amountDue: TOTAL,
            status: 'open',
            editScope: 'all',
            sessionIds: [],
            lineItems: [{ description: 'Drop-in visit', qty: 1, unitCents: TOTAL * 100 }],
            openCheckoutSessionIds: [sessionId],
            createdAt: new Date().toISOString(),
          },
          timestampFields: ['createdAt'],
        });

        cy.signIn();
        cy.visit(`/invoices?invoiceId=${INVOICE_ID}`);
        cy.contains('button', 'Record payment', { timeout: BUDGET_MS.RENDER }).click();
        // No email in this spec: the confirmation is the email vendor's path, not Stripe's.
        cy.contains('label', 'Send a confirmation email').find('input[type="checkbox"]').uncheck();

        let t0 = 0;
        cy.get('.invoice-detail__confirm-actions')
          .contains('button', 'Record payment')
          .click()
          .then(() => {
            t0 = Date.now();
          });
        cy.contains('Payment recorded. The invoice is paid in full.', { timeout: BUDGET_MS.RECORD }).should(
          'exist',
        );
        cy.then(() => {
          expect(Date.now() - t0, 'ms from Record payment to the server verdict on screen').to.be.lessThan(
            BUDGET_MS.RECORD,
          );
        });

        // Stripe's answer, which only the trigger's log carries (see header).
        cy.then(() =>
          cy.task(
            'serverLogWaitFor',
            {
              since: serverLogStartOffset(),
              pattern: `stripe\\.checkout\\.sweep\\.done.*"${sessionId}":"expired"`,
              timeoutMs: BUDGET_MS.SWEEP,
            },
            { timeout: BUDGET_MS.SWEEP + 5_000 },
          ),
        );

        // Persistence, through a reload: paid, and nothing left to collect.
        cy.reload();
        cy.contains(`No collection actions for a paid invoice.`, { timeout: BUDGET_MS.RENDER }).should('exist');
        cy.contains('button', 'Record payment').should('not.exist');
      },
    );
  });
});
