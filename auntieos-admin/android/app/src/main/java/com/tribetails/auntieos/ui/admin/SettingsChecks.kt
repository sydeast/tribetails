package com.tribetails.auntieos.ui.admin

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.model.PAYMENT_METHOD_CATALOGUE
import com.tribetails.auntieos.data.model.PaymentDraft
import com.tribetails.auntieos.data.model.PaymentHandleField
import com.tribetails.auntieos.data.model.businessZone
import com.tribetails.auntieos.util.isValidEmail
import com.tribetails.auntieos.util.isValidPhone
import java.time.Clock
import java.time.LocalDate

/**
 * #1593: the Settings field checks, the same rules and the same sentences as
 * the server (`mytribe/functions/src/lib/businessSettingsChecks.ts`), which
 * every Settings save now goes through (`saveBusinessSettings`).
 *
 * The server is the gate; this file is so the operator reads the sentence
 * beside the field while typing, rather than after Save as a refusal. A server
 * refusal on a value this file let through is a bug in this file.
 *
 * FORMAT, NOT POLICY, as on the server: a check refuses a value no reader can
 * use (letters in a price, a close before the open, a date that does not
 * exist). It never picks a value for the operator.
 *
 * Mirrors: `auntieos-admin/src/lib/settingsChecks.ts` (web),
 * `web/data/SettingsChecks.kt` (desktop). Change them together.
 */

// ── Shared sentences, word for word the server's ────────────────────────────

const val EMAIL_INVALID = "Enter an email like name@example.com, or leave it blank."
const val PHONE_INVALID = "Enter a 10-digit phone number, or leave it blank."
const val DATE_INVALID = "Enter a real date as YYYY-MM-DD."
const val DATE_PAST = "That date has passed. Pick today or a later date."
const val HOURS_RANGE_INVALID = "Enter both an opening and a closing time."
const val HOURS_CLOSE_BEFORE_OPEN = "The closing time has to be after the opening time."
const val KINCARE_NAME_REQUIRED = "Every KinCare type needs a name."
const val CLOSURE_NAME_REQUIRED = "Give the closure a name."
/** The `|` separates the date from the name in the stored entry. */
const val CLOSURE_NAME_PIPE = "A name cannot contain |."
const val HOME_LIMIT_INVALID = "Enter a limit of 0 or more, as a whole number. 0 shows everything."

/** How many KinCare types one rate card may hold (server `MAX_KINCARE_TYPES`). */
const val MAX_KINCARE_TYPES = 100


// ── Primitive shapes ─────────────────────────────────────────────────────────

/** The server's email shape: the admin clients' shared regex, plus no doubled dot. */
fun isEmailShape(raw: String): Boolean = isValidEmail(raw) && !raw.trim().contains("..")

/** A US number: digits and the usual separators, 10 digits or 11 with a leading 1. */
fun isUsPhoneShape(raw: String): Boolean = isValidPhone(raw)

/** Business email: blank, or an email shape. */
fun businessEmailProblem(raw: String): String? =
    if (raw.isBlank() || isEmailShape(raw)) null else EMAIL_INVALID

/** Business phone: blank, or a US number. */
fun businessPhoneProblem(raw: String): String? =
    if (raw.isBlank() || isUsPhoneShape(raw)) null else PHONE_INVALID

private val ISO_DATE = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")

/** `YYYY-MM-DD` naming a day that exists: 2026-02-30 and 2026-13-45 do not. */
fun isRealDate(iso: String): Boolean {
    val m = ISO_DATE.matchEntire(iso) ?: return false
    val (y, mo, d) = m.destructured
    return runCatching { LocalDate.of(y.toInt(), mo.toInt(), d.toInt()) }.isSuccess
}

/**
 * A new dated entry (a one-off closure, a special-hours day): a real date, and
 * not before [todayIso], which is today in the business's own zone
 * ([businessTodayIso]). The server compares the same two strings.
 */
fun newDateProblem(iso: String, todayIso: String): String? {
    if (!isRealDate(iso)) return DATE_INVALID
    if (iso < todayIso) return DATE_PAST
    return null
}

/** Today in the business's zone, `YYYY-MM-DD`: the day the server checks a new date against. */
fun businessTodayIso(timeZone: String, clock: Clock = Clock.systemUTC()): String =
    LocalDate.now(clock.withZone(businessZone(timeZone))).toString()

