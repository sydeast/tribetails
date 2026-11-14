package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.util.emailOkOrBlank
import com.tribetails.auntieos.util.isValidPhone
import com.tribetails.auntieos.util.phoneOkOrBlank

/**
 * #1951: the phone and email checks Add Kinfolk runs before anything is
 * created. The walk on admin web saved "abc" for a phone and a word with no @
 * sign for an email; admin Android only greyed out Save, with nothing beside
 * the field to say why. Each field now says so beside itself, in the words the
 * admin web form uses, and the view model refuses the create on the same rules
 * (the server's `createKinfolk` refuses it too).
 */

internal const val ADD_KINFOLK_PHONE_INVALID = "Enter a 10 digit phone number, or 11 starting with 1."
internal const val ADD_KINFOLK_SECONDARY_PHONE_INVALID = "Leave this blank, or enter a 10 digit phone number."
internal const val ADD_KINFOLK_EMAIL_INVALID = "That email address doesn't look right."

/**
 * The Emergency Contact's phone, checked before the household is created. The
 * server's own check (libphonenumber) is stricter, so a number shaped right can
 * still be refused after the create; that keeps its own message.
 */
internal const val EMERGENCY_CONTACT_PHONE_SHAPE = "An Emergency Contact's phone needs 10 digits, or 11 starting with 1."

/** Beside Primary Phone. Blank is the "phone or email" rule's business, not this one. */
internal fun addKinfolkPhoneError(raw: String): String? = if (phoneOkOrBlank(raw)) null else ADD_KINFOLK_PHONE_INVALID

internal fun addKinfolkSecondaryPhoneError(raw: String): String? =
    if (phoneOkOrBlank(raw)) null else ADD_KINFOLK_SECONDARY_PHONE_INVALID

internal fun addKinfolkEmailError(raw: String): String? = if (emailOkOrBlank(raw)) null else ADD_KINFOLK_EMAIL_INVALID

/** The first contact field that is filled in but not a phone or an email, or null. */
internal fun addKinfolkShapeError(phone: String, secondaryPhone: String, email: String): String? =
    addKinfolkPhoneError(phone) ?: addKinfolkSecondaryPhoneError(secondaryPhone) ?: addKinfolkEmailError(email)

/** A filled-in Emergency Contact phone that is not a phone. A blank one is "needs a phone number". */
internal fun emergencyContactPhoneShapeError(drafts: List<EmergencyContactDraft>): String? =
    if (drafts.any { it.phone.isNotBlank() && !isValidPhone(it.phone) }) EMERGENCY_CONTACT_PHONE_SHAPE else null
