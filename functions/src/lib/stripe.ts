import Stripe from 'stripe';

let stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is required');
  stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return stripe;
}

export function verifyStripeWebhook(rawBody: Buffer, signatureHeader: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
}

export { getStripe };
