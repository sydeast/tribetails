/**
 * #2366: THE WAY BACK FROM STRIPE. Stripe sends the household to the success
 * address only when the checkout finished, so the marker on it says "they
 * paid at Stripe". It does NOT say the bill is paid: `stripeWebhook` decides
 * that, and it can land seconds after the household is back. So the marker
 * starts a check, never a paid claim. The cancel address is the bare invoice
 * page, which reads the bill exactly as it stands.
 *
 * #2400: this lives in one module because every Pay button has to send the
 * same two addresses. The invoices list built its own, without the marker, so
 * a household who paid from a list row came back to a live Pay button while
 * the payment was still landing.
 */
export const CHECKOUT_RETURN_PARAM = 'checkout';
export const CHECKOUT_RETURN_VALUE = 'done';
/** How often the bill is read again while a payment is being checked. */
export const PAYMENT_CHECK_EVERY_MS = 3_000;
/** How long the check runs before the screen stops waiting and says so. */
export const PAYMENT_CHECK_FOR_MS = 60_000;

/** `payInvoice`'s `details.code` when a finished payment is not on the invoice yet (#2437). */
export const PAYMENT_BEING_RECORDED_CODE = 'payment_being_recorded';
/** The server's sentence for it, used only when the refusal arrives with no words of its own. */
export const PAYMENT_BEING_RECORDED = 'A payment on this invoice is still being recorded. Check again in a minute.';

/**
 * #2437: THE SERVER REFUSED TO OPEN A CHECKOUT BECAUSE A PAYMENT ON THIS
 * INVOICE HAS FINISHED AT STRIPE AND IS NOT RECORDED YET. Returns the server's
 * sentence for it, or null for any other failure.
 *
 * This is the same state the check after a return from Stripe is for, reached
 * by a household that did not come back through Stripe's own address: a second
 * window, a reload, or a return by hand. So both screens answer it the same
 * way: no Pay, the sentence where Pay was, and the bill read again until the
 * payment shows.
 *
 * Read off `details.code`, with the sentence itself as the fallback, because a
 * callable error that crosses a proxy can lose `details` and keep its message.
 */
export function paymentBeingRecorded(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const details = (err as { details?: unknown }).details;
  const code = typeof details === 'object' && details !== null ? (details as { code?: unknown }).code : undefined;
  const raw = (err as { message?: unknown }).message;
  const message = typeof raw === 'string' ? raw : '';
  if (code === PAYMENT_BEING_RECORDED_CODE) return message || PAYMENT_BEING_RECORDED;
  return message.includes(PAYMENT_BEING_RECORDED) ? PAYMENT_BEING_RECORDED : null;
}

function invoicePath(invoiceId: string, finished: boolean): string {
  const page = `/invoices/${encodeURIComponent(invoiceId)}`;
  return finished ? `${page}?${CHECKOUT_RETURN_PARAM}=${CHECKOUT_RETURN_VALUE}` : page;
}

/** The two Stripe return addresses for this invoice, on this origin. */
export function checkoutReturnUrls(origin: string, invoiceId: string): { successUrl: string; cancelUrl: string } {
  return { successUrl: `${origin}${invoicePath(invoiceId, true)}`, cancelUrl: `${origin}${invoicePath(invoiceId, false)}` };
}

/** True when this page was opened by Stripe's success address. Exactly `checkout=done`, nothing looser. */
export function cameBackFromCheckout(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(CHECKOUT_RETURN_PARAM) === CHECKOUT_RETURN_VALUE;
}

/** Drops the marker from the address bar, so a reload or a shared link does not start another check. */
export function dropCheckoutMarker(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has(CHECKOUT_RETURN_PARAM)) return;
  params.delete(CHECKOUT_RETURN_PARAM);
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
}

/**
 * #2401: THE WAY BACK TO THE MYTRIBE APP. A household who pays from the app
 * leaves it for the phone's browser, and Stripe returns them to
 * `/app/invoices/{id}` on this site (see `InvoicesController.kt`). The app
 * claims that address, so the phone normally opens the app on the invoice. When
 * the browser keeps the page instead, `AppCheckoutReturn` shows it, and its
 * button uses the app's own link below, which needs no verification.
 */
export function appInvoiceLink(invoiceId: string, finished: boolean): string {
  const link = `mytribe://invoices/${encodeURIComponent(invoiceId)}`;
  return finished ? `${link}?${CHECKOUT_RETURN_PARAM}=${CHECKOUT_RETURN_VALUE}` : link;
}

/**
 * The same invoice on this site, for a household who would sooner read it
 * here. It keeps the marker when Stripe sent one, so the invoice page checks
 * the payment and holds Pay back exactly as it does for a checkout started on
 * the web.
 */
export function webInvoiceHref(invoiceId: string, finished: boolean): string {
  return invoicePath(invoiceId, finished);
}
