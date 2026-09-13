package com.kinfolk.portal.portal

import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * #825: the key that stops one tap on Pay becoming two live Checkout Sessions.
 *
 * `BookingIdempotency.kt` beside this file does the same job for booking
 * creation (#644), and everything its header says about this client still
 * holds: `FunctionsClient.call` throws a plain `Throwable` with no code — one
 * facade over gitlive on android and REST on jvm — so the portal cannot tell a
 * dropped request from a refusal and does NOT retry on its own. The key is what
 * makes the household tapping Pay again, after seeing an error, land on the
 * checkout the first tap may already have opened.
 *
 * WHAT IS DIFFERENT HERE IS WHERE THE DUPLICATE LIVES. A booking key is checked
 * by our own server against a Firestore document. There is nothing of ours to
 * check for a checkout: `payInvoice` asks STRIPE to create a Checkout Session,
 * and a replay creates a SECOND session in Stripe's database. Both stay
 * payable. Nothing our server writes can stop that session being created, so
 * the callable passes this value through to Stripe as a request option and
 * Stripe answers the retry with the first session.
 *
 * #826 ALREADY COVERS THE CHARGE ITSELF: a second completed session is
 * recognised by `stripeWebhook` and its money goes to the household's account
 * balance rather than paying the bill twice. That net holds. It cannot
 * un-charge the card, because there are no refunds here and it acts after the
 * money has moved, so a household debited twice is still debited twice. This
 * key is what stops the second debit happening.
 *
 * IT ALSO COVERS A TAP #826 CANNOT SEE. The server's session reuse needs the
 * PREVIOUS call to have finished and stored `pendingCheckoutSessionId`. A call
 * that made the session and then lost its reply stored nothing, so the retry
 * finds nothing to reuse and opens a second session. That is this key's case.
 *
 * ONE KEY PER SUBMISSION, NOT PER TAP, and here that rule has a hard outer
 * bound: Stripe holds a key for 24 hours and REFUSES one reused with a
 * different request body. The amount `payInvoice` sends is the invoice's
 * REMAINING balance, so a household coming back to pay a balance that has since
 * moved must carry a new key. `InvoicesController` therefore holds one key per
 * invoice for the life of a pay attempt and drops it the moment a checkout URL
 * comes back, rather than keeping one for the life of the screen. Where the two
 * rules disagree Stripe errors rather than charging twice, which is the safe
 * direction to be wrong in.
 *
 * See `mytribe/functions/src/lib/moneyIdempotency.ts` for the server half.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

@OptIn(ExperimentalTime::class)
fun mintCheckoutIdempotencyKey(random: Random = Random.Default): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "chk_${Clock.System.now().toEpochMilliseconds()}_$suffix"
}
