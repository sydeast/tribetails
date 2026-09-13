package com.tribetails.auntieos.data.repository

import kotlin.random.Random

/**
 * #825: mints the id the SERVER will use for an INVOICE or a PAYMENT, so a
 * second attempt at one submission names the row the first attempt made.
 *
 * This is `SendIdempotency.kt` beside it (#814) pointed at money, and the
 * consequence of getting it wrong is worse than a duplicate email. The Firebase
 * SDK reports `INTERNAL` for any transport failure, the same code whether the
 * request never reached the container or the write committed and only the reply
 * was lost. Retrying repairs the first case; in the second, `recordPayment`
 * records a second payment AND, with `autoApply`, credits the household's
 * `accountBalanceCents` a second time. By standing ruling this business has no
 * refunds — account balance is the only destination it has for money owed back
 * — so that second credit is spendable money made from nothing, in a direction
 * nothing can claw back. `createInvoice` and `createQuote` are cheaper and
 * still bad: a replay used to burn a fresh number out of the shared
 * `counters/invoiceNumber` sequence on a document nobody asked for, and a
 * consumed sequence value cannot be given back.
 *
 * ONE KEY PER SUBMISSION, NOT PER PRESS. That is the discipline these functions
 * exist to support, and the discipline lives in the ViewModels, not here. A
 * ViewModel holds its key across the operator pressing the button again after
 * seeing an error, and mints a new one only when what is being submitted has
 * actually changed. A fresh key per press brings the duplicate straight back,
 * in the exact case the operator is most likely to produce one. See
 * `InvoiceDetailViewModel.recordPayment` and `AdminDataViewModel`, which hold
 * their keys the way `MarketingBlastsViewModel` and `CommunicateViewModel` hold
 * theirs.
 *
 * ONE PREFIX PER CALLABLE, deliberately. All four values become Firestore
 * document ids, and two of them land in the SAME `invoices` collection, so a
 * distinct prefix is what stops a key minted for a quote from being replayed at
 * `createInvoice` — where it would answer with a document that is not the one
 * being asked about.
 *
 * See `mytribe/functions/src/lib/moneyIdempotency.ts` for the server half: why
 * every one of these runs in a transaction rather than #814's bare `create()`
 * claim, and why the key is shaped rather than a uuid (it becomes a document id
 * that readers downstream already see, and the callable's zod guard refuses
 * anything else). The web admin mints the same four values in
 * `auntieos-admin/src/lib/moneyIdempotency.ts`.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

private fun mintMoneyKey(prefix: String, nowMs: Long, random: Random): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "${prefix}_${nowMs}_$suffix"
}

/** The id of the `payments/{key}` row `recordPayment` will create. */
fun mintPaymentIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String = mintMoneyKey("pay", nowMs, random)

/** The id of the `invoices/{invoiceId}/payments/{key}` row `markInvoicePaid` will create. */
fun mintInvoicePaymentIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String = mintMoneyKey("ipay", nowMs, random)

/** The id of the `invoices/{key}` document `createInvoice` will create. */
fun mintInvoiceIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String = mintMoneyKey("inv", nowMs, random)

/** The id of the `invoices/{key}` document `createQuote` will create. */
fun mintQuoteIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String = mintMoneyKey("quot", nowMs, random)
