import { KINFOLK } from '../fixtures/accounts';
import { openInvoiceDoc } from '../fixtures/realInvoice';
import { vendorConfigured } from '../support/e2e-real';

/**
 * A kinfolk pays an invoice by card (#1194, operator ruling D3: paying an
 * invoice is tested in the portal suite, since kinfolk pay there).
 *
 * THE WHOLE PATH IS REAL. The Pay button calls the real `payInvoice`, which
 * asks Stripe (test mode) for a Checkout Session; the browser leaves for
 * Stripe's hosted checkout page, where the spec pays with Stripe's test card;
 * Stripe sends the household back to the invoice; and `stripe listen`
 * (started by `run.sh`) forwards the completed-payment event to the emulator's
 * real `stripeWebhook`, which settles the invoice.
 *
 * WHAT IS PROVED, FROM THE UI ONLY (2026-09-01 ruling): the invoice that read
 * PENDING with a balance reads PAID after a reload, with no balance and no way
 * to pay left. The PAID chip is the server's verdict: `getMyInvoices` reads the
 * status `stripeWebhook` wrote. Nothing here reads Firestore or the log.
 *
 * THE WEBHOOK LANDS AFTER THE REDIRECT, not before it. Stripe sends the
 * browser back and fires the event at about the same moment, and the event
 * then queues behind the emulator's triggers. So the spec reloads on a bounded
 * loop until the chip turns, and fails with the last chip it saw.
 *
 * SKIPS, WITH THE MISSING VARIABLE NAMED, when the run has no Stripe test keys
 * or no webhook forwarder. Absent keys are never a pass and never a red run.
 *
 * STRIPE'S PAGE NEEDS `experimentalModifyObstructiveThirdPartyCode` (#1269).
 * The first run against Stripe (run 41227390964, 2026-10-31) reached a real
 * test Checkout Session, but inside Cypress's frame the page never got past
 * its loading skeleton and `#email` never appeared. `cypress.real.config.ts`
 * turns the flag on; its comment has the measurement. The test keys live only
 * in the `e2e-real` GitHub environment, whose branch policy is main, so the
 * spec runs against Stripe only on a dispatch from main. The hosted checkout
 * page's field ids (`#cardNumber` and the rest) are Stripe's, not ours; if
 * Stripe changes them this spec fails at the card step, inside `cy.origin`,
 * which names the field.
 *
 * OPEN (#2304): since 2026-11-14 Stripe serves the session at `/g/pay/` and
 * its form never painted inside the Cypress frame, with the flag on. Run
 * 43629608013 printed what the page held: no field or button in the page
 * itself, and five Stripe frames, the form's one (`elements-inner-habanero`)
 * 388 px wide and 2 px tall. That run was Electron 146. The run is now Chrome
 * (`e2e:real:run` in package.json), the one thing changed, and a red wait
 * also says which browser the page saw, what it logged, and which of its
 * requests failed. `cypress.real.config.ts` prints Chrome's own console lines
 * for Stripe's scripts after the run.
 */

const STAMP = Date.now().toString(36);
const INVOICE_ID = `e2e-real-pay-${STAMP}`;
const TOTAL = 42;

/** Stripe's documented always-succeeds test card. Only works with test keys. */
const TEST_CARD = { number: '4242424242424242', expiry: '1234', cvc: '123', zip: '94107' } as const;

/**
 * CHECKOUT is Stripe's hosted page loading and taking the card. WEBHOOK is the
 * event reaching the emulator and the invoice turning paid, which a household
 * in production also waits seconds for.
 */
const BUDGET_MS = { RENDER: 20_000, CHECKOUT: 60_000, WEBHOOK: 60_000 } as const;
const RELOAD_EVERY_MS = 3_000;

