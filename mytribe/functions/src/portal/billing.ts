import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getStripe } from '../lib/stripe';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPrimary } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';

/**
 * Card management for the portal's Billing Details card (issue #399, item 3).
 *
 * WHY CHECKOUT IN `mode: 'setup'` AND NOT THE STRIPE BILLING PORTAL.
 * The Billing Portal needs a portal configuration created in the Stripe
 * dashboard before `billingPortal.sessions.create` will return anything, and
 * nothing in this repo can create or verify that configuration. A Checkout
 * Session in setup mode needs no dashboard state at all, and it is the same
 * shape `payInvoice` already ships: the server returns a hosted URL and the
 * client hands it to the platform's browser (web: `window.location.href`,
 * android: ACTION_VIEW). One redirect pattern for both money paths.
 *
 * WHY THE HOUSEHOLD'S CARD STATE IS SYNCED, NOT TRUSTED FROM THE CLIENT.
 * `firestore.rules` deliberately keeps `stripeCustomerId` and
 * `stripePaymentMethodId` off the client-writable allowlist on `clients/{uid}`
 * (see the long note in the rules beside that allowlist): `getMyAccount`
 * derives `hasPaymentMethod` from the latter, so a self-assigned value would
 * make a household's own screen report a saved card that Stripe has never
 * heard of. Everything here writes through the Admin SDK after asking Stripe,
 * which is the only party that knows.
 *
 * `syncMyPaymentMethod` is the PRIMARY completion path, not the webhook. The
 * client calls it when the browser comes back from Checkout, so the card
 * appears immediately and the whole flow is testable end to end without a
 * Stripe event ever arriving. `stripeWebhook` still handles the setup session
 * as a backstop for the household that closes the tab on the way back.
 */

/** Fields on `clients/{uid}` this module owns. Written by the Admin SDK only. */
const CUSTOMER_ID_FIELD = 'stripeCustomerId';
const PAYMENT_METHOD_ID_FIELD = 'stripePaymentMethodId';

/** The metadata `stripeWebhook` reads off a setup-mode Checkout Session. */
export const SETUP_SESSION_PURPOSE = 'save-card';

export const CardSchema = z
  .object({
    /** Stripe's card brand, lowercase ('visa', 'mastercard', ...). */
    brand: z.string().min(1),
    last4: z.string().min(1).max(4),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2000).max(2200),
  })
  .strict();

export const PaymentMethodResult = z
  .object({
    /** True when Stripe holds a card this household can be charged on. */
    hasPaymentMethod: z.boolean(),
    /** The card's display details, or null when there is no card on file. */
    card: CardSchema.nullable(),
    /** When the card on file was last added or replaced. */
    updatedAtMs: z.number().int().nullable(),
  })
  .strict();

type PaymentMethodDto = z.infer<typeof PaymentMethodResult>;

// ── Shared authorisation ─────────────────────────────────────────────────────

/**
 * The household whose billing the caller may manage, which is ALWAYS one of
 * their own.
 *
 * This deliberately does NOT go through `resolveKinfolkAccess`. That resolver
 * grants staff a cross-tenant read of any household by design, and every card
 * write in this module lands on `clients/{uid}`, the CALLER's own document.
 * An operator who stepped into a household through the tribe picker would
 * therefore attach a card to their own account while the screen was captioned
 * with the household's name, and `getMyAccount` would start reporting a
 * payment method to an operator who never entered one. `getMyAccount` already
 * returns `impersonated: true` for exactly that state and the portal renders
 * the screen read-only from it; this is the server-side half of the same rule.
 *
 * Billing is PRIMARY-only, the same standing policy `payInvoice` enforces: a
 * secondary member, `billing_full` or not, does not hold the household's card.
 */
async function resolveOwnBillingHousehold(
  uid: string,
  requested: string | undefined,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<{ kinfolkId: string; clientData: Record<string, unknown> }> {
  const snap = await db().collection('clients').doc(uid).get();
  const clientData = (snap.data() ?? {}) as Record<string, unknown>;
  const ownIds = Array.isArray(clientData['kinfolkIds']) ? (clientData['kinfolkIds'] as string[]) : [];
  if (ownIds.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      'This account is not linked to a tribe yet, so there is nothing to bill.',
    );
  }
  if (requested && !ownIds.includes(requested)) {
    throw new HttpsError(
      'permission-denied',
      'Billing can only be managed from the household’s own account.',
    );
  }
  const kinfolkId = requested ?? ownIds[0];
  await requireKinfolkPrimary(uid, kinfolkId, hasAdminClaim, functionName);
  return { kinfolkId, clientData };
}

