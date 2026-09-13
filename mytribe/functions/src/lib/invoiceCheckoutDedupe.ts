/**
 * TWO CHECKOUT SESSIONS, ONE INVOICE: the dedupe that sits a level above the
 * PaymentIntent (issue #826).
 *
 * ── WHAT THE EXISTING TWO LEDGERS DO NOT COVER ────────────────────────────
 *
 * `stripeWebhook` already dedupes twice, and neither one is about the invoice:
 *
 *   `stripeEvents/{event.id}`        exactly once per EVENT. Stops Stripe's own
 *                                    delivery retries.
 *   `stripePayments/{intentId}`      exactly once per PAYMENT. Stops the two
 *                                    events one card charge produces
 *                                    (`checkout.session.completed` and
 *                                    `payment_intent.succeeded`) from applying
 *                                    twice.
 *
 * `payInvoice` mints a NEW Checkout Session on every call, and every session
 * carries its own PaymentIntent. So two completed sessions against one invoice
 * are two different intents producing four different event ids: they pass both
 * ledgers, and before this module nothing anywhere compared them against the
 * invoice they were both paying. Two real charges, and the server stopped
 * neither.
 *
 * That was not reachable through the portal, because the web client's success
 * path is `window.location.href` and an unloaded page cannot hold a second live
 * session. It was one line of navigation code, not a property of the payment
 * design — and on the KMP portal, which opens Checkout in an EXTERNAL browser
 * and keeps its own screen alive, it was never even that.
 *
 * ── WHY NOT JUST KEY ON THE INVOICE ID ────────────────────────────────────
 *
 * Because a second Stripe payment against one invoice can be entirely
 * legitimate, and a key of `invoiceId` alone would refuse a household's real
 * money. `payInvoice` has no amount argument: it always charges the FULL
 * remaining balance. So an invoice takes a second card payment whenever its
 * balance comes back after being cleared — the operator adds a line item to an
 * already-paid invoice, or records a partial Venmo payment and the household
 * settles the remainder by card. Those are two INTENDED payments and both must
 * land.
 *
 * What has to be told apart is therefore not "two payments" but "two attempts
 * at the same payment". The discriminator is the ROUND: the number of Stripe
 * payments that had already settled this invoice when the session was minted.
 * `payInvoice` stamps it into the session metadata (both copies — see that
 * file for why the metadata is written twice), and the webhook increments the
 * stored round each time it applies one.
 *
 *   two sessions minted before either settled   both stamped round N. The first
 *                                               to settle moves the invoice to
 *                                               N+1, so the second arrives
 *                                               STALE. Refused.
 *   a session minted after the last settled     stamped round N+1, invoice is at
 *                                               N+1. Applies.
 *
 * ── AND THE ROUND IS NOT ENOUGH ON ITS OWN ────────────────────────────────
 *
 * Two gaps it cannot see, which is why `duplicateCheckoutReason` has three
 * branches and not one:
 *
 *   the round never moved      `markInvoicePaid` and the account-credit
 *                              auto-apply settle an invoice without going
 *                              through Stripe at all, so a session minted
 *                              before a manual mark-paid still carries a
 *                              current-looking round. `invoice-not-owed`
 *                              catches it: an invoice that owes nothing is not
 *                              owed this money either.
 *   there is no round          every Checkout Session minted before this change
 *                              shipped. `settled-by-other-intent` and
 *                              `invoice-not-owed` both work without one, so an
 *                              in-flight session from the old build is still
 *                              covered; only the "balance came back" case needs
 *                              the stamp.
 *
 * ── WHAT THIS DOES NOT CLAIM TO CATCH ─────────────────────────────────────
 *
 * A LEGACY session (no round) that is stale while the invoice still shows a
 * balance. With no round there is nothing to compare and the invoice is asking
 * for money, so the payment applies. That is the honest call — the household
 * owes something and has paid something — but it can over-apply, because a
 * stale session charges the balance as it stood when it was minted. Every
 * session minted from this change onward carries a round and is covered; this
 * gap closes on its own as the last pre-change sessions expire (24h).
 *
 * ── WHAT "REFUSED" CAN AND CANNOT MEAN ────────────────────────────────────
 *
 * By the time the webhook sees a duplicate the card has ALREADY been charged.
 * There is no refusal that unwinds it, and the standing operator ruling is that
 * there are no refunds, ever. So the caller's duty is reconciliation, not
 * rejection: do not apply the money to the invoice a second time, and route it
 * to the household's account balance, which is the only destination money owed
 * back has (`lib/accountCredit.ts`, `portal/redeemCredit.ts`). This module
 * decides; `billing/stripeWebhook.ts` acts.
 *
 * Pure on purpose: every boundary below is a unit test rather than an emulator
 * run, the same way `planApply` and `planCreditDraw` are.
 */

/**
 * `families/{kinfolkId}.accountBalanceCents`, where a duplicate charge goes.
 *
 * RESTATED, not imported, and this is the one duplicated string in this file.
 * `lib/accountCredit.ts` owns the name and is the module that explains it, but
 * importing it here would drag `admin/markInvoicePaid` — and the `onCall`
 * registration at its file scope — into a module whose whole point is being
 * pure. `test/invoiceCheckoutDedupe.test.ts` asserts the two constants are the
 * same string, so the copy cannot drift silently.
 */
export const ACCOUNT_BALANCE_FIELD = 'accountBalanceCents';

/** Invoice field: how many Stripe payments have settled this invoice. */
export const CHECKOUT_ROUND_FIELD = 'stripeCheckoutRound';

