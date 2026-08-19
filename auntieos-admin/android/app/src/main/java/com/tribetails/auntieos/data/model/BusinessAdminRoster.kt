package com.tribetails.auntieos.data.model

/**
 * WHO "every business admin" is, by name (issue #450). The Android read model
 * behind the `listBusinessAdmins` callable.
 *
 * The notification gate resolves every other audience to a description of a
 * person. A `businessAdmins` row could only manage a count and a Firestore
 * path, because `businessSettings/admins` had a write surface and no reader any
 * client could call, so the answer to "who does this reach" was "go and look it
 * up yourself" (which is what #396 was filed against).
 *
 * STAFF DATA, ADMIN ONLY. The callable is behind `wrapAdminCallable` and
 * nothing kinfolk-facing calls it.
 *
 * READ ONLY: the callable walks the server's recipient order WITHOUT the
 * dispatch path's self-heal write, so opening the gate cannot change who
 * receives business mail.
 */

/** One person on the roster. */
data class BusinessAdminMember(
    val uid: String = "",
    /** From `staff/{uid}`. Null when there is no staff record, or it has no name. */
    val displayName: String? = null,
    val email: String? = null,
    /**
     * False when this uid has no `staff/{uid}` document. Not an error: an
     * operator seeded from the `AUNTIE_OPERATOR_UIDS` allowlist can have none,
     * and they receive the mail anyway, so they are listed by uid.
     */
    val hasStaffRecord: Boolean = false,
    /** True when unassigned visits default to this person. */
    val defaultAssignee: Boolean = false,
)

/** Which arm of the server's recipient order answered. */
enum class BusinessAdminRosterSource { Roster, OperatorAllowlist, None }

data class BusinessAdminRoster(
    val members: List<BusinessAdminMember> = emptyList(),
    val source: BusinessAdminRosterSource = BusinessAdminRosterSource.None,
    /** Where the roster lives, so an operator can go and check it. */
    val rosterPath: String = "businessSettings/admins.uids",
    /** Why nobody is on it, when nobody is. Null when there are members. */
    val reason: String? = null,
)

private fun strOrNull(raw: Any?): String? = (raw as? String)?.takeIf { it.isNotBlank() }

fun businessAdminMemberFromMap(m: Map<*, *>): BusinessAdminMember = BusinessAdminMember(
    uid = m["uid"] as? String ?: "",
    displayName = strOrNull(m["displayName"]),
    email = strOrNull(m["email"]),
    // An absent flag reads as "no staff record", so the screen shows the uid
    // rather than claiming a name it was never given.
    hasStaffRecord = m["hasStaffRecord"] as? Boolean ?: false,
    defaultAssignee = m["defaultAssignee"] as? Boolean ?: false,
)

fun businessAdminRosterFromMap(raw: Map<*, *>): BusinessAdminRoster = BusinessAdminRoster(
    members = (raw["members"] as? List<*>).orEmpty().mapNotNull { item ->
        businessAdminMemberFromMap(item as? Map<*, *> ?: return@mapNotNull null)
    },
    source = when (raw["source"] as? String) {
        "roster" -> BusinessAdminRosterSource.Roster
        "operatorAllowlist" -> BusinessAdminRosterSource.OperatorAllowlist
        else -> BusinessAdminRosterSource.None
    },
    rosterPath = strOrNull(raw["rosterPath"]) ?: "businessSettings/admins.uids",
    reason = strOrNull(raw["reason"]),
)
