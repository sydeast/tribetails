import { KINFOLK } from '../fixtures/accounts';
import { openInvoiceDoc } from '../fixtures/realInvoice';
import { vendorConfigured } from '../support/e2e-real';

/**
 * A kinfolk pays an invoice by card (#1194, operator ruling D3: paying an
 * invoice is tested in the portal suite, since kinfolk pay there).
 *
 * WHAT IS REAL. The Pay button calls the real `payInvoice`, which asks Stripe
 * (test mode) for a Checkout Session; the browser leaves for Stripe's hosted
 * checkout page, which shows that invoice and its amount; Stripe takes a test
 * card payment for that session; Stripe sends its own signed
 * `checkout.session.completed` and `payment_intent.succeeded`; and
 * `stripe listen` (started by `run.sh`) forwards them to the emulator's real
 * `stripeWebhook`, which checks the signature and settles the invoice.
 *
 * WHAT IS NOT EXERCISED, AND WHY (#2304). The spec does not type a card into
 * Stripe's form, and Stripe does not send the browser back to the invoice.
 * Since 2026-11-14 Stripe serves the session at `/g/pay/` with its form in a
 * frame (`elements-inner-habanero`), and for an automated browser
 * (`navigator.webdriver` true) that frame stays 2 px tall for the whole
 * budget: no field and no button anywhere on the page. That was so in
 * Electron 146 (run 43629608013) and in Chrome 157 (run 43632254872), with no
 * console error and nothing blocked. The page still draws the business, the
 * invoice line and the amount, and the spec asserts those.
 *
 * SO THE CARD GOES IN THROUGH THE STRIPE CLI. The spec reads the session id
 * off Stripe's page address and hands it to the `stripeConfirmCheckout` task,
 * which runs `stripe fixtures` with the three requests the CLI's own
 * `stripe trigger checkout.session.completed` uses (open the payment page,
 * make a payment method from the test token `tok_visa`, confirm with the
 * expected amount), against the session `payInvoice` made. The endpoint,
 * `/v1/payment_pages`, is the one Stripe's CLI uses and is not in Stripe's
 * public API reference: if Stripe changes it the task fails with Stripe's
 * answer, and this spec goes red. `scripts/e2e-real/stripe-confirm.mjs` has
 * the detail. The task never builds or signs an event and never calls
 * `stripeWebhook`. If Stripe's form draws for Cypress again, typing the card
 * there is the better test; PR #1273 has that version of this spec.
 *
 * WHAT IS PROVED, FROM THE UI ONLY (2026-09-01 ruling): the invoice that read
 * PENDING with a balance reads PAID after a reload, with no balance and no way
 * to pay left. The PAID chip is the server's verdict: `getMyInvoices` reads the
 * status `stripeWebhook` wrote. Nothing here reads Firestore or the log.
 *
 * THE WEBHOOK LANDS AFTER THE PAYMENT, not with it. Stripe answers the
 * confirm and fires the events at about the same moment, and each event then
 * queues behind the emulator's triggers. So the spec reloads on a bounded loop
 * until the chip turns, and fails with the last chip it saw.
 *
 * SKIPS, WITH THE MISSING VARIABLE NAMED, when the run has no Stripe test keys
 * or no webhook forwarder (which also means no Stripe CLI). Absent keys are
 * never a pass and never a red run.
 *
 * STRIPE'S PAGE NEEDS `experimentalModifyObstructiveThirdPartyCode` (#1269) to
 * draw even the part the spec reads; `cypress.real.config.ts` has the
 * measurement. The test keys live only in the `e2e-real` GitHub environment,
 * whose branch policy is main, so the spec runs against Stripe only on a
 * dispatch from main.
 */

const STAMP = Date.now().toString(36);
const INVOICE_ID = `e2e-real-pay-${STAMP}`;
const TOTAL = 42;
/** [TOTAL] as Stripe's page prints it and as Stripe counts it. */
const TOTAL_ON_STRIPE = '$42.00';
const TOTAL_CENTS = 4200;

