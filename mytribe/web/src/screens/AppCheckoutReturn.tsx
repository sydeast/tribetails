import { useParams } from '@tanstack/react-router';
import { appInvoiceLink, cameBackFromCheckout, webInvoiceHref } from '../lib/checkoutReturn';

/**
 * #2401: WHERE STRIPE SENDS A HOUSEHOLD WHO PAID FROM THE MYTRIBE APP, when
 * the browser keeps the page.
 *
 * The app hands its card checkout to the phone's browser. Stripe used to send
 * that browser back to this site's own invoice page, which needs a web sign-in
 * a household who lives in the app has usually never done in that browser. So
 * the first thing they saw after paying was the sign-in screen, with nothing
 * about their payment and nothing pointing back to the app.
 *
 * The app now sends `/app/invoices/{id}` and claims that address, so the phone
 * normally opens the app on the invoice and this page is never drawn. It is
 * drawn when the browser does not hand the address over, and on a computer,
 * where the MyTribe app for desktop sends the same address and has no link to
 * be opened by.
 *
 * NO SIGN-IN AND NO READS, ON PURPOSE. This page knows only what the address
 * says: which invoice, and whether Stripe finished the checkout. It never says
 * the invoice is paid, because the address cannot know that. The app checks
 * the bill itself once the household is back in it.
 *
 * The button is shown on Android only. That is the one place a `mytribe://`
 * link has anything to open; anywhere else it would be a button that does
 * nothing.
 */
export function AppCheckoutReturn() {
  const { invoiceId } = useParams({ from: '/app/invoices/$invoiceId' });
  // Stripe's success address carries the marker and its cancel address does not.
  const finished = cameBackFromCheckout();
  const onAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  return (
    <>
      <nav className="nav" aria-label="MyTribe">
        <div className="in">
          <div className="wordmark">
            My<span className="grad">Tribe</span>
          </div>
        </div>
      </nav>
      <div className="wrap">
        <main className="glass card" data-testid="app-checkout-return" style={{ marginTop: 40, textAlign: 'center' }}>
          <div className="sectlabel">Card payment</div>
          <h1>{finished ? 'Your payment was sent.' : 'Checkout was closed.'}</h1>
          <p className="sub" style={{ margin: '12px auto 20px', maxWidth: '44ch' }}>
            {finished
              ? 'Go back to MyTribe to see your invoice. It can take a moment to show as paid.'
              : 'Go back to MyTribe to see your invoice.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {onAndroid && (
              <a className="btn grad" href={appInvoiceLink(invoiceId, finished)}>
                Open MyTribe
              </a>
            )}
            <a className="btn ghost" href={webInvoiceHref(invoiceId, finished)}>
              See this invoice here
            </a>
          </div>
        </main>
      </div>
    </>
  );
}