function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown, functionName: string): z.infer<T> {
  try {
    return schema.parse(data ?? {}) as z.infer<T>;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', `${functionName} validation failed`, {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

/** The stored card fields projected onto the wire DTO. */
function toPaymentMethodDto(data: Record<string, unknown>): PaymentMethodDto {
  const brand = typeof data['stripeCardBrand'] === 'string' ? (data['stripeCardBrand'] as string) : null;
  const last4 = typeof data['stripeCardLast4'] === 'string' ? (data['stripeCardLast4'] as string) : null;
  const expMonth = typeof data['stripeCardExpMonth'] === 'number' ? (data['stripeCardExpMonth'] as number) : null;
  const expYear = typeof data['stripeCardExpYear'] === 'number' ? (data['stripeCardExpYear'] as number) : null;
  const ts = data['stripePaymentMethodUpdatedAt'];
  const hasPaymentMethod = data[PAYMENT_METHOD_ID_FIELD] != null;
  // A card is only DESCRIBED when all four display fields survived the round
  // trip. A half-filled card renders as "•••• undefined" on three clients, so
  // the DTO says "there is a card, we cannot describe it" instead, and the
  // screens fall back to their generic on-file copy.
  const card =
    brand !== null && last4 !== null && expMonth !== null && expYear !== null
      ? { brand, last4, expMonth, expYear }
      : null;
  return {
    hasPaymentMethod,
    card: hasPaymentMethod ? card : null,
    updatedAtMs: ts instanceof Timestamp ? ts.toMillis() : null,
  };
}

// ── getMyPaymentMethod ───────────────────────────────────────────────────────

export const GetMyPaymentMethodArgs = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
});

export async function getMyPaymentMethodHandler(
  req: CallableRequest<unknown>,
): Promise<PaymentMethodDto> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(GetMyPaymentMethodArgs, req.data, 'getMyPaymentMethod');
  const { kinfolkId, clientData } = await resolveOwnBillingHousehold(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'getMyPaymentMethod',
  );
  logEvent({
    severity: 'info',
    function: 'getMyPaymentMethod',
    event: 'portal.billing.card.read',
    uid,
    extra: { kinfolkId, hasPaymentMethod: clientData[PAYMENT_METHOD_ID_FIELD] != null },
  });
  return validateResponse('getMyPaymentMethod', PaymentMethodResult, toPaymentMethodDto(clientData));
}

// ── createBillingSetupSession ────────────────────────────────────────────────

export const CreateBillingSetupSessionArgs = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  successUrl: z.string().url().max(2_000),
  cancelUrl: z.string().url().max(2_000),
});

export const CreateBillingSetupSessionResult = z
  .object({
    /** Stripe-hosted Checkout URL, opened via the platform's browser. */
    checkoutUrl: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

/**
 * Finds or creates the Stripe Customer this account's cards hang off, and
 * remembers its id on `clients/{uid}`.
 *
 * Created lazily rather than at signup: most households pay by Venmo or cash
 * and never open this screen, and a Customer per portal account would be a
 * standing Stripe object for each of them.
 */
async function ensureStripeCustomer(
  uid: string,
  clientData: Record<string, unknown>,
  kinfolkId: string,
): Promise<string> {
  const existing = clientData[CUSTOMER_ID_FIELD];
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const stripe = await getStripe();
  const email = typeof clientData['email'] === 'string' ? (clientData['email'] as string) : undefined;
  const name = typeof clientData['displayName'] === 'string' ? (clientData['displayName'] as string) : undefined;
  const customer = await stripe.customers.create({
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    metadata: { uid, familyId: kinfolkId, kinfolkId, source: 'mytribe-portal' },
  });
  await db().collection('clients').doc(uid).set(
    { [CUSTOMER_ID_FIELD]: customer.id, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return customer.id;
}

export async function createBillingSetupSessionHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof CreateBillingSetupSessionResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(CreateBillingSetupSessionArgs, req.data, 'createBillingSetupSession');
  const { kinfolkId, clientData } = await resolveOwnBillingHousehold(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'createBillingSetupSession',
  );

  const customerId = await ensureStripeCustomer(uid, clientData, kinfolkId);
  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['card'],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    // `stripeWebhook` reads `purpose` to tell this session apart from an
    // invoice payment. It carries no `invoiceId`, which is precisely why the
    // webhook has to recognise it ahead of its metadata gate.
    metadata: { purpose: SETUP_SESSION_PURPOSE, uid, familyId: kinfolkId, kinfolkId, source: 'mytribe-portal' },
  });
  if (!session.url) {
    throw new HttpsError('internal', 'Stripe did not return a checkout link. Try again in a moment.');
  }

  logEvent({
    severity: 'info',
    function: 'createBillingSetupSession',
    event: 'portal.billing.setup.created',
    uid,
    extra: { kinfolkId, sessionId: session.id },
  });
  return validateResponse('createBillingSetupSession', CreateBillingSetupSessionResult, {
    checkoutUrl: session.url,
    sessionId: session.id,
  });
}

// ── syncMyPaymentMethod ──────────────────────────────────────────────────────

export const SyncMyPaymentMethodArgs = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
});

