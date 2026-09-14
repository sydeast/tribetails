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
 * A person the household can be reached through who holds NO portal account.
 *
 * OPERATOR RULING (2026-09-12): "a secondary contact does not have to be a
 * portal user. primary kinfolk user will invite a second kinfolk to the
 * household to manage and receive notifications." Two gestures with two
 * outcomes. [Member] above is the second one: a uid, a role, a status and a
 * [MemberPermissions] set, because there is something to sign in to. A contact
 * has none of those four, and the absence is the type — there is no field here
 * for a screen to fill with a permission, so the two cannot quietly merge back
 * into one.
 *
 * [label] is what this person is to the household — "Sister", "Neighbour" — and
 * the server defaults it to "Folk" when nobody says. [email] is somewhere to
 * reach them and nothing more: no `inviteRequests` row is written for a contact
 * and no account is minted.
 */
/** `CONTACT_NAME_MAX` in `mytribe/functions/src/portal/householdContacts.ts`. */
const val CONTACT_NAME_MAX = 80

/** `CONTACT_PHONE_MAX`, same file. */
const val CONTACT_PHONE_MAX = 32

/** `SECONDARY_LABEL_MAX` in `mytribe/functions/src/lib/schema.ts`. */
const val CONTACT_LABEL_MAX = 24

/** `DEFAULT_CONTACT_LABEL`. What a contact is called when nobody says. */
const val DEFAULT_CONTACT_LABEL = "Folk"

data class HouseholdContact(
    val contactId: String,
    val name: String,
    val label: String,
    /** Null means there is none, never "unknown". */
    val phone: String?,
    val email: String?,
    /** ISO-8601 from the server, or null. Display only. */
    val createdAt: String?,
    val updatedAt: String?,
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
 * What `saveHouseholdContact` answers.
 *
 * [created] is the difference between "we wrote somebody new down" and "we
 * corrected a row", and the card says different things about each: only the
 * first one needs to say that no portal account came with it.
 */
data class SavedHouseholdContact(
    val contactId: String,
    val created: Boolean,
)

/** "Sister · 805 555 0143 · ada@example.com", skipping what is absent. */
fun HouseholdContact.metaLine(): String =
    listOfNotNull(label, phone, email).filter { it.isNotBlank() }.joinToString(" · ")