private val HHMM = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")
private val LOOSE_HHMM = Regex("""^(\d{1,2}):(\d{2})$""")

/** `"9:00"` or `"09:00"` to `"09:00"`; null when it is not a time of day. */
private fun hhmm(raw: String): String? {
    val m = LOOSE_HHMM.matchEntire(raw.trim()) ?: return null
    val padded = "${m.groupValues[1].padStart(2, '0')}:${m.groupValues[2]}"
    return if (HHMM.matches(padded)) padded else null
}

/** One day's hours or a special-hours entry, `"HH:MM-HH:MM"`. Null when it reads. */
fun hoursRangeProblem(raw: String): String? {
    val parts = raw.split("-")
    if (parts.size != 2) return HOURS_RANGE_INVALID
    val open = hhmm(parts[0]) ?: return HOURS_RANGE_INVALID
    val close = hhmm(parts[1]) ?: return HOURS_RANGE_INVALID
    if (close <= open) return HOURS_CLOSE_BEFORE_OPEN
    return null
}

/** The same rule for an opening and a closing time typed in two fields. */
fun hoursPairProblem(open: String, close: String): String? =
    if (open.contains('-') || close.contains('-')) HOURS_RANGE_INVALID else hoursRangeProblem("$open-$close")

/**
 * A weekly-hours row on the separate `business_hours` collection (the Settings
 * Business hours panel and the Services hours dialog). Same sentences as
 * [hoursPairProblem], but each time must already be exact `HH:MM`: those
 * rows are saved as typed and read back by code that expects two-digit hours,
 * and no server check stands in front of that collection.
 */
fun businessHoursRowProblem(open: String, close: String): String? {
    if (!HHMM.matches(open) || !HHMM.matches(close)) return HOURS_RANGE_INVALID
    return hoursPairProblem(open, close)
}

// ── KinCare types ────────────────────────────────────────────────────────────

private val PRICE = Regex("""^\d{1,7}(\.\d{1,2})?$""")
private val WHOLE = Regex("""^\d+$""")

/** A rate: blank ("no price set yet"), or dollars with at most two decimals, zero or more. */
fun priceProblem(name: String, raw: String): String? {
    val t = raw.trim()
    if (t.isEmpty()) return null
    if (t.startsWith("-")) return "The price for \"$name\" cannot be negative."
    if (!PRICE.matches(t)) return "Enter the price for \"$name\" in dollars, like 25 or 25.50."
    return null
}

/** A visit length: blank, or whole minutes from 1 to 1440. */
fun durationProblem(name: String, raw: String): String? {
    val t = raw.trim()
    if (t.isEmpty()) return null
    val n = if (WHOLE.matches(t)) t.toIntOrNull() else null
    if (n == null || n < 1 || n > 1440) return "Enter the length of \"$name\" in whole minutes, from 1 to 1440."
    return null
}

/** True when [raw] is a rate that may be shown with a dollar sign: not blank, and it passes. */
fun isShowablePrice(raw: String): Boolean = raw.isNotBlank() && priceProblem("", raw) == null

/** What is wrong with one KinCare row, field by field. All null means it saves. */
data class KinCareRowProblems(
    val name: String? = null,
    val duration: String? = null,
    val rate: String? = null,
) {
    val any: Boolean get() = name != null || duration != null || rate != null
}

/**
 * The problems on each row, by row index (rows with none are absent). The
 * server's `serviceRates` / `serviceDurations` checks over the rows Save would
 * fold: a row whose name is blank is refused, EXCEPT a freshly added row left
 * entirely empty, which Save drops (an abandoned add is not an edit). Names are
 * compared trimmed and without case, and the second of two matching rows
 * carries the duplicate sentence.
 */
