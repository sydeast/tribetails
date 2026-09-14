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
 * The body a desktop kinfolk CREATE sends: the model minus
 * [KINFOLK_WRITE_EXCLUDED_KEYS], so a new household never writes an Emergency
 * Contact key. Updates send [kinfolkChanges] instead.
 */
fun kinfolkWriteJson(k: Kinfolk): String {
    val obj = writeJson.encodeToJsonElement(Kinfolk.serializer(), k).jsonObject
    return JsonObject(obj.filterKeys { it !in KINFOLK_WRITE_EXCLUDED_KEYS }).toString()
}

/**
 * One field a desktop kinfolk update writes. [path] is the field path as
 * segments (`["gateCode"]`, `["formValues", "pet.name"]`); a null [value] deletes
 * that field.
 */
data class KinfolkFieldChange(val path: List<String>, val value: kotlinx.serialization.json.JsonElement?)

/** The map field that is diffed key by key, so one custom field's edit never rewrites another's. */
private const val PER_KEY_MAP_FIELD = "formValues"

/**
 * #829 review: what a desktop kinfolk UPDATE writes, which is only the fields
 * whose value in [edited] differs from [loaded] (what the caller read). A save
 * never rewrites a field it did not change, so a concurrent change to `tags`,
 * `outstandingBalance`, `status` or a portal-edited field survives it.
 *
 * `formValues` is diffed per key: a changed or added key is one change at
 * `formValues.<key>`, a removed key is a delete at that path. Editing one custom
 * field therefore cannot overwrite another admin's change to a different key.
 *
 * Never includes `_id` or an Emergency Contact key. Empty means nothing to write.
 * Android does the same through `DirectoryFieldChanges` (DirectoryViewModel.kt:1187).
 */
fun kinfolkChanges(loaded: Kinfolk, edited: Kinfolk): List<KinfolkFieldChange> {
    val before = writeJson.encodeToJsonElement(Kinfolk.serializer(), loaded).jsonObject
    val after = writeJson.encodeToJsonElement(Kinfolk.serializer(), edited).jsonObject
    val changes = mutableListOf<KinfolkFieldChange>()
    for ((key, value) in after) {
        if (key == "_id" || key in KINFOLK_WRITE_EXCLUDED_KEYS) continue
        val old = before[key]
        if (key == PER_KEY_MAP_FIELD && value is JsonObject && (old == null || old is JsonObject)) {
            val oldMap = old as? JsonObject ?: JsonObject(emptyMap())
            for ((k, v) in value) if (oldMap[k] != v) changes += KinfolkFieldChange(listOf(key, k), v)
            for (k in oldMap.keys) if (k !in value) changes += KinfolkFieldChange(listOf(key, k), null)
        } else if (old != value) {
            changes += KinfolkFieldChange(listOf(key), value)
        }
    }
    return changes
}

private val SIMPLE_FIELD_SEGMENT = Regex("^[A-Za-z_][A-Za-z_0-9]*$")

/**
 * A Firestore field path for `updateMask.fieldPaths`. A segment that is a plain
 * identifier stays as it is; anything else (a dot, a space, a dash, a leading
 * digit) is wrapped in backticks with backslash and backtick escaped, per the
 * Firestore field-path grammar. `["formValues", "pet.name"]` -> formValues.`pet.name`.
 */
fun firestoreFieldPath(path: List<String>): String {
    require(path.isNotEmpty() && path.none { it.isEmpty() }) { "a field path needs non-empty segments: $path" }
    return path.joinToString(".") { seg ->
        if (SIMPLE_FIELD_SEGMENT.matches(seg)) seg
        else "`" + seg.replace("\\", "\\\\").replace("`", "\\`") + "`"
    }
}

/**
 * The nested plain body for [changes]: each set value placed at its path, each
 * delete left out (a path in the mask but absent from the body is deleted).
 */
fun kinfolkChangesBody(changes: List<KinfolkFieldChange>): JsonObject {
    val root = mutableMapOf<String, Any>()
    for (change in changes) {
        val value = change.value ?: continue
        var node = root
        for (seg in change.path.dropLast(1)) {
            @Suppress("UNCHECKED_CAST")
            node = node.getOrPut(seg) { mutableMapOf<String, Any>() } as MutableMap<String, Any>
        }
        node[change.path.last()] = value
    }
    fun toJson(m: Map<String, Any>): JsonObject = JsonObject(
        m.mapValues { (_, x) ->
            @Suppress("UNCHECKED_CAST")
            if (x is kotlinx.serialization.json.JsonElement) x else toJson(x as Map<String, Any>)
        },
    )
    return toJson(root)
}
