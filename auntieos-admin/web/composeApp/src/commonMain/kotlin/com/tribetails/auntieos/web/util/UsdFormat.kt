package com.tribetails.auntieos.web.util

import kotlin.math.abs
import kotlin.math.floor

/**
 * The desktop console's one money-label formatter (#1488).
 *
 * Every dollar amount the app prints groups thousands, "$1,234.50", the way the
 * kinfolk portal does on web and Android (#1484), the admin web console does,
 * and the server's emails and PDFs do. Display only: never seed an input with
 * these (inputs use `centsToInputDollars`, which the parsers read back), and
 * never parse them.
 *
 * Pure Kotlin, no `java.text`, so the Android app's copy
 * (`auntieos-admin/android/app/.../domain/UsdFormat.kt`) is the same code.
 */

/** "1,234" from a whole number. The sign, if any, is kept in front. */
fun groupThousands(whole: Long): String {
    if (whole < 0) return "-" + groupThousands(-whole)
    val digits = whole.toString()
    val head = digits.length % 3
    val sb = StringBuilder(digits.length + digits.length / 3)
    for (i in digits.indices) {
        if (i > 0 && (i - head) % 3 == 0) sb.append(',')
        sb.append(digits[i])
    }
    return sb.toString()
}

/** "1,234.50" from the MAGNITUDE of [cents]: no sign, no dollar sign. */
fun usdDigitsFromCents(cents: Long): String {
    val a = abs(cents)
    return groupThousands(a / 100) + "." + (a % 100).toString().padStart(2, '0')
}

/** "$36.00" / "-$12.50" / "$1,234.50" from an integer count of cents. */
fun formatUsdCents(cents: Long): String = (if (cents < 0) "-" else "") + "$" + usdDigitsFromCents(cents)

/**
 * Dollars to whole cents, half away from zero, the rounding `"%.2f"` gave the
 * call sites this replaces. Non-finite reads as 0, never "$NaN".
 */
fun dollarsToRoundedCents(dollars: Double): Long {
    if (!dollars.isFinite()) return 0L
    val c = floor(abs(dollars) * 100.0 + 0.5).toLong()
    return if (dollars < 0) -c else c
}

/** "$36.00" / "-$12.50" / "$1,234.50" from a dollars-denominated amount. */
fun formatUsd(dollars: Double): String = formatUsdCents(dollarsToRoundedCents(dollars))

/** "1,234.50" from a dollars amount: [formatUsd] without the sign and dollar sign. */
fun usdDigits(dollars: Double): String = usdDigitsFromCents(dollarsToRoundedCents(dollars))

/**
 * The compact form the Cash Flow rows and the invoice list use: whole dollars
 * drop the ".00" ("$1,280"), anything else keeps two decimals ("$1,280.50").
 */
fun formatUsdCompact(dollars: Double): String {
    val cents = dollarsToRoundedCents(dollars)
    val sign = if (cents < 0) "-" else ""
    val a = abs(cents)
    return if (a % 100 == 0L) "$sign$" + groupThousands(a / 100) else sign + "$" + usdDigitsFromCents(a)
}

/**
 * Whether [money], as a row prints it, contains the already lower-cased,
 * trimmed query [q]. Tried as printed first, then comma-free on both sides, so
 * "1234.50" and "1,234.50" both find "$1,234.50". A query of only commas
 * matches nothing.
 */
fun moneyTextMatches(money: String, q: String): Boolean {
    if (money.lowercase().contains(q)) return true
    val plain = q.replace(",", "")
    return plain.isNotEmpty() && money.replace(",", "").contains(plain)
}