/**
 * CHECKOUT is Stripe's hosted page loading and showing the invoice. CONFIRM is
 * the Stripe CLI's three requests (the task itself gives the CLI 60 s).
 * WEBHOOK is the event reaching the emulator and the invoice turning paid,
 * which a household in production also waits seconds for.
 */
const BUDGET_MS = { RENDER: 20_000, CHECKOUT: 60_000, CONFIRM: 90_000, WEBHOOK: 60_000 } as const;
const RELOAD_EVERY_MS = 3_000;

/** Reloads until the status chip reads PAID or the budget runs out. */
function reloadUntilPaid(deadline: number): void {
  cy.get('.doc-status .chip', { timeout: BUDGET_MS.RENDER })
    .invoke('text')
    .then((chip) => {
      if (chip === 'PAID') return;
      if (Date.now() > deadline) {
        throw new Error(
          `the invoice still reads ${chip} ${BUDGET_MS.WEBHOOK} ms after Stripe took the test payment. ` +
            'The payment went through at Stripe; the webhook did not settle it. Read cypress/.real/stripe-listen.log and emulators.log.',
        );
      }
      cy.wait(RELOAD_EVERY_MS);
      cy.reload();
      reloadUntilPaid(deadline);
    });
}

describe('paying an invoice by card (real payInvoice, Stripe test mode, real webhook)', () => {
  before(function () {
    if (!vendorConfigured('stripe')) {
      cy.log('SKIPPED: no Stripe test keys in this run (STRIPE_TEST_SECRET_KEY, STRIPE_TEST_PUBLISHABLE_KEY)');
      this.skip();
    }
    if (!vendorConfigured('stripeWebhook')) {
      cy.log(
        'SKIPPED: no Stripe webhook forwarder in this run (STRIPE_TEST_WEBHOOK_SECRET; run.sh sets it from `stripe listen`, which needs the Stripe CLI on PATH)',
      );
      this.skip();
    }
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

  it('#1194 pays a pending invoice through Stripe checkout and reads paid after the webhook lands', () => {
    cy.signInReal();
    cy.visit(`/invoices/${INVOICE_ID}`);
    cy.get('.doc-status .chip', { timeout: BUDGET_MS.RENDER }).should('have.text', 'PENDING');

    cy.contains('button', 'Pay with Credit Card').click();

    // Stripe's hosted page, on Stripe's origin. Everything inside this block
    // runs there; nothing from this file's scope crosses except `args`, and
    // the one thing that comes back is the session id from the page address.
    cy.origin<{ invoiceId: string; amount: string; budget: number }, string>(
      'https://checkout.stripe.com',
      { args: { invoiceId: INVOICE_ID, amount: TOTAL_ON_STRIPE, budget: BUDGET_MS.CHECKOUT } },
      ({ invoiceId, amount, budget }) => {
        // Stripe's own scripts on this page throw while it loads (#1275,
        // run 41268330873). The browser hides another origin's exception
        // behind the bare message "Script error.", and Cypress fails the test
        // on any uncaught exception. Only that opaque line is ignored, and
        // only here: a handler registered inside cy.origin runs on Stripe's
        // origin alone, so the portal keeps the default. An error with a real
        // message still fails, and the payment still has to land and read
        // PAID below.
        let opaqueScriptErrors = 0;
        Cypress.on('uncaught:exception', (err) => {
          if (!/(^|\n)\s*(>\s*)?Script error\.\s*(\n|$)/.test(err.message)) return undefined;
          opaqueScriptErrors += 1;
          return false;
        });

        // What the page held, for the failure message only (#2304): the path
        // without the session id, how many fields, the frames by name and
        // size, the browser as the page saw it, and the first visible words.
        const pageFacts = (doc: Document): string => {
          const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
          const frames = Array.from(doc.querySelectorAll('iframe')).map((frame) => {
            const box = frame.getBoundingClientRect();
            const file = (frame.getAttribute('src') ?? '').replace(/[?#].*$/, '').split('/').pop() ?? '';
            return `${clip(file, 40)}|${Math.round(box.width)}x${Math.round(box.height)}`;
          });
          const path = (doc.location?.pathname ?? '').split('/').slice(0, 3).join('/');
          const view = doc.defaultView;
          const browser = view === null ? 'unknown' : `${view.navigator.userAgent}, webdriver ${String(view.navigator.webdriver)}`;
          const words = clip((doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim(), 300);
          return [
            `path ${path}`,
            `${doc.querySelectorAll('input, select, button').length} fields`,
            `${frames.length} frames [${clip(frames.join(', '), 600)}]`,
            `opaque script errors let through: ${opaqueScriptErrors}`,
            `browser ${browser}`,
            `visible text: "${words}"`,
          ].join('; ');
        };

        // ARRIVE FIRST, THEN LOOK (run 43628182398). The Pay click returns
        // before `payInvoice` answers, so this callback starts while the
        // browser is still on the portal. `cy.get()` checks the page's origin
        // inside its retry loop and so waits for Stripe's page;
        // `cy.document()` checks it once, when it starts. So `body` is the
        // wait for arrival, and the look at the document comes after it. Both
        // share the one budget.
        const deadline = Date.now() + budget;
        cy.get('body', { timeout: budget });
        // THE SESSION STRIPE SHOWS IS THIS INVOICE'S. `payInvoice` names the
        // line "Invoice #<id>" and prices it from the invoice, and the id is
        // unique to this run, so these two strings on Stripe's page mean the
        // session about to be paid is the one this Pay click made, for the
        // amount the household owes.
        cy.then(() => {
          cy.document({ timeout: Math.max(deadline - Date.now(), 1_000) }).should((doc) => {
            const text = (doc.body?.innerText ?? '').replace(/\s+/g, ' ');
            if (!text.includes(`Invoice #${invoiceId}`) || !text.includes(amount)) {
              throw new Error(`Stripe's checkout page does not show "Invoice #${invoiceId}" and ${amount}. ${pageFacts(doc)}`);
            }
          });
        });
        // The session id is the last part of the page address. It goes to the
        // task below and nowhere else: it is not logged or asserted on here.
        return cy.location('pathname', { log: false }).then((pathname) => pathname.split('/').pop() ?? '');
      },
    ).then((sessionId) => {
      // Back to the invoice BEFORE the payment. Stripe's redirect to
      // `payInvoice`'s success URL is not exercised (the header says why), so
      // the spec opens the page itself. It does so first because Stripe's
      // page throws opaque script errors while it sits open, and the handler
      // that lets those through lives inside the cy.origin block above: the
      // browser must not be left on Stripe's page while the CLI works.
      cy.visit(`/invoices/${INVOICE_ID}`);
      cy.get('.doc-status .chip', { timeout: BUDGET_MS.RENDER }).should('have.text', 'PENDING');

      // Stripe takes the test card for that session (see the header: the
      // hosted form does not draw for Cypress). The task refuses anything but
      // a test key and a `cs_test_` session, and fails with Stripe's answer if
      // a step is refused. `log: false` keeps the session id out of the
      // command log.
      cy.task(
        'stripeConfirmCheckout',
        { sessionId, amountCents: TOTAL_CENTS, email: KINFOLK.email, name: KINFOLK.displayName },
        { log: false, timeout: BUDGET_MS.CONFIRM },
      );
    });

    cy.then(() => reloadUntilPaid(Date.now() + BUDGET_MS.WEBHOOK));

    // Settled: no balance, and no way to pay left (docket Q5, a paid invoice
    // takes no payment).
    cy.get('.doc-status .chip').should('have.text', 'PAID');
    cy.get('.totals .row.due').should('not.exist');
    cy.contains('button', 'Pay with Credit Card').should('not.exist');
  });
});
