package com.kinfolk.portal.portal

data class CustomField(val key: String, val label: String, val value: String)

data class TribeProfile(
    val kinfolkId: String,
    val displayName: String,
    val customFields: List<CustomField>,
)

data class HomeAccess(
    val gateCode: String?,
    val keyLocation: String?,
    val wifiPassword: String?,
    val customFields: List<CustomField>,
    val updatedAtMs: Long?,
)

data class TribeProfileResult(
    val profile: TribeProfile,
    val homeAccess: HomeAccess,
    /**
     * #843: may this caller change home details, the Emergency Contact included.
     * A backend older than #843 sends nothing, which reads as allowed; the
     * server enforces the rule either way.
     */
    val canEditHomeDetails: Boolean = true,
)

/**
 * The six household-member permission flags, mirroring the backend
 * `MemberPermissions` shape. Every flag defaults to false so a sparse or
 * missing permissions object always yields a complete, safe (no-access) record.
 *
 * Five of these are writable by a PRIMARY via `updateSecondaryPermissions`
 * (billing_full, messaging_direct, messaging_group, kin_edit, home_access), per
 * the operator ruling: "besides admin, primary kinfolk can set permissions for
 * the secondary ... including billing if they want." kintales_only is surfaced
 * for display but is never editable from anywhere; it is always on.
 */
data class MemberPermissions(
    val billing_full: Boolean = false,
    val messaging_direct: Boolean = false,
    val messaging_group: Boolean = false,
    val kin_edit: Boolean = false,
    val kintales_only: Boolean = false,
    val home_access: Boolean = false,
)

/**
 * A single member of the household as returned by the `listMembers` callable.
 * [role] is "PRIMARY" or "SECONDARY"; [status] is "ACTIVE", "SUSPENDED", or
 * "INVITED". The editor renders only SECONDARY rows and toggles a subset of
 * [permissions] via `updateSecondaryPermissions`.
 */
data class Member(
    val uid: String,
    val secondaryLabel: String?,
    val role: String,
    val status: String,
    val permissions: MemberPermissions,
    val invitedEmail: String?,
)

/**
 * #829. An Emergency Contact: called only when no kinfolk can be reached, never
 * messaged, no portal access. [phone] is what the server stored (E.164).
 * [recordedAt] and [updatedAt] are ISO-8601 or null, display only.
 */
data class EmergencyContactDto(
    val name: String,
    val phone: String,
    val relationship: String?,
    val recordedAt: String?,
    val updatedAt: String?,
)

/** What `listEmergencyContacts` answers. [canEdit] is true only with home_access. */
data class EmergencyContactsResult(val contacts: List<EmergencyContactDto>, val canEdit: Boolean, val legacy: Boolean)

/** One slot as the card edits it. An empty [relationship] is sent as null, which clears it. */
data class EmergencyContactInput(val name: String, val phone: String, val relationship: String)

/**
 * 2026-09-27 Q3. A secondary kinfolk the primary added to the household, from
 * `listSecondaryKinfolk` (`families/{id}/secondaryKinfolk`). [access] is "NONE"
 * (no portal account), "INVITED" (the primary sent an invite) or "ACTIVE" (they
 * accepted, and are already in the household members list). Phone and email
 * are optional; null means there is none.
 */
data class SecondaryKinfolkDto(
    val personId: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val access: String,
    val memberUid: String?,
    val createdAt: String?,
)
