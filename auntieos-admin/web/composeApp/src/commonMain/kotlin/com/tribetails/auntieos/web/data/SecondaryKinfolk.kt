package com.tribetails.auntieos.web.data
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
/**
 * Secondary kinfolk person records (operator ruling 2026-09-27, Q3), read and
 * written only through `listSecondaryKinfolk` / `saveSecondaryKinfolk` /
 * `removeSecondaryKinfolk` (mytribe/functions/src/portal/secondaryKinfolk.ts).
 * A person with no portal account yet. The desktop console adds, edits and
 * removes them; it never invites one. Only the household's primary can.
 */
enum class PersonAccess { NONE, INVITED, ACTIVE }
data class SecondaryPerson(
    val personId: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val access: PersonAccess,
    val memberUid: String?,
)
/** What the add/edit dialog sends. `personId` null creates. */
data class SecondaryPersonDraft(
    val personId: String? = null,
    val name: String = "",
    val phone: String = "",
    val email: String = "",
)
const val SECONDARY_KINFOLK_NAME_MAX = 80
/** The server's refusal, word for word. */
const val SECONDARY_KINFOLK_NAME_REQUIRED = "A secondary kinfolk needs a name."
/** The state label on a person row. */
fun personAccessLabel(access: PersonAccess): String = when (access) {
    PersonAccess.NONE -> "No portal access"
    PersonAccess.INVITED -> "Invited"
    PersonAccess.ACTIVE -> "Portal access"
}
/** The dialog seeded from the stored person exactly, so an edit rebuilds nothing. */
fun SecondaryPerson.toDraft() = SecondaryPersonDraft(personId, name, phone.orEmpty(), email.orEmpty())
private fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.ifBlank { null }
/** One row; null when it carries no id. */
fun secondaryPersonFromJson(o: JsonObject): SecondaryPerson? {
    val id = o.str("personId") ?: return null
    return SecondaryPerson(
        personId = id,
        name = o.str("name") ?: "(no name)",
        phone = o.str("phone"),
        email = o.str("email"),
        access = when (o.str("access")) {
            "INVITED" -> PersonAccess.INVITED
            "ACTIVE" -> PersonAccess.ACTIVE
            else -> PersonAccess.NONE
        },
        memberUid = o.str("memberUid"),
    )
}
/** A missing `people` array is an error, never an empty household. */
fun secondaryPeopleFromJson(o: JsonObject): List<SecondaryPerson> {
    val rows = o["people"] as? JsonArray ?: error("listSecondaryKinfolk: no people array in the answer")
    return rows.mapNotNull { (it as? JsonObject)?.let(::secondaryPersonFromJson) }
}
