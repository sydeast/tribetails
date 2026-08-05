import type Stripe from 'stripe';

let stripe: Stripe | null = null;

/**
 * The memoised Stripe client.
 *
 * Two functions in this codebase touch Stripe: `payInvoice` and the
 * `stripeWebhook` endpoint. The SDK is therefore loaded HERE, at first use,
 * rather than at file scope, because the Functions runtime loads all of
 * `index.js` on every cold start whatever the target is, so a file-scope import
 * charged the SDK to the other 225 as well. `import type` above erases at
 * compile time, so the `Stripe.Event` return annotation costs nothing.
 */
async function getStripe(): Promise<Stripe> {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is required');
  const { default: StripeSdk } = await import('stripe');
  // No apiVersion override: the SDK pins the API version it was generated
  // against, and overriding it with an older date now fails the type check.
  stripe = new StripeSdk(key);
  return stripe;
}

export async function verifyStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string,
): Promise<Stripe.Event> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
  const client = await getStripe();
  return client.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

export { getStripe };
