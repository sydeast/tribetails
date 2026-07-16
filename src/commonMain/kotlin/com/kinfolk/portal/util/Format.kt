package com.kinfolk.portal.util

import kotlin.math.abs
import kotlin.math.round

/**
 * Minimal cross-platform USD formatter.
 * Avoids `java.text.NumberFormat` (jvm/android-only) and `Intl.NumberFormat`
 * platform plumbing — fine for short labels.
 */
fun formatUsd(value: Double): String {
    if (value.isNaN() || value.isInfinite()) return "$0.00"
    val cents = round(abs(value) * 100).toLong()
    val dollars = cents / 100
    val rem = cents % 100
    val dollarStr = dollars.toString().reversed().chunked(3).joinToString(",").reversed()
    val centStr = if (rem < 10) "0$rem" else rem.toString()
    // No "-" on values that round to zero — avoids "-$0.00" for tiny negatives.
    val sign = if (value < 0 && cents > 0) "-" else ""
    return "$sign$$dollarStr.$centStr"
}
