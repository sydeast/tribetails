package com.kinfolk.portal.screens.account

import com.kinfolk.portal.portal.Account
import com.kinfolk.portal.util.formatPhone

/**
 * #1336. What an Account save sends: a value for a changed field, a name in
 * [clearFields] for a field the household emptied, and nothing for a field the
 * form did not change. Arguments are passed straight to `PortalApi.saveMyAccount`.
 */
internal data class AccountChanges(
    val displayName: String? = null,
    val phone: String? = null,
    val photoUrl: String? = null,
    val backupEmail: String? = null,
    val backupPhone: String? = null,
    val clearFields: Set<String> = emptySet(),
)

/**
 * Diffs the form text against what the screen seeded it with from [loaded]
 * (the same formatting: phones through [formatPhone], a display name equal to
 * the email shown blank). [loaded] null (the account never loaded) diffs
 * against blanks, so only filled fields are sent and nothing is cleared.
 *
 * The name cannot be cleared (the callable requires one character), so a blank
 * name is left alone rather than sent.
 */
internal fun accountChanges(
    loaded: Account?,
    displayName: String,
    phone: String,
    photoUrl: String,
    backupEmail: String,
    backupPhone: String,
): AccountChanges {
    val clears = mutableSetOf<String>()
    fun diff(key: String, now: String, before: String): String? {
        val next = now.trim()
        if (next == before.trim()) return null
        if (next.isEmpty()) {
            clears += key
            return null
        }
        return next
    }
    val seededName = loaded?.displayName?.takeIf { it != loaded.email }.orEmpty()
    val name = displayName.trim().takeIf { it.isNotEmpty() && it != seededName.trim() }
    return AccountChanges(
        displayName = name,
        phone = diff("phone", phone, formatPhone(loaded?.phone)),
        photoUrl = diff("photoUrl", photoUrl, loaded?.photoUrl.orEmpty()),
        backupEmail = diff("backupEmail", backupEmail, loaded?.backupEmail.orEmpty()),
        backupPhone = diff("backupPhone", backupPhone, formatPhone(loaded?.backupPhone)),
        clearFields = clears,
    )
}
