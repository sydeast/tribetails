package com.tribetails.auntieos.ui.members

import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.util.emailOkOrBlank
import com.tribetails.auntieos.util.phoneOkOrBlank

const val SECONDARY_PHONE_INVALID = "Enter a 10-digit phone number, or leave it blank."
const val SECONDARY_EMAIL_INVALID = "Enter an email like name@example.com, or leave it blank."

/**
 * The server's checks on a secondary kinfolk, made before the save (#1593).
 * The walk typed a bad phone and a bad email and waited about four seconds
 * for the server's refusal; this refuses at once. The first problem wins, in
 * the form's order. The server keeps its own checks.
 */
fun secondaryKinfolkDraftError(name: String, phone: String, email: String): String? = when {
    name.isBlank() -> MembersRepository.SECONDARY_KINFOLK_NAME_REQUIRED
    !phoneOkOrBlank(phone) -> SECONDARY_PHONE_INVALID
    !emailOkOrBlank(email) -> SECONDARY_EMAIL_INVALID
    else -> null
}
/**
 * #1593: each field's own refusal, so the dialog can put every sentence under
 * the field it is about instead of one line for the first problem.
 */
data class SecondaryKinfolkFieldErrors(
    val name: String? = null,
    val phone: String? = null,
    val email: String? = null,
) {
    val any: Boolean get() = name != null || phone != null || email != null
}
fun secondaryKinfolkFieldErrors(name: String, phone: String, email: String): SecondaryKinfolkFieldErrors =
    SecondaryKinfolkFieldErrors(
        name = if (name.isBlank()) MembersRepository.SECONDARY_KINFOLK_NAME_REQUIRED else null,
        phone = if (!phoneOkOrBlank(phone)) SECONDARY_PHONE_INVALID else null,
        email = if (!emailOkOrBlank(email)) SECONDARY_EMAIL_INVALID else null,
    )
/**
 * A server refusal that names one of the three fields, placed on that field.
 * The server (`portal/secondaryKinfolk.ts`) refuses with these same sentences.
 */
fun secondaryKinfolkServerFieldErrors(message: String?): SecondaryKinfolkFieldErrors? = when (message) {
    MembersRepository.SECONDARY_KINFOLK_NAME_REQUIRED -> SecondaryKinfolkFieldErrors(name = message)
    SECONDARY_PHONE_INVALID -> SecondaryKinfolkFieldErrors(phone = message)
    SECONDARY_EMAIL_INVALID -> SecondaryKinfolkFieldErrors(email = message)
    else -> null
}
