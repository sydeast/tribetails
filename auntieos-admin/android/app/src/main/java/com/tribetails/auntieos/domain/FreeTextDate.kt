package com.tribetails.auntieos.domain

import com.tribetails.auntieos.util.formatJoinDate

/**
 * HOW TO SAY A BILLING DATE THE BUSINESS TYPED, rather than a prefix of one.
 *
 * `invoices.date`, `invoices.dueDate` and `payments.date` are free text and the
 * server says so: `getInvoiceLedger.ts` documents the payment field as "FREE
 * TEXT on this collection, like every legacy billing date. Not parsed.", and
 * PR #241 confirmed the invoice fields hold the same shape in production -
 * `February 17, 2026` is what a real row looks like.
 *
 * THE ONLY RULE HERE: never show a date the record does not say. `take(10)` on
 * `February 17, 2026` is `February 1`, which is not a shortened date but a
 * DIFFERENT one - real, plausible, and giving nobody a hint that anything was
 * cut. That is the defect this exists to stop, on every surface that shows one
 * of these fields.
 *
 * SO WHY PARSE AT ALL, rather than print the string and be done? Because the
 * truncation was reaching for something real: an ISO instant rendered raw is
 * machine text and the operator is reading a bill. When the stored value IS a
 * day this app can read it is spelled out for her locale; everything else
 * passes through exactly as stored.
 *
 * [formatJoinDate] already solves exactly this and is reused rather than
 * re-derived (it was written for `households.joinDate`, the app's other free
 * text date field): it reads the LITERAL characters of the day and never shifts
 * a zone, so the day on screen is always the day in the record, only re-spelled.
 * It refuses `07/24/2026` and friends on purpose, because month-first and
 * day-first are indistinguishable for the first twelve days of any month.
 *
 * BLANK COMES BACK BLANK, deliberately: each surface already has its own words
 * for a date nobody wrote down - the ledger row says "no date recorded", the
 * amount-due card says "due soon", the kinfolk feed omits the date segment
 * entirely - and inventing a fourth phrasing here would overwrite all three.
 */
fun freeTextDateLabel(raw: String): String {
    val stored = raw.trim()
    if (stored.isEmpty()) return ""
    return formatJoinDate(stored)
}
