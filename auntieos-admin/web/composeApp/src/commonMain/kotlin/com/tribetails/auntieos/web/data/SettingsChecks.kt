package com.tribetails.auntieos.web.data

/**
 * #1593: the field checks the Settings panels run before Save, the desktop
 * copy of `mytribe/functions/src/lib/businessSettingsChecks.ts`.
 *
 * Every settings save goes through the `saveBusinessSettings` callable, which
 * runs the same checks and refuses with the same sentences. The panels show
 * these beside the field so the operator reads what is wrong before pressing
 * Save; the server refusing means a client let something through.
 *
 * FORMAT, NOT POLICY. A check refuses a value no reader can use. None of them
 * picks a value for the operator (no price ceiling, no sensible hours).
 *
 * Mirrors: `auntieos-admin/src/lib/settingsChecks.ts` (web),
 * `ui/admin/SettingsChecks.kt` (Android). Change them together, and keep each
 * sentence word for word.
 */
object SettingsChecks {
    const val EMAIL_INVALID = "Enter an email like name@example.com, or leave it blank."
    const val PHONE_INVALID = "Enter a 10-digit phone number, or leave it blank."
    const val DATE_INVALID = "Enter a real date as YYYY-MM-DD."
    const val DATE_PAST = "That date has passed. Pick today or a later date."
    const val HOURS_RANGE_INVALID = "Enter both an opening and a closing time."
    const val HOURS_CLOSE_BEFORE_OPEN = "The closing time has to be after the opening time."
    const val KINCARE_NAME_REQUIRED = "Every KinCare type needs a name."
    const val CLOSURE_NAME_REQUIRED = "Give the closure a name."
    const val HOME_LIMIT_INVALID = "Enter a limit of 0 or more, as a whole number. 0 shows everything."
    const val MAX_OPTION_LIST_LENGTH = 12
    const val MAX_KINCARE_NAME_LENGTH = 80

    private val EMAIL_RE = Regex(
        "^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\\.[A-Za-z]{2,}$",
    )
    private val PHONE_CHARS_RE = Regex("^[+0-9()\\-. ]+$")
    private val ISO_DATE_RE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")
    private val TIME_RE = Regex("^(\\d{1,2}):(\\d{2})$")
    private val HHMM_RE = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")
    private val PRICE_RE = Regex("^\\d{1,7}(\\.\\d{1,2})?$")
    private val DIGITS_RE = Regex("^\\d+$")
    private val VENMO_RE = Regex("^[A-Za-z0-9_-]{5,30}$")
    private val PAYPAL_RE = Regex("^[A-Za-z0-9]{1,20}$")
    private val CASHAPP_RE = Regex("^\\$?(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{1,20}$")

    // ── Primitive shapes ─────────────────────────────────────────────────────

    /** The server's `isEmailShape`: the admin email shape, at most 254 characters, no doubled dot. */
    fun isEmailShape(raw: String): Boolean {
        val t = raw.trim()
        return t.isNotEmpty() && t.length <= 254 && EMAIL_RE.matches(t) && !t.contains("..")
    }

    /** The server's `isUsPhoneShape`: digits and the usual separators, 10 digits or 11 with a leading 1. */
    fun isUsPhoneShape(raw: String): Boolean {
        val t = raw.trim()
        if (t.isEmpty() || !PHONE_CHARS_RE.matches(t)) return false
        val digits = t.filter { it.isDigit() }
        return digits.length == 10 || (digits.length == 11 && digits.startsWith("1"))
    }

    /** `YYYY-MM-DD` naming a day the calendar has: 2026-02-30 and 2026-13-45 are not. */
    fun isRealDate(iso: String): Boolean {
        val m = ISO_DATE_RE.matchEntire(iso) ?: return false
        val y = m.groupValues[1].toInt()
        val mo = m.groupValues[2].toInt()
        val d = m.groupValues[3].toInt()
        if (mo !in 1..12 || d < 1) return false
        return d <= daysInMonth(y, mo)
    }

    private fun daysInMonth(year: Int, month: Int): Int = when (month) {
        2 -> if ((year % 4 == 0 && year % 100 != 0) || year % 400 == 0) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    /** `"9:00"` or `"09:00"` to `"09:00"`; null when it is not a time of day. */
    private fun hhmm(raw: String): String? {
        val m = TIME_RE.matchEntire(raw.trim()) ?: return null
        val padded = "${m.groupValues[1].padStart(2, '0')}:${m.groupValues[2]}"
        return if (HHMM_RE.matches(padded)) padded else null
    }

    // ── Business profile ─────────────────────────────────────────────────────

    /** Blank is allowed; anything else has to be an email shape. */
    fun businessEmailProblem(raw: String): String? =
        if (raw.isBlank() || isEmailShape(raw)) null else EMAIL_INVALID

    /** Blank is allowed; anything else has to be a US number. */
    fun businessPhoneProblem(raw: String): String? =
        if (raw.isBlank() || isUsPhoneShape(raw)) null else PHONE_INVALID

    // ── Hours ────────────────────────────────────────────────────────────────

    /**
     * One day's hours or a special-hours entry, `HH:MM-HH:MM`, closing after
     * opening. Null when it reads. Blank is the caller's call: Closed on a
     * weekday, refused on a special-hours entry.
     */
    fun hoursRangeProblem(raw: String): String? {
        val parts = raw.split('-')
        if (parts.size != 2) return HOURS_RANGE_INVALID
        val open = hhmm(parts[0]) ?: return HOURS_RANGE_INVALID
        val close = hhmm(parts[1]) ?: return HOURS_RANGE_INVALID
        if (close <= open) return HOURS_CLOSE_BEFORE_OPEN
        return null
    }

    /** A weekday's hours: blank is Closed, anything else has to be a range. */
    fun weekdayHoursProblem(raw: String): String? =
        if (raw.isBlank()) null else hoursRangeProblem(raw)

    // ── Time off ─────────────────────────────────────────────────────────────

    /** A new closure or special-hours date: a real date, today or later in the business's zone. */
    fun newDateProblem(iso: String, todayIso: String): String? {
        val t = iso.trim()
        if (!isRealDate(t)) return DATE_INVALID
        if (t < todayIso) return DATE_PAST
        return null
    }

    // ── KinCare types ────────────────────────────────────────────────────────

    /** A price: blank means no price set yet; otherwise dollars with at most two decimals, zero or more. */
    fun priceProblem(name: String, raw: String): String? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        if (t.startsWith("-")) return "The price for \"$name\" cannot be negative."
        if (!PRICE_RE.matches(t)) return "Enter the price for \"$name\" in dollars, like 25 or 25.50."
        return null
    }

