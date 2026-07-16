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
)

/**
 * The six household-member permission flags, mirroring the backend
 * `MemberPermissions` shape. Every flag defaults to false so a sparse or
 * missing permissions object always yields a complete, safe (no-access) record.
 *
 * Only four of these are writable by a PRIMARY via `updateSecondaryPermissions`
 * (messaging_direct, messaging_group, kin_edit, home_access). billing_full and
 * kintales_only are surfaced for display/correctness but are never editable from
 * the kinfolk app (billing is PRIMARY-only; kintales is always-on).
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
