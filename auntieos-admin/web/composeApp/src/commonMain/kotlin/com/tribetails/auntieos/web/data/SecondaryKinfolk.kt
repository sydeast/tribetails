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
const val SECONDARY_PHONE_INVALID = "Enter a 10-digit phone number, or leave it blank."
const val SECONDARY_EMAIL_INVALID = "Enter an email like name@example.com, or leave it blank."
/**
 * The server's checks on a secondary kinfolk, made before the save (#1593), so
 * a bad phone or email is refused at once instead of after the round trip. The
 * first problem wins, in the form's order. The server keeps its own checks.
 */
fun secondaryKinfolkDraftError(draft: SecondaryPersonDraft): String? = when {
    draft.name.isBlank() -> SECONDARY_KINFOLK_NAME_REQUIRED
    draft.phone.isNotBlank() && !com.tribetails.auntieos.web.util.isValidPhone(draft.phone) -> SECONDARY_PHONE_INVALID
    draft.email.isNotBlank() && !com.tribetails.auntieos.web.util.isValidEmail(draft.email) -> SECONDARY_EMAIL_INVALID
    else -> null
}
/**
 * #1593: each field's own refusal, so the dialog puts every sentence under the
 * field it is about. The server (`portal/secondaryKinfolk.ts`) refuses with the
 * same sentences.
 */
data class SecondaryKinfolkFieldErrors(
    val name: String? = null,
    val phone: String? = null,
    val email: String? = null,
) {
    val any: Boolean get() = name != null || phone != null || email != null
}
fun secondaryKinfolkFieldErrors(draft: SecondaryPersonDraft): SecondaryKinfolkFieldErrors = SecondaryKinfolkFieldErrors(
    name = if (draft.name.isBlank()) SECONDARY_KINFOLK_NAME_REQUIRED else null,
    phone = if (draft.phone.isNotBlank() && !com.tribetails.auntieos.web.util.isValidPhone(draft.phone)) SECONDARY_PHONE_INVALID else null,
    email = if (draft.email.isNotBlank() && !com.tribetails.auntieos.web.util.isValidEmail(draft.email)) SECONDARY_EMAIL_INVALID else null,
)
/** A server refusal that names one of the three fields, placed on that field; null otherwise. */
fun secondaryKinfolkServerFieldErrors(message: String?): SecondaryKinfolkFieldErrors? = when (message) {
    SECONDARY_KINFOLK_NAME_REQUIRED -> SecondaryKinfolkFieldErrors(name = message)
    SECONDARY_PHONE_INVALID -> SecondaryKinfolkFieldErrors(phone = message)
    SECONDARY_EMAIL_INVALID -> SecondaryKinfolkFieldErrors(email = message)
    else -> null
}
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