    /** A visit length: blank, or whole minutes from 1 to 1440. */
    fun durationProblem(name: String, raw: String): String? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        val n = if (DIGITS_RE.matches(t)) t.toIntOrNull() else null
        if (n == null || n < 1 || n > 1440) return "Enter the length of \"$name\" in whole minutes, from 1 to 1440."
        return null
    }

    /**
     * What is wrong with each row's NAME, by index, against the rows before it.
     * Blank, too long, or the same name as an earlier row (ignoring case); the
     * later row of a pair carries the message.
     */
    fun kinCareNameProblems(names: List<String>): List<String?> {
        val seen = mutableSetOf<String>()
        return names.map { raw ->
            val name = raw.trim()
            when {
                name.isEmpty() -> KINCARE_NAME_REQUIRED
                name.length > MAX_KINCARE_NAME_LENGTH -> "Keep the name \"${name.take(20)}...\" under $MAX_KINCARE_NAME_LENGTH characters."
                !seen.add(name.lowercase()) -> "Two KinCare types are both called \"$name\"."
                else -> null
            }
        }
    }

    /** A rate as the booking preview shows it: `$25`, "No price set" when blank, null when it does not read. */
    fun priceLabel(name: String, raw: String): String? {
        val t = raw.trim()
        if (t.isEmpty()) return NO_PRICE_SET
        return if (priceProblem(name, t) == null) "$$t" else null
    }

    const val NO_PRICE_SET = "No price set"

    // ── Numbers ──────────────────────────────────────────────────────────────

    /** The server's `wholeNumber(lo, hi, unit)`: `"Enter 1 to 3650 days."`. */
    fun wholeNumberProblem(raw: String, lo: Int, hi: Int, unit: String): String? {
        val t = raw.trim()
        val n = if (DIGITS_RE.matches(t)) t.toIntOrNull() else null
        return if (n != null && n in lo..hi) null else "Enter $lo to $hi $unit."
    }

    /**
     * The server's `optionList(unit)`, on the comma list the operator types.
     * The sentences come in the server's order: empty, too many, not a whole
     * number above zero, a repeat.
     */
    fun optionListProblem(raw: String, unit: String): String? {
        val parts = raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        if (parts.isEmpty()) return "List at least one option, in $unit."
        if (parts.size > MAX_OPTION_LIST_LENGTH) return "That is more than $MAX_OPTION_LIST_LENGTH options. Trim the list."
        val seen = mutableSetOf<Int>()
        for (part in parts) {
            val n = if (DIGITS_RE.matches(part)) part.toIntOrNull() else null
            if (n == null || n <= 0) return "Every option has to be a whole number above zero."
            if (!seen.add(n)) return "$n is listed twice."
        }
        return null
    }

    // ── Payments ─────────────────────────────────────────────────────────────

    /** `venmo.com/u/<handle>`, an optional leading @. Blank is allowed. */
    fun venmoHandleProblem(raw: String): String? {
        val t = raw.trim().removePrefix("@")
        if (t.isEmpty()) return null
        return if (VENMO_RE.matches(t)) null else "Enter the Venmo username: 5 to 30 letters, numbers, - or _."
    }

    /** `paypal.me/<handle>`, an optional leading @. Blank is allowed. */
    fun paypalHandleProblem(raw: String): String? {
        val t = raw.trim().removePrefix("@")
        if (t.isEmpty()) return null
        return if (PAYPAL_RE.matches(t)) null else "Enter the PayPal.Me name: up to 20 letters and numbers."
    }

    /** `cash.app/<handle>`, the $Cashtag (the $ is optional). Blank is allowed. */
    fun cashappHandleProblem(raw: String): String? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        return if (CASHAPP_RE.matches(t)) null else "Enter the \$Cashtag: up to 20 letters, numbers or _, with at least one letter."
    }

    // ── MyTribe portal ───────────────────────────────────────────────────────

    /** The limit a typed home-section limit stands for: blank is 0, null when it does not read. */
    fun homeLimitValue(raw: String): Int? {
        val t = raw.trim()
        if (t.isEmpty()) return 0
        val n = if (DIGITS_RE.matches(t)) t.toIntOrNull() else null
        return n?.takeIf { it >= 0 }
    }

    /** A home-section limit: blank or a whole number from 0 (everything) up. */
    fun homeLimitProblem(raw: String): String? = if (homeLimitValue(raw) == null) HOME_LIMIT_INVALID else null
}
