package com.tribetails.auntieos.web.data

import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * #825: mints the id the row will be stored under for the four money writes this
 * console can make, so a second attempt at one submission lands on the row the
 * first attempt may already have written.
 *
 * `BookingIdempotency.kt` (#644) and `SendIdempotency.kt` (#814) beside this file
 * do the same job for booking creation and outbound sends, and the key shape is
 * theirs: `<prefix>_<millis>_<suffix>`, because the value becomes a Firestore
 * document id and the callable's zod guard refuses anything that is not the
 * shape the server itself mints. What is different here is only what a duplicate
 * costs. A payment recorded twice is two rows saying money arrived that arrived
 * once, and on the server's `recordPayment` an `autoApply` replay also
 * incremented the household's `accountBalanceCents` a second time -- and by
 * standing ruling the account balance is the only destination this business has
 * for money owed back, which makes that second credit spendable money made out
 * of nothing. `createInvoice` and `createQuote` each draw a value from the shared
 * `counters/invoiceNumber` sequence, and a consumed number cannot be handed back.
 *
 * WHAT THE KEY BUYS ON THIS SURFACE, AND WHAT IT DOES NOT. It does not buy an
 * automatic retry, and nothing here should be read as one. Every write from this
 * console reports its failure as a `WriteResult.Err` carrying a message string
 * and no error code -- `platformInvokeCallable` for the two invoice callables,
 * the REST layer for the direct payment write -- so this console genuinely
 * cannot tell "the request never arrived" from "the server looked at it and said
 * no", and a retry it cannot classify is a guess made with somebody's money.
 * What the key buys is the OPERATOR: when they press
 * Record payment (or Create invoice, or Create quote) a second time because the
 * first press reported an error they cannot interpret, the second press names
 * the row the first press may already have written, instead of writing a second
 * one. That is the whole of it, and it is the same treatment #646 gave this
 * console for bookings and #814 gave it for broadcasts.
 *
 * ONE KEY PER SUBMISSION, NOT PER PRESS. Callers hold the key for as long as the
 * thing being submitted is unchanged and mint a new one the moment it changes,
 * and they drop the held key once an attempt succeeds -- otherwise an operator
 * deliberately recording a second, genuinely identical payment would replay the
 * first one and be told it worked. See `InvoiceDetailScreen` and `InvoicesScreen`
 * for the three call sites, and `CommunicateScreen.send` for the precedent.
 *
 * [mintInvoicePaymentIdempotencyKey] has no caller in this console today: nothing
 * in composeApp invokes `markInvoicePaid` (the Record-payment dialog on the
 * invoice detail screen goes through `recordPayment` instead). It is minted here
 * anyway so all four keys this repo's money callables accept are defined in one
 * place, and so a screen that later wires that callable up does not invent a
 * fifth shape.
 *
 * See `mytribe/functions/src/lib/moneyIdempotency.ts` for the server half: why
 * each guard is a transaction rather than #814's bare `create()` claim, and why
 * the anchor row the callable was going to write IS the idempotency record.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/**
 * `recordPayment` -> `payments/{key}`. On this console that row is written
 * directly over REST rather than through the callable, so the key becomes the
 * document id here instead of riding in a payload; see
 * `FirestoreClient.recordPayment`. Same shape either way, so a row written from
 * here and a row the callable wrote for the same key are the same row.
 */
fun mintPaymentIdempotencyKey(random: Random = Random.Default): String = moneyKey("pay", random)

/** `markInvoicePaid` -> `invoices/{id}/payments/{key}`. No caller here yet; see above. */
fun mintInvoicePaymentIdempotencyKey(random: Random = Random.Default): String = moneyKey("ipay", random)

/** `createInvoice` -> `invoices/{key}`. */
fun mintInvoiceIdempotencyKey(random: Random = Random.Default): String = moneyKey("inv", random)

/** `createQuote` -> `invoices/{key}`. */
fun mintQuoteIdempotencyKey(random: Random = Random.Default): String = moneyKey("quot", random)

/**
 * The one place the shape is built. Four prefixes drifting apart one copy at a
 * time is exactly what `moneyIdempotency.ts` refuses to allow on the server, by
 * importing `sendIdempotencyKeyRe` rather than restating it.
 */
@OptIn(ExperimentalTime::class)
private fun moneyKey(prefix: String, random: Random): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "${prefix}_${Clock.System.now().toEpochMilliseconds()}_$suffix"
}