/** Invoice field: the PaymentIntent of the Stripe payment that settled it. */
export const SETTLED_INTENT_FIELD = 'stripeSettledPaymentIntentId';

/**
 * Checkout Session / PaymentIntent metadata key carrying the round.
 *
 * Stripe metadata values are STRINGS. The number goes in via `String(n)` and
 * comes back out through `roundFromMetadata`, which is why that function
 * refuses anything that is not a clean non-negative integer rather than
 * letting `parseInt` turn `'3 apples'` into a round.
 */
export const CHECKOUT_ROUND_METADATA_KEY = 'checkoutRound';

/**
 * The stored round, as a number. Anything unreadable is round 0 — the state
 * every invoice that predates this field is genuinely in.
 */
export function checkoutRoundOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * The round a session was minted in, read off event metadata.
 *
 * `null`, not 0, when it is absent or malformed. The difference matters: 0 is a
 * real round that a stale-round comparison can fire on, and treating "this
 * session predates the stamp" as "this session was minted in round 0" would
 * refuse a legitimate second payment on any invoice that has settled once.
 */
export function roundFromMetadata(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The invoice fields this decision reads. Named so the webhook cannot drift. */
export interface InvoiceCheckoutState {
  /** `stripeCheckoutRound` as stored. */
  round: unknown;
  /** `stripeSettledPaymentIntentId` as stored. */
  settledPaymentIntentId: unknown;
  /** Integer cents, the settlement pass's figure. Preferred over `amountDue`. */
  amountDueCents: unknown;
  /** Legacy float dollars. All an older invoice carries. */
  amountDue: unknown;
}

/**
 * Does this invoice owe anything right now?
 *
 * EXPLICIT EVIDENCE ONLY, and that is the whole design of this function. An
 * invoice whose balance fields are absent reads as OWING, never as settled:
 * a missing field is an unknown balance, and treating unknown as settled would
 * divert a household's first and only payment into account credit. Erring the
 * other way costs a duplicate that a later branch may still catch; erring this
 * way silently unpays a bill.
 *
 * `amountDueCents` first, `amountDue` second — the same order and the same
 * reason as `payInvoice`: the integer figure is the settlement pass's own, and
 * the float dollar field is its projection.
 */
export function invoiceOwesNothing(state: Pick<InvoiceCheckoutState, 'amountDueCents' | 'amountDue'>): boolean {
  if (typeof state.amountDueCents === 'number' && Number.isFinite(state.amountDueCents)) {
    return state.amountDueCents <= 0;
  }
  if (typeof state.amountDue === 'number' && Number.isFinite(state.amountDue)) {
    return state.amountDue <= 0;
  }
  return false;
}

/**
 * Why this paid event is a second attempt at a payment the invoice has already
 * taken — or `null` when it is a payment in its own right.
 *
 * `stale-round`              the session was minted for a settlement round that
 *                            has since closed. The precise signal, and the only
 *                            one that fires while the invoice still shows a
 *                            balance — which is the case a partial payment
 *                            landing between two sessions produces.
 * `settled-by-other-intent`  the invoice owes nothing and a DIFFERENT Stripe
 *                            payment is named as what settled it. What catches
 *                            a session minted before the round stamp shipped.
 * `invoice-not-owed`         the invoice owes nothing and no Stripe payment is
 *                            named: it was settled by `markInvoicePaid` or by
 *                            the account-credit auto-apply, neither of which
 *                            moves the round.
 *
 * ── WHY "A DIFFERENT INTENT SETTLED IT" IS NOT ON ITS OWN A REFUSAL ───────
 *
 * Because it never stops being true. `stripeSettledPaymentIntentId` names the
 * LAST Stripe payment this invoice took, and it stays named for the life of the
 * invoice — so refusing on it alone would refuse every legitimate later payment
 * an invoice ever takes, which is precisely the "two intended payments" case
 * this module exists to protect. It only means duplicate when the invoice ALSO
 * owes nothing. An invoice with a balance takes the money.
 */
export type DuplicateCheckoutReason =
  | 'stale-round'
  | 'settled-by-other-intent'
  | 'invoice-not-owed'
  | null;

export function duplicateCheckoutReason(input: {
  /** The invoice as stored, read inside the webhook's transaction. */
  invoice: InvoiceCheckoutState;
  /** This event's PaymentIntent id, or null when it could not be resolved. */
  paymentIntentId: string | null;
  /** This event's metadata round, or null when the session carries none. */
  eventRound: number | null;
}): DuplicateCheckoutReason {
  const settled =
    typeof input.invoice.settledPaymentIntentId === 'string' && input.invoice.settledPaymentIntentId !== ''
      ? input.invoice.settledPaymentIntentId
      : null;

  // THE SAME payment arriving again is NOT this function's business. The
  // `stripePayments/{intentId}` claim catches it, runs first, and is the only
  // check that can tell the two events of one charge apart from two charges.
  // Said here as well because getting this order wrong is the one way this fix
  // is worse than the bug: it would credit an account for money that was
  // correctly applied.
  if (settled !== null && input.paymentIntentId !== null && settled === input.paymentIntentId) return null;

  // FIRST, because it is the only branch that can refuse a session while the
  // invoice still shows a balance. A partial payment recorded between two
  // sessions leaves the second one charging the OLD, larger figure at a moment
  // when the bill is genuinely still owed something.
  const storedRound = checkoutRoundOf(input.invoice.round);
  if (input.eventRound !== null && input.eventRound < storedRound) return 'stale-round';

  if (invoiceOwesNothing(input.invoice)) {
    return settled !== null ? 'settled-by-other-intent' : 'invoice-not-owed';
  }

  return null;
}