/** Reloads until the status chip reads PAID or the budget runs out. */
function reloadUntilPaid(deadline: number): void {
  cy.get('.doc-status .chip', { timeout: BUDGET_MS.RENDER })
    .invoke('text')
    .then((chip) => {
      if (chip === 'PAID') return;
      if (Date.now() > deadline) {
        throw new Error(
          `the invoice still reads ${chip} ${BUDGET_MS.WEBHOOK} ms after Stripe sent the household back. ` +
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
    // runs there; nothing from this file's scope crosses except `args`.
    cy.origin(
      'https://checkout.stripe.com',
      { args: { card: TEST_CARD, email: KINFOLK.email, name: KINFOLK.displayName, budget: BUDGET_MS.CHECKOUT } },
      ({ card, email, name, budget }) => {
        // Stripe's own scripts on this page throw while it loads (#1275,
        // run 41268330873: the page was fully drawn, the last request a POST
        // to r.stripe.com). The browser hides another origin's exception
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

        // What Stripe's page said while it loaded (#2304), for the failure
        // message only. Nothing here can pass or fail the test. `watched`
        // stays false when the page loaded before this hook was in place, so
        // "0 console errors" is never read as "none happened".
        let watched = false;
        const consoleErrorLines: string[] = [];
        const blockedByPolicy: string[] = [];
        Cypress.on('window:before:load', (win) => {
          try {
            const original = win.console.error.bind(win.console);
            win.console.error = (...args: unknown[]) => {
              original(...args);
              if (consoleErrorLines.length < 4) consoleErrorLines.push(args.map((a) => String(a)).join(' ').slice(0, 160));
            };
            win.addEventListener('securitypolicyviolation', (event) => {
              if (blockedByPolicy.length < 4) {
                blockedByPolicy.push(`${event.violatedDirective} ${event.blockedURI.replace(/[?#].*$/, '').slice(0, 80)}`);
              }
            });
            watched = true;
          } catch {
            // A page that refuses the hooks is reported as not watched.
          }
        });

        // A RED RUN HERE SAYS WHAT STRIPE'S PAGE HELD (#2304). Run 43625464056
        // reached a real session at `/g/pay/` (it was `/c/pay/` in October),
        // drew the business and the amount, and left the form half as grey
        // placeholders for the whole budget. "Never found #email" could not
        // tell a renamed field from a form that never painted, and the Stripe
        // keys only exist on a dispatch from main, so every guess costs a
        // merge. The wait is the same one, for the same field and the same
        // budget; only its failure message changed. It carries page facts
        // only: the path without the session id, the fields and frames by
        // name, the first visible words, how many opaque script errors the
        // handler above let through, the browser as the page saw it, and what
        // the page logged, had blocked by its content policy, or was refused.
        const pageFacts = (doc: Document): string => {
          const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
          const fields = Array.from(doc.querySelectorAll('input, select, button')).map((el) => {
            const label = el.id || el.getAttribute('name') || el.getAttribute('aria-label') || clip((el.textContent ?? '').trim(), 24);
            return `${el.tagName.toLowerCase()}:${label}`;
          });
          const frames = Array.from(doc.querySelectorAll('iframe')).map((frame) => {
            const box = frame.getBoundingClientRect();
            const file = (frame.getAttribute('src') ?? '').replace(/[?#].*$/, '').split('/').pop() ?? '';
            return `${frame.getAttribute('name') ?? ''}|${clip(file, 48)}|${Math.round(box.width)}x${Math.round(box.height)}`;
          });
          const path = (doc.location?.pathname ?? '').split('/').slice(0, 3).join('/');
          const view = doc.defaultView;
          const browser = view === null ? 'unknown' : `${view.navigator.userAgent}, webdriver ${String(view.navigator.webdriver)}`;
          // Requests the page made that came back refused. `responseStatus`
          // is 0 for another origin's response without a timing header, so
          // only a real 4xx or 5xx is listed.
          const refused =
            view === null
              ? []
              : (view.performance.getEntriesByType('resource') as PerformanceResourceTiming[])
                  .filter((entry) => entry.responseStatus >= 400)
                  .map((entry) => `${entry.responseStatus} ${entry.name.replace(/[?#].*$/, '').split('/').slice(2).join('/').slice(0, 80)}`);
          const words = clip((doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim(), 300);
          return [
            `path ${path}`,
            `${fields.length} fields [${clip(fields.join(', '), 600)}]`,
            `${frames.length} frames [${clip(frames.join(', '), 900)}]`,
            `opaque script errors let through: ${opaqueScriptErrors}`,
            `browser ${browser}`,
            `page watched from load: ${String(watched)}`,
            `console errors [${consoleErrorLines.join(' | ')}]`,
            `blocked by content policy [${blockedByPolicy.join(' | ')}]`,
            `refused requests [${clip(refused.join(', '), 400)}]`,
            `visible text: "${words}"`,
          ].join('; ');
        };
        // ARRIVE FIRST, THEN LOOK (run 43628182398). The Pay click returns
        // before `payInvoice` answers, so this callback starts while the
        // browser is still on the portal. `cy.get()` checks the page's origin
        // inside its retry loop and so waits for Stripe's page, which is what
        // the old `cy.get('#email')` did. `cy.document()` checks it once, when
        // it starts, and failed the test on the spot with "expected to run
        // against origin". So `body` is the wait for arrival, and the look at
        // the document comes after it. Both share the one budget.
        const deadline = Date.now() + budget;
        cy.get('body', { timeout: budget });
        cy.then(() => {
          cy.document({ timeout: Math.max(deadline - Date.now(), 1_000) }).should((doc) => {
            if (doc.querySelector('#email') === null) {
              throw new Error(`Stripe's checkout page has no #email field. ${pageFacts(doc)}`);
            }
          });
        });
        cy.get('#email').type(email);
        cy.get('#cardNumber').type(card.number);
        cy.get('#cardExpiry').type(card.expiry);
        cy.get('#cardCvc').type(card.cvc);
        cy.get('#billingName').type(name);
        // Asked for only in some countries' layouts; typed when present.
        cy.get('body').then(($body) => {
          if ($body.find('#billingPostalCode').length > 0) cy.get('#billingPostalCode').type(card.zip);
        });
        cy.get('button[type="submit"]').click();
      },
    );

    // Back on the portal: `payInvoice` set the success URL to this invoice.
    cy.location('pathname', { timeout: BUDGET_MS.CHECKOUT }).should('eq', `/invoices/${INVOICE_ID}`);
    cy.then(() => reloadUntilPaid(Date.now() + BUDGET_MS.WEBHOOK));

    // Settled: no balance, and no way to pay left (docket Q5, a paid invoice
    // takes no payment).
    cy.get('.doc-status .chip').should('have.text', 'PAID');
    cy.get('.totals .row.due').should('not.exist');
    cy.contains('button', 'Pay with Credit Card').should('not.exist');
  });
});