export const SyncMyPaymentMethodResult = z
  .object({
    hasPaymentMethod: z.boolean(),
    card: CardSchema.nullable(),
    updatedAtMs: z.number().int().nullable(),
    /** True when this call changed the stored card. */
    changed: z.boolean(),
  })
  .strict();

/**
 * Asks Stripe what card the household actually has and writes the answer down.
 *
 * Called by the portal the moment the browser returns from Checkout, and safe
 * to call at any other time: it is a read of Stripe followed by an idempotent
 * merge, so a household that never completed the flow simply ends up with the
 * same "no card" state it started in.
 */
export async function syncMyPaymentMethodHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof SyncMyPaymentMethodResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(SyncMyPaymentMethodArgs, req.data, 'syncMyPaymentMethod');
  const { kinfolkId, clientData } = await resolveOwnBillingHousehold(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'syncMyPaymentMethod',
  );

  const customerId = clientData[CUSTOMER_ID_FIELD];
  if (typeof customerId !== 'string' || customerId.length === 0) {
    // Never opened the card flow. Nothing at Stripe to read, and nothing to
    // clear: report the stored state rather than inventing a failure.
    const current = toPaymentMethodDto(clientData);
    return validateResponse('syncMyPaymentMethod', SyncMyPaymentMethodResult, { ...current, changed: false });
  }

  const previousId = typeof clientData[PAYMENT_METHOD_ID_FIELD] === 'string'
    ? (clientData[PAYMENT_METHOD_ID_FIELD] as string)
    : null;
  const synced = await syncStripeCardToClient(uid, customerId, previousId);

  logEvent({
    severity: 'info',
    function: 'syncMyPaymentMethod',
    event: 'portal.billing.card.synced',
    uid,
    extra: { kinfolkId, changed: synced.changed },
  });

  return validateResponse('syncMyPaymentMethod', SyncMyPaymentMethodResult, {
    hasPaymentMethod: synced.hasPaymentMethod,
    card: synced.card,
    // A just-written server timestamp has not resolved yet, so the response
    // reports the moment the write was made rather than re-reading the doc.
    updatedAtMs: synced.hasPaymentMethod ? Date.now() : toPaymentMethodDto(clientData).updatedAtMs,
    changed: synced.changed,
  });
}

export interface StripeCardSyncResult {
  hasPaymentMethod: boolean;
  card: z.infer<typeof CardSchema> | null;
  /** True when the stored payment method id differs from what it was. */
  changed: boolean;
}

/**
 * Reads the customer's cards from Stripe and mirrors the newest onto
 * `clients/{uid}`.
 *
 * Shared by `syncMyPaymentMethod` (the household came back from Checkout) and
 * by `stripeWebhook`'s setup-session branch (the household closed the tab
 * instead). Both paths have to agree on which card wins and on what gets
 * written, so there is one implementation rather than two that drift.
 */
