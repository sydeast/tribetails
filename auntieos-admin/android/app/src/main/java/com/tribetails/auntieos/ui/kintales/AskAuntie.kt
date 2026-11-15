package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.FieldResponse
import com.tribetails.auntieos.data.model.GenerateCareTask
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.Kinfolk
import java.io.IOException

/**
 * Ask Auntie on the KinTale composer: the rules, with no screen in them.
 *
 * #2052. The draft Auntie writes used to go straight into the narrative. The
 * notes the Auntie had typed were gone with no way back, and whatever the draft
 * made up read as her own words. Now the draft is held BESIDE the narrative
 * until she takes it, and what she replaced can be put back.
 */

/**
 * The Auntie's own notes, kept from the moment she took a draft. [draftBody] is
 * the draft as it went in, which is how a later Ask Auntie tells her notes from
 * Auntie's words.
 */
data class KeptNotes(val notes: String, val draftBody: String)

/**
 * What Ask Auntie works from. Her notes, always. While the narrative still
 * holds the draft exactly as Auntie wrote it, the notes are the ones kept from
 * before, so asking again never feeds a draft back in as though the Auntie had
 * said it. Once she has changed the narrative, it is her words again.
 */
fun notesForAuntie(body: String, kept: KeptNotes?): String =
    if (kept != null && body == kept.draftBody) kept.notes else body

/**
 * The care tasks ticked on the composer right now, in the order it shows them:
 * the whole-visit ones, then each Kin's. Ask Auntie sends these so a draft can
 * say what was done and cannot say what was not. They are the same rows the
 * Auntie sees ([visiblePerVisitItems], [applicablePerPetItems]), so a task
 * hidden for this visit or this Kin is never reported.
 */
fun tickedCareTasks(
    template: KinTaleTemplate,
    session: KinCareSession?,
    kinList: List<Kin>,
    kinfolk: Kinfolk?,
    responses: Map<String, FieldResponse>,
): List<GenerateCareTask> {
    if (session == null || !template.checklistEnabled) return emptyList()
    val items = template.checklistItems.sortedBy { it.order }
    val isPerPet = { item: ChecklistItem -> item.scope.equals(ChecklistScope.PER_PET.name, ignoreCase = true) }
    fun ticked(item: ChecklistItem, kinId: String): Boolean =
        responses[if (kinId.isBlank()) item.key else "$kinId|${item.key}"]?.boolValue == true

    val out = mutableListOf<GenerateCareTask>()
    for (item in visiblePerVisitItems(items.filterNot(isPerPet), session, kinList, kinfolk)) {
        val text = item.text.trim()
        if (text.isNotEmpty() && ticked(item, "")) out += GenerateCareTask(text = text, kin_name = "")
    }
    for (kin in kinList) {
        for (item in applicablePerPetItems(items.filter(isPerPet), session, kinList, kin, kinfolk)) {
            val text = item.text.trim()
            if (text.isNotEmpty() && ticked(item, kin.id)) {
                out += GenerateCareTask(text = text, kin_name = kin.name.trim())
            }
        }
    }
    return out
}

/**
 * The words a failed Ask Auntie puts on screen.
 *
 * The generator answers in plain sentences, and those are shown as sent. This
 * guards the rest: a generator released before it learned to (stored codes such
 * as `generate_rate_limit_exceeded`, the provider's own error, a record id
 * inside `No Kinfolk with id "..."`), a reply with no message, and the device's
 * own network errors. None of those is shown.
 */
object AskAuntieCopy {
    const val FAILED = "Auntie could not write a draft just now. Try again in a moment."
    const val UNREACHABLE = "Auntie could not be reached. Check the connection and try again."
    const val DAILY_LIMIT = "Auntie has written all she can for today. She can draft again tomorrow."
    const val SIGN_IN = "Sign in again, then ask Auntie."
    /** The generator is the owner's alone (#944); trying again will not change that. */
    const val OWNER_ONLY = "Only the owner can ask Auntie for a draft."
    const val NEEDS_NOTES = "Jot a few notes first so Auntie has something to work with."
    const val NO_KINFOLK = "This KinCare has no linked Kinfolk to write to."

    private val storedCode = Regex("^[A-Za-z0-9_]+$")
    private val olderGenerator = Regex(
        "^(Claude API error|Claude returned|No Kinfolk with id|Voice source file|" +
            "communication_type must|raw_notes is required)",
        RegexOption.IGNORE_CASE,
    )

    /** What the server's `error` field reads as. [status] is the HTTP status, or null. */
    fun plain(error: String?, status: Int? = null): String {
        val text = error?.trim().orEmpty()
        if (status == 429 || text == "generate_rate_limit_exceeded") return DAILY_LIMIT
        if (status == 403 || text == "admin_required") return OWNER_ONLY
        if (text.isEmpty() || storedCode.matches(text) || olderGenerator.containsMatchIn(text)) return FAILED
        return text
    }

    /** What a failed call reads as. A [GenerateFailure] already carries plain words. */
    fun forFailure(e: Throwable): String = when (e) {
        is GenerateFailure -> e.message ?: FAILED
        is IOException -> UNREACHABLE
        else -> FAILED
    }
}

/** A failed generate whose message is already fit to show. */
class GenerateFailure(message: String) : Exception(message)