fun kinCareRowProblems(rows: List<KinCareTypeRow>): Map<Int, KinCareRowProblems> {
    val out = LinkedHashMap<Int, KinCareRowProblems>()
    val seen = HashSet<String>()
    rows.forEachIndexed { index, row ->
        val name = row.type.trim()
        val abandonedAdd = !row.existing && name.isEmpty() && row.rate.isBlank() &&
            row.duration.isBlank() && !row.startTime
        if (abandonedAdd) return@forEachIndexed
        val nameProblem = when {
            name.isEmpty() -> KINCARE_NAME_REQUIRED
            name.length > 80 -> "Keep the name \"${name.take(20)}...\" under 80 characters."
            !seen.add(name.lowercase()) -> "Two KinCare types are both called \"$name\"."
            else -> null
        }
        val label = name.ifEmpty { "this type" }
        val problems = KinCareRowProblems(
            name = nameProblem,
            duration = durationProblem(label, row.duration),
            rate = priceProblem(label, row.rate),
        )
        if (problems.any) out[index] = problems
    }
    return out
}

/** The rate-card-wide refusal, or null. */
fun kinCareCountProblem(rows: List<KinCareTypeRow>): String? =
    if (rows.count { it.type.isNotBlank() } > MAX_KINCARE_TYPES) "That is more than $MAX_KINCARE_TYPES KinCare types." else null

// ── Payments ─────────────────────────────────────────────────────────────────

private val VENMO = Regex("^[A-Za-z0-9_-]{5,30}$")
private val PAYPAL = Regex("^[A-Za-z0-9]{1,20}$")
private val CASHTAG = Regex("^\\$?(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{1,20}$")

/** `venmo.com/u/<handle>`, an optional leading @. */
fun venmoHandleProblem(raw: String): String? {
    val t = raw.trim().removePrefix("@")
    if (t.isEmpty()) return null
    return if (VENMO.matches(t)) null else "Enter the Venmo username: 5 to 30 letters, numbers, - or _."
}

/** `paypal.me/<handle>`, an optional leading @. */
fun paypalHandleProblem(raw: String): String? {
    val t = raw.trim().removePrefix("@")
    if (t.isEmpty()) return null
    return if (PAYPAL.matches(t)) null else "Enter the PayPal.Me name: up to 20 letters and numbers."
}

/** `cash.app/<handle>`, the $Cashtag (the $ is optional here). */
fun cashappHandleProblem(raw: String): String? {
    val t = raw.trim()
    if (t.isEmpty()) return null
    return if (CASHTAG.matches(t)) null else "Enter the \$Cashtag: up to 20 letters, numbers or _, with at least one letter."
}

/** The server's check for one handle field. */
fun paymentHandleProblem(field: PaymentHandleField, raw: String): String? = when (field) {
    PaymentHandleField.VENMO -> venmoHandleProblem(raw)
    PaymentHandleField.PAYPAL -> paypalHandleProblem(raw)
    PaymentHandleField.CASHAPP -> cashappHandleProblem(raw)
}

/**
 * The handle problems the Payment options panel shows, by field. A handle
 * counts while its method is switched on (its box is on screen) or when it
 * differs from [saved], because Save sends a changed handle even with its
 * switch off. A stored handle hidden behind an off switch is not sent and not
 * flagged. Which of these hold Save is [paymentHandlesBlockSave].
 */
fun paymentHandleProblems(draft: PaymentDraft, saved: PaymentDraft): Map<PaymentHandleField, String> {
    val out = LinkedHashMap<PaymentHandleField, String>()
    for (method in PAYMENT_METHOD_CATALOGUE) {
        val field = method.handleField ?: continue
        val handle = draft.handles[field].orEmpty()
        val shown = draft.options[method.id]?.enabled ?: method.defaultEnabled
        val changed = handle.trim() != saved.handles[field].orEmpty().trim()
        if (!shown && !changed) continue
        paymentHandleProblem(field, handle)?.let { out[field] = it }
    }
    return out
}

/**
 * True when Save would send a handle the server refuses: a CHANGED handle with
 * a problem. An unchanged stored handle is not sent (the save is a diff), so
 * its sentence shows under the box without holding a Zelle or Cash edit back.
 */
fun paymentHandlesBlockSave(draft: PaymentDraft, saved: PaymentDraft): Boolean =
    PaymentHandleField.values().any { field ->
        val handle = draft.handles[field].orEmpty()
        handle.trim() != saved.handles[field].orEmpty().trim() && paymentHandleProblem(field, handle) != null
    }

// ── Numbers ──────────────────────────────────────────────────────────────────

