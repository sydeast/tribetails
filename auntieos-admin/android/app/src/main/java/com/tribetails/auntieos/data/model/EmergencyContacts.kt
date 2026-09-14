package com.tribetails.auntieos.data.model

/**
 * Emergency Contacts (#829). Read from the kinfolk doc (array first, flat
 * triple as a fallback until the migration is verified), written only through
 * the `saveEmergencyContacts` callable. Index 0 is called first.
 */
const val EMERGENCY_CONTACTS_MAX = 2
const val EMERGENCY_CONTACT_NAME_MAX = 80
const val EMERGENCY_CONTACT_PHONE_MAX = 32
const val EMERGENCY_CONTACT_RELATIONSHIP_MAX = 40

// #829 review item 4: the server's wording, word for word
// (mytribe/functions/src/lib/emergencyContacts.ts), so a refusal reads the same
// whether this pre-check or the callable caught it.
const val EMERGENCY_CONTACT_REQUIRED = "A household needs at least one Emergency Contact."
const val EMERGENCY_CONTACT_OUTSIDE = "An Emergency Contact has to be someone outside the household."
const val EMERGENCY_CONTACT_NAME_REQUIRED = "An Emergency Contact needs a name."
const val EMERGENCY_CONTACT_PHONE_REQUIRED = "An Emergency Contact needs a phone number."
const val EMERGENCY_CONTACT_NAME_TOO_LONG = "An Emergency Contact's name can be at most $EMERGENCY_CONTACT_NAME_MAX characters."
const val EMERGENCY_CONTACT_PHONE_TOO_LONG = "An Emergency Contact's phone number can be at most $EMERGENCY_CONTACT_PHONE_MAX characters."
const val EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG = "A relationship can be at most $EMERGENCY_CONTACT_RELATIONSHIP_MAX characters."
const val EMERGENCY_CONTACTS_TOO_MANY = "A household can have at most two Emergency Contacts."
const val EMERGENCY_CONTACTS_SAME_PHONE = "The two Emergency Contacts need different phone numbers."
/** The tip beside the Emergency Contacts title on every client. */
const val EMERGENCY_CONTACT_WHO_GETS_CALLED = "Called only when no kinfolk can be reached. The first one is called first."

data class EmergencyContact(
    val name: String,
    val phone: String,
    val relationship: String?,
    val recordedAt: String?,
    val updatedAt: String?,
)

data class EmergencyContactDraft(val name: String = "", val phone: String = "", val relationship: String = "")

data class EmergencyContactsResult(val contacts: List<EmergencyContact>, val canEdit: Boolean, val legacy: Boolean)

private fun text(v: Any?): String = (v as? String)?.trim().orEmpty()

private fun isoOf(v: Any?): String? = when (v) {
    is com.google.firebase.Timestamp -> java.time.Instant.ofEpochSecond(v.seconds, v.nanoseconds.toLong()).toString()
    is String -> v.ifBlank { null }
    else -> null
}

private fun contactFrom(m: Map<*, *>) = EmergencyContact(
    name = text(m["name"]),
    phone = text(m["phone"]),
    relationship = text(m["relationship"]).ifBlank { null },
    recordedAt = isoOf(m["recordedAt"]),
    updatedAt = isoOf(m["updatedAt"]),
)

fun emergencyContactsOf(kinfolk: Kinfolk): List<EmergencyContact> {
    val arr = (kinfolk.emergencyContacts as? List<*>)
        ?.mapNotNull { (it as? Map<*, *>)?.let(::contactFrom) }
        ?.filter { it.name.isNotBlank() || it.phone.isNotBlank() }
        .orEmpty()
    if (arr.isNotEmpty()) return arr
    if (kinfolk.emergencyContactName.isBlank() && kinfolk.emergencyContactPhone.isBlank()) return emptyList()
    return listOf(
        EmergencyContact(
            kinfolk.emergencyContactName.trim(),
            kinfolk.emergencyContactPhone.trim(),
            kinfolk.emergencyContactRelation.trim().ifBlank { null },
            null,
            null,
        ),
    )
}

fun List<EmergencyContact>.toDrafts(): List<EmergencyContactDraft> =
    map { EmergencyContactDraft(it.name, it.phone, it.relationship.orEmpty()) }.ifEmpty { listOf(EmergencyContactDraft()) }

fun List<EmergencyContactDraft>.isBlankDrafts(): Boolean =
    all { it.name.isBlank() && it.phone.isBlank() && it.relationship.isBlank() }

fun draftsEqual(a: List<EmergencyContactDraft>, b: List<EmergencyContactDraft>): Boolean =
    a.size == b.size && a.zip(b).all { (x, y) ->
        x.name.trim() == y.name.trim() && x.phone.trim() == y.phone.trim() && x.relationship.trim() == y.relationship.trim()
    }

private fun comparablePhone(v: String): String = v.filter(Char::isDigit).let { if (it.length == 10) "1$it" else it }
private fun comparableName(v: String): String = v.trim().lowercase().replace(Regex("\\s+"), " ")

fun validateEmergencyContactDrafts(
    drafts: List<EmergencyContactDraft>,
    householdNames: List<String>,
    householdPhones: List<String>,
): String? {
    if (drafts.isEmpty() || drafts.isBlankDrafts()) return EMERGENCY_CONTACT_REQUIRED
    if (drafts.size > EMERGENCY_CONTACTS_MAX) return EMERGENCY_CONTACTS_TOO_MANY
    if (drafts.any { it.name.isBlank() }) return EMERGENCY_CONTACT_NAME_REQUIRED
    if (drafts.any { it.phone.isBlank() }) return EMERGENCY_CONTACT_PHONE_REQUIRED
    if (drafts.any { it.name.trim().length > EMERGENCY_CONTACT_NAME_MAX }) return EMERGENCY_CONTACT_NAME_TOO_LONG
    if (drafts.any { it.phone.trim().length > EMERGENCY_CONTACT_PHONE_MAX }) return EMERGENCY_CONTACT_PHONE_TOO_LONG
    if (drafts.any { it.relationship.trim().length > EMERGENCY_CONTACT_RELATIONSHIP_MAX }) return EMERGENCY_CONTACT_RELATIONSHIP_TOO_LONG
    if (drafts.size == 2 && comparablePhone(drafts[0].phone) == comparablePhone(drafts[1].phone)) {
        return EMERGENCY_CONTACTS_SAME_PHONE
    }
    val names = householdNames.map(::comparableName).filter { it.isNotEmpty() }.toSet()
    val phones = householdPhones.map(::comparablePhone).filter { it.isNotEmpty() }.toSet()
    if (drafts.any { comparableName(it.name) in names || comparablePhone(it.phone) in phones }) return EMERGENCY_CONTACT_OUTSIDE
    return null
}

/** Decodes a callable answer. A missing array is an error, never "none on file". */
fun decodeEmergencyContacts(raw: Map<String, Any?>): List<EmergencyContact> {
    val rows = raw["contacts"] as? List<*> ?: error("Emergency Contacts: no contacts array in the answer")
    return rows.mapNotNull { (it as? Map<*, *>)?.let(::contactFrom) }
}
