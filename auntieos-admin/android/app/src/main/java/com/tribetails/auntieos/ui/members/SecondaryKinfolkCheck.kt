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
