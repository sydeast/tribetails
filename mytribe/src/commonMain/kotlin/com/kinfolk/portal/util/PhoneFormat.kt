package com.kinfolk.portal.util
/**
 * Phone display and pre-submit checks shared by every portal screen (#1306,
 * #1289). The web twin is `web/src/lib/phone.ts`; keep the two in step.
 *
 * The server stores E.164 (`+15125550142`). Nothing a person reads should ever
 * be that string, so every place a phone is shown or edited goes through
 * [formatPhone].
 */
object PhoneFormat {
    /** What a household reads for a number the form can already see is wrong. */
    const val PROBLEM = "Enter a 10-digit phone number."
    private fun digitsOf(raw: String): String = raw.filter { it in '0'..'9' }
    /** The ten US digits in [raw], or null when it is not a US number. */
    private fun usDigits(raw: String): String? {
        val trimmed = raw.trim()
        val digits = digitsOf(trimmed)
        if (digits.length == 10 && !trimmed.startsWith("+")) return digits
        if (digits.length == 11 && digits.startsWith("1")) return digits.drop(1)
        return null
    }
    /**
     * `(512) 555-0142` for a US number in any common shape (`+15125550142`,
     * `5125667512`, `512-555-0142`). Anything else, international numbers
     * included, comes back as typed.
     */
    fun format(raw: String?): String {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return ""
        val us = usDigits(trimmed) ?: return trimmed
        return "(${us.substring(0, 3)}) ${us.substring(3, 6)}-${us.substring(6)}"
    }
    /**
     * A plain message when [raw] cannot be a phone number, else null. Empty is
     * fine (the field is optional). A floor, not the rule: the server's
     * libphonenumber check has the last word and uses the same sentence.
     */
    fun problem(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.any { !(it in '0'..'9' || it in " ()+.-" ) }) return PROBLEM
        val digits = digitsOf(trimmed)
        if (trimmed.startsWith("+")) return if (digits.length in 8..15) null else PROBLEM
        if (digits.length == 10) return null
        if (digits.length == 11 && digits.startsWith("1")) return null
        return PROBLEM
    }
}
fun formatPhone(raw: String?): String = PhoneFormat.format(raw)
fun phoneProblem(raw: String): String? = PhoneFormat.problem(raw)
