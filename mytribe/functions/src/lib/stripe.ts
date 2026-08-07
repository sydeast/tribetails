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
  // Stays `await import`, NOT an in-function `require`: a bare require escapes
  // Vitest's module graph and loads the real SDK straight past the
  // `vi.mock('stripe')` in test/stripe.test.ts (the same trap documented at
  // length in src/lib/googleOAuth.ts).
  //
  // Under `module: nodenext` tsc no longer downlevels this to
  // `Promise.resolve().then(() => require(...))`; it emits a real ESM import, so
  // Node now takes stripe's `import` condition: cjs/stripe.cjs.node.js becomes
  // esm/stripe.esm.node.js. Verified by construction, not by inspection — that
  // build instantiates and still exposes `webhooks.constructEvent`. The test
  // suite cannot cover this, since `vi.mock('stripe')` means the real SDK is
  // never loaded in test. The cast is what reconciles the two —
  // the `import type` above resolves require-mode under nodenext and
  // import-mode under the bundler config the tests use, and TS treats those two
  // declarations as distinct nominal types even though the call signature is
  // identical. Naming the signature is the one spelling that satisfies both.
  const { default: StripeSdk } = (await import('stripe')) as unknown as {
    default: new (key: string) => Stripe;
  };
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
