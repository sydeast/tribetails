package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Emergency Contacts (#829). Same rules and messages as the Android admin, admin
 * web and the server. Read from the kinfolk doc (array first, flat triple as the
 * fallback until the migration is verified); written ONLY through the
 * `saveEmergencyContacts` callable. Index 0 is called first.
 */
const val EMERGENCY_CONTACTS_MAX = 2
const val EMERGENCY_CONTACT_REQUIRED = "A household needs at least one Emergency Contact"
const val EMERGENCY_CONTACT_OUTSIDE = "An Emergency Contact has to be someone outside the household."
const val EMERGENCY_CONTACT_WHO_GETS_CALLED = "Called only when no kinfolk can be reached. The first one is called first."
/** The flag a household with none shows (Directory card, profile, edit form). A flag, never a block on other edits. */
const val NO_EMERGENCY_CONTACT = "No Emergency Contact"

@Serializable
data class EmergencyContact(
    val name: String = "",
    val phone: String = "",
    val relationship: String? = null,
    val recordedAt: String? = null,
    val updatedAt: String? = null,
)

data class EmergencyContactDraft(val name: String = "", val phone: String = "", val relationship: String = "")

data class EmergencyContactsResult(val contacts: List<EmergencyContact>, val canEdit: Boolean, val legacy: Boolean)

private fun JsonObject.text(key: String): String =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()

fun contactFromJson(o: JsonObject) = EmergencyContact(
    name = o.text("name"),
    phone = o.text("phone"),
    relationship = o.text("relationship").ifBlank { null },
    recordedAt = o.text("recordedAt").ifBlank { null },
    updatedAt = o.text("updatedAt").ifBlank { null },
)

fun emergencyContactsOf(k: Kinfolk): List<EmergencyContact> {
    val arr = (k.emergencyContacts as? JsonArray)
        ?.mapNotNull { (it as? JsonObject)?.let(::contactFromJson) }
        ?.filter { it.name.isNotBlank() || it.phone.isNotBlank() }
        .orEmpty()
    if (arr.isNotEmpty()) return arr
    if (k.emergencyContactName.isBlank() && k.emergencyContactPhone.isBlank()) return emptyList()
    return listOf(
        EmergencyContact(
            k.emergencyContactName.trim(),
            k.emergencyContactPhone.trim(),
            k.emergencyContactRelation.trim().ifBlank { null },
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
    if (drafts.size > EMERGENCY_CONTACTS_MAX) return "A household can have at most two Emergency Contacts."
    if (drafts.any { it.name.isBlank() }) return "Each Emergency Contact needs a name."
    if (drafts.any { it.phone.isBlank() }) return "Each Emergency Contact needs a phone number."
    if (drafts.size == 2 && comparablePhone(drafts[0].phone) == comparablePhone(drafts[1].phone)) {
        return "The two Emergency Contacts need different phone numbers."
    }
    val names = householdNames.map(::comparableName).filter { it.isNotEmpty() }.toSet()
    val phones = householdPhones.map(::comparablePhone).filter { it.isNotEmpty() }.toSet()
    if (drafts.any { comparableName(it.name) in names || comparablePhone(it.phone) in phones }) return EMERGENCY_CONTACT_OUTSIDE
    return null
}

/**
 * The four keys no desktop kinfolk write may carry (#829). The array belongs to
 * the `saveEmergencyContacts` callable, and a create must not write the three flat
 * legacy keys either, not even blank (the same list as Android's
 * `KINFOLK_CREATE_EXCLUDED_FIELDS`). Keeping them out of the update mask also
 * means a desktop save made from a stale read cannot put back a flat triple the
 * migration has already moved.
 */
val KINFOLK_WRITE_EXCLUDED_KEYS: Set<String> = setOf(
    "emergencyContacts",
    "emergencyContactName",
    "emergencyContactPhone",
    "emergencyContactRelation",
)

/** Same configuration as `jsonOut` in FirestoreInterop.jvm.kt, so the body is unchanged apart from the removed keys. */
private val writeJson = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

/**
 * The kinfolk body a desktop write may send: the model minus
 * [KINFOLK_WRITE_EXCLUDED_KEYS]. Both the create body and the update's merge mask
 * are built from it, so neither can touch an Emergency Contact.
 */
fun kinfolkWriteJson(k: Kinfolk): String {
    val obj = writeJson.encodeToJsonElement(Kinfolk.serializer(), k).jsonObject
    return JsonObject(obj.filterKeys { it !in KINFOLK_WRITE_EXCLUDED_KEYS }).toString()
}