/** A whole number from [lo] to [hi], typed: the server's `wholeNumber` sentence otherwise. */
fun wholeNumberProblem(raw: String, lo: Int, hi: Int, unit: String): String? {
    val t = raw.trim()
    val n = if (WHOLE.matches(t)) t.toIntOrNull() else null
    return if (n != null && n in lo..hi) null else "Enter $lo to $hi $unit."
}

/** A comma-separated option list, in [unit]: the server's `optionList` sentences, in its order. */
fun optionListProblem(raw: String, unit: String): String? {
    val parts = raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "List at least one option, in $unit."
    if (parts.size > MAX_OPTION_LIST_LENGTH) return "That is more than $MAX_OPTION_LIST_LENGTH options. Trim the list."
    val seen = HashSet<Int>()
    for (part in parts) {
        val n = if (WHOLE.matches(part)) part.toIntOrNull() else null
        if (n == null || n <= 0) return "Every option has to be a whole number above zero."
        if (!seen.add(n)) return "$n is listed twice."
    }
    return null
}

/** A portal Home section limit as typed: a whole number, 0 or more (0 shows everything). No ceiling: the operator's call. */
fun homeLimitProblem(raw: String): String? {
    val t = raw.trim()
    val n = if (WHOLE.matches(t)) t.toIntOrNull() else null
    return if (n != null && n >= 0) null else HOME_LIMIT_INVALID
}

// ── Time off ─────────────────────────────────────────────────────────────────

/** What is wrong with a closure add-row, field by field. */
data class ClosureAddProblems(val name: String? = null, val date: String? = null) {
    val any: Boolean get() = name != null || date != null
}

/**
 * A new company closure. Every kind needs a name; a one-off needs a real date
 * that has not passed. The yearly kinds are picked from lists, so their only
 * typed field is the name.
 */
fun closureAddProblems(
    recurrence: ClosureRecurrenceKind,
    name: String,
    date: String,
    todayIso: String,
): ClosureAddProblems = ClosureAddProblems(
    name = when {
        name.isBlank() -> CLOSURE_NAME_REQUIRED
        name.contains('|') -> CLOSURE_NAME_PIPE
        else -> null
    },
    date = if (recurrence == ClosureRecurrenceKind.ONCE) newDateProblem(date.trim(), todayIso) else null,
)

/** What is wrong with a special-hours add-row, field by field. */
data class SpecialHoursAddProblems(val date: String? = null, val hours: String? = null) {
    val any: Boolean get() = date != null || hours != null
}

/** A new special-hours day: a real date that has not passed, and `HH:MM-HH:MM` hours. */
fun specialHoursAddProblems(date: String, hours: String, todayIso: String): SpecialHoursAddProblems =
    SpecialHoursAddProblems(
        date = newDateProblem(date.trim(), todayIso),
        hours = hoursRangeProblem(hours),
    )

// ── Server refusals ──────────────────────────────────────────────────────────

/** One refusal from `saveBusinessSettings`: the top-level field and the sentence. */
data class SettingsRefusal(val field: String, val message: String)

/** The `details.code` the server puts on a field refusal. */
const val SETTINGS_REFUSED_CODE = "settings_refused"

/**
 * The refusal [t] carries when the server turned a settings save down on a
 * field, or null for any other failure. The message is the server's first
 * sentence, which is also the exception's own message.
 */
fun settingsRefusalOf(t: Throwable?): SettingsRefusal? {
    val e = t as? FirebaseFunctionsException ?: return null
    val details = e.details as? Map<*, *> ?: return null
    if (details["code"] != SETTINGS_REFUSED_CODE) return null
    val field = details["field"] as? String ?: return null
    val first = (details["refusals"] as? List<*>)?.firstOrNull() as? Map<*, *>
    val message = (first?.get("message") as? String)?.takeIf { it.isNotBlank() }
        ?: e.message?.takeIf { it.isNotBlank() }
        ?: return null
    return SettingsRefusal(field = field, message = message)
}

/**
 * What a Settings screen shows when a save failed: a server refusal is the
 * operator's sentence as it stands, anything else keeps the screen's own lead-in.
 */
fun settingsSaveFailureText(failureLabel: String, t: Throwable): String =
    settingsRefusalOf(t)?.message ?: "$failureLabel: ${t.message}"