export async function syncStripeCardToClient(
  uid: string,
  customerId: string,
  previousPaymentMethodId: string | null,
): Promise<StripeCardSyncResult> {
  const stripe = await getStripe();
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 10 });
  // Most recently attached wins. Stripe returns the list newest first, so the
  // head is the card the household just entered.
  const pm = methods.data[0] ?? null;

  if (!pm) {
    const changed = previousPaymentMethodId != null;
    if (changed) await clearStoredCard(uid);
    return { hasPaymentMethod: false, card: null, changed };
  }

  const card = pm.card ?? null;
  await db().collection('clients').doc(uid).set(
    {
      [PAYMENT_METHOD_ID_FIELD]: pm.id,
      stripeCardBrand: card?.brand ?? null,
      stripeCardLast4: card?.last4 ?? null,
      stripeCardExpMonth: card?.exp_month ?? null,
      stripeCardExpYear: card?.exp_year ?? null,
      stripePaymentMethodUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return {
    hasPaymentMethod: true,
    card:
      card && card.brand && card.last4 && card.exp_month && card.exp_year
        ? { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year }
        : null,
    changed: previousPaymentMethodId !== pm.id,
  };
}

async function clearStoredCard(uid: string): Promise<void> {
  await db().collection('clients').doc(uid).set(
    {
      [PAYMENT_METHOD_ID_FIELD]: FieldValue.delete(),
      stripeCardBrand: FieldValue.delete(),
      stripeCardLast4: FieldValue.delete(),
      stripeCardExpMonth: FieldValue.delete(),
      stripeCardExpYear: FieldValue.delete(),
      stripePaymentMethodUpdatedAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ── removeMyPaymentMethod ────────────────────────────────────────────────────

export const RemoveMyPaymentMethodArgs = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
});

export const RemoveMyPaymentMethodResult = z
  .object({
    ok: z.literal(true),
    /** True when there was no card to remove (this call was a no-op). */
    alreadyEmpty: z.boolean(),
  })
  .strict();

/**
 * Detaches the household's card at Stripe and clears the local mirror.
 *
 * This removes a payment INSTRUMENT, not a payment. Nothing here touches an
 * invoice, a charge, or the ledger: money already collected is untouched and
 * unpaid invoices stay exactly as they were, they just cannot be charged
 * automatically until a new card is added.
 */
export async function removeMyPaymentMethodHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof RemoveMyPaymentMethodResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(RemoveMyPaymentMethodArgs, req.data, 'removeMyPaymentMethod');
  const { kinfolkId, clientData } = await resolveOwnBillingHousehold(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'removeMyPaymentMethod',
  );

  const pmId = clientData[PAYMENT_METHOD_ID_FIELD];
  if (typeof pmId !== 'string' || pmId.length === 0) {
    return validateResponse('removeMyPaymentMethod', RemoveMyPaymentMethodResult, {
      ok: true,
      alreadyEmpty: true,
    });
  }

  const stripe = await getStripe();
  try {
    await stripe.paymentMethods.detach(pmId);
  } catch (err) {
    // Already detached at Stripe (a card removed from the dashboard, or a
    // double-tap on the button) is not a failure the household can act on, and
    // the local mirror still has to be cleared or the screen keeps showing a
    // card that is gone. Anything else is a real Stripe fault.
    const code = (err as { code?: string })?.code;
    if (code !== 'resource_missing') {
      logEvent({
        severity: 'error',
        function: 'removeMyPaymentMethod',
        event: 'portal.billing.detach.failed',
        uid,
        errorMessage: (err as Error)?.message,
        extra: { kinfolkId },
      });
      throw new HttpsError('unavailable', 'We could not reach Stripe to remove the card. Try again in a moment.');
    }
  }

  await clearStoredCard(uid);
  logEvent({
    severity: 'info',
    function: 'removeMyPaymentMethod',
    event: 'portal.billing.card.removed',
    uid,
    extra: { kinfolkId },
  });
  return validateResponse('removeMyPaymentMethod', RemoveMyPaymentMethodResult, {
    ok: true,
    alreadyEmpty: false,
  });
}

const BILLING_RUNTIME = {
  region: 'us-central1' as const,
  cors: TRIBETAILS_CORS,
  secrets: ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'AUNTIE_OPERATOR_UIDS'],
};

export const getMyPaymentMethod = onCall(
  BILLING_RUNTIME,
  wrapCallable('getMyPaymentMethod', getMyPaymentMethodHandler),
);

export const createBillingSetupSession = onCall(
  BILLING_RUNTIME,
  wrapCallable('createBillingSetupSession', createBillingSetupSessionHandler),
);

export const syncMyPaymentMethod = onCall(
  BILLING_RUNTIME,
  wrapCallable('syncMyPaymentMethod', syncMyPaymentMethodHandler),
);

export const removeMyPaymentMethod = onCall(
  BILLING_RUNTIME,
  wrapCallable('removeMyPaymentMethod', removeMyPaymentMethodHandler),
);
