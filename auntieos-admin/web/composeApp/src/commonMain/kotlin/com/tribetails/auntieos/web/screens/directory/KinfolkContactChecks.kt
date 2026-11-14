package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.util.isValidEmail
import com.tribetails.auntieos.web.util.isValidPhone

/**
 * #1951: the words beside the household's phone and email on the desktop
 * Kinfolk editor (Add and Edit). The form already refused a bad value, but only
 * by turning the field red, with nothing to say why. The words are admin web's
 * (`lib/kinfolkEditSchema.ts`), so every door says the same thing; the server
 * (`createKinfolk`, and the rules on an edit) holds the same shapes.
 */

internal const val KINFOLK_PHONE_REQUIRED = "A phone number is required."
internal const val KINFOLK_PHONE_INVALID = "Enter a 10 digit phone number, or 11 starting with 1."
internal const val KINFOLK_SECONDARY_PHONE_INVALID = "Leave this blank, or enter a 10 digit phone number."
internal const val KINFOLK_EMAIL_REQUIRED = "An email address is required."
internal const val KINFOLK_EMAIL_INVALID = "That email address doesn't look right."

/**
 * The Emergency Contact's phone, checked on Add before the household is
 * created. The server's own check (libphonenumber) is stricter, so a number
 * shaped right can still be refused after the create; that keeps its message.
 */
internal const val EMERGENCY_CONTACT_PHONE_SHAPE = "An Emergency Contact's phone needs 10 digits, or 11 starting with 1."

/** Primary phone: required on this form, and a phone. */
internal fun kinfolkPhoneMessage(raw: String): String? = when {
    raw.isBlank() -> KINFOLK_PHONE_REQUIRED
    !isValidPhone(raw) -> KINFOLK_PHONE_INVALID
    else -> null
}

/** Primary email: required on this form, and an email. */
internal fun kinfolkEmailMessage(raw: String): String? = when {
    raw.isBlank() -> KINFOLK_EMAIL_REQUIRED
    !isValidEmail(raw) -> KINFOLK_EMAIL_INVALID
    else -> null
}

internal fun kinfolkSecondaryPhoneMessage(raw: String): String? =
    if (raw.isNotBlank() && !isValidPhone(raw)) KINFOLK_SECONDARY_PHONE_INVALID else null

internal fun kinfolkSecondaryEmailMessage(raw: String): String? =
    if (raw.isNotBlank() && !isValidEmail(raw)) KINFOLK_EMAIL_INVALID else null

/** A filled-in Emergency Contact phone that is not a phone. A blank one is "needs a phone number". */
internal fun emergencyContactPhoneShapeError(drafts: List<EmergencyContactDraft>): String? =
    if (drafts.any { it.phone.isNotBlank() && !isValidPhone(it.phone) }) EMERGENCY_CONTACT_PHONE_SHAPE else null
