package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.AUNTIE_TIMEOUT_MESSAGE
import com.tribetails.auntieos.web.data.FieldResponse
import com.tribetails.auntieos.web.data.GENERATE_FAILED_COPY
import com.tribetails.auntieos.web.data.GENERATE_SIGN_IN_COPY
import com.tribetails.auntieos.web.data.GenerateCareTask
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleTemplate
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.responseKey

/**
 * Ask Auntie on the KinTale composer: the rules, with no screen in them.
 *
 * #2052. The draft Auntie writes used to go straight into the note. The notes
 * the Auntie had typed were gone with no way back, and whatever the draft made
 * up read as her own words. Now the draft is held BESIDE the note until she
 * takes it, and what she replaced can be put back. The admin web and Android
 * composers follow the same rules under the same names.
 */

/**
 * The Auntie's own notes, kept from the moment she took a draft. [draftBody] is
 * the draft as it went in, which is how a later Ask Auntie tells her notes from
 * Auntie's words.
 */
data class KeptNotes(val notes: String, val draftBody: String)

/**
 * What Ask Auntie works from. Her notes, always. While the note still holds
 * the draft exactly as Auntie wrote it, the notes are the ones kept from
 * before, so asking again never feeds a draft back in as though the Auntie had
 * said it. Once she has changed the note, it is her words again.
 */
fun notesForAuntie(body: String, kept: KeptNotes?): String =
    if (kept != null && body == kept.draftBody) kept.notes else body

/**
 * Everything Ask Auntie holds on a composer: the draft on offer and the notes
 * kept from before one was taken. One value, so the composer keeps it for as
 * long as it is open on a visit. It must NOT be tied to the tale's own id: a
 * new tale gets its id on its first save, which taking a draft triggers, and
 * the notes would be dropped in the same step that replaced them.
 */
data class AskAuntieState(val offered: String? = null, val kept: KeptNotes? = null) {
    /** Auntie wrote a draft. It is offered; the note is not touched. */
    fun offer(draft: String): AskAuntieState = copy(offered = draft)
    /** The Auntie set the offered draft aside. */
    fun dismiss(): AskAuntieState = copy(offered = null)
    /**
     * The Auntie took the offered draft over [body]. Returns the new state and
     * the note's new text, or null when nothing is on offer. Notes already kept
     * stay the notes, so a second draft taken over the first never makes the
     * first "her notes".
     */
    fun take(body: String): Pair<AskAuntieState, String>? {
        val draft = offered ?: return null
        return AskAuntieState(offered = null, kept = KeptNotes(notesForAuntie(body, kept), draft)) to draft
    }
    /** Put her notes back. Returns the new state and the note's text, or null when none are kept. */
    fun restore(): Pair<AskAuntieState, String>? {
        val notes = kept?.notes ?: return null
        return copy(kept = null) to notes
    }
}
/**
 * The notes a SAVED tale still holds, for a composer that was closed and
 * reopened, here or on another device. Null when it holds none, which is every
 * tale saved before the notes were kept.
 */
fun KinCareReport.keptNotesOrNull(): KeptNotes? =
    if (keptNotes.isBlank()) null else KeptNotes(notes = keptNotes, draftBody = keptNotesDraft)
/** What Ask Auntie holds when the composer opens on [resumed] (null for a new tale). */
fun askAuntieStateFor(resumed: KinCareReport?): AskAuntieState = AskAuntieState(kept = resumed?.keptNotesOrNull())
/**
 * The tale with Auntie's draft taken as its note. [kept] goes onto the tale
 * with it, so the one save carries the draft and the notes it replaced. A tale
 * already sent keeps them on the screen only: a sent tale never carries
 * working notes.
 */
fun KinCareReport.withDraftTaken(body: String, kept: KeptNotes?): KinCareReport {
    val keep = kept != null && !status.trim().equals("SENT", ignoreCase = true)
    return copy(
        bodyCopy = body,
        keptNotes = if (keep) kept!!.notes else "",
        keptNotesDraft = if (keep) kept!!.draftBody else "",
    )
}
/** The tale with her notes back as its note, and nothing left to put back. */
fun KinCareReport.withNotesRestored(notes: String): KinCareReport =
    copy(bodyCopy = notes, keptNotes = "", keptNotesDraft = "")
/** The Ask Auntie button's words: what it will do, or that it is doing it. */
fun askAuntieLabel(isGenerating: Boolean, hasAskedBefore: Boolean): String = when {
    isGenerating -> "Auntie is writing…"
    hasAskedBefore -> "Ask Auntie again"
    else -> "Ask Auntie"
}

/**
 * The care tasks ticked on the composer right now, in the order it shows them:
 * the whole-visit ones, then each Kin's. Ask Auntie sends these so a draft can
 * say what was done and cannot say what was not. They are the same rows the
 * Auntie sees ([visiblePerVisitItems], [visiblePerPetItems]), so a task hidden
 * for this visit or this Kin is never reported.
 */
internal fun tickedCareTasks(
    template: KinTaleTemplate,
    session: KinCareSession,
    kinList: List<Kin>,
    kinfolk: Kinfolk?,
    responses: Map<String, FieldResponse>,
): List<GenerateCareTask> {
    if (!template.checklistEnabled) return emptyList()
    val items = template.checklistItems.sortedBy { it.order }
    val perPet = items.filter { it.scope.equals("PER_PET", ignoreCase = true) }
    val perVisit = items.filterNot { it.scope.equals("PER_PET", ignoreCase = true) }
    fun ticked(key: String, kinId: String): Boolean = responses[responseKey(key, kinId)]?.boolValue == true

    val out = mutableListOf<GenerateCareTask>()
    for (item in visiblePerVisitItems(perVisit, session, kinList, kinfolk)) {
        val text = item.text.trim()
        if (text.isNotEmpty() && ticked(item.key, "")) out += GenerateCareTask(text = text, kin_name = "")
    }
    for (kin in kinList) {
        for (item in visiblePerPetItems(perPet, session, kin, kinfolk)) {
            val text = item.text.trim()
            if (text.isNotEmpty() && ticked(item.key, kin._id)) {
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
 * inside `No Kinfolk with id "..."`), a reply with no message, and the
 * network layer's own errors. None of those is shown.
 */
object AskAuntieCopy {
    const val FAILED = GENERATE_FAILED_COPY
    const val DAILY_LIMIT = "Auntie has written all she can for today. She can draft again tomorrow."
    const val SIGN_IN = GENERATE_SIGN_IN_COPY
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

    /** What the server's `error` field reads as. */
    fun plain(error: String?): String {
        val text = error?.trim().orEmpty()
        if (text == "generate_rate_limit_exceeded") return DAILY_LIMIT
        if (text == "admin_required") return OWNER_ONLY
        if (text.isEmpty() || storedCode.matches(text) || olderGenerator.containsMatchIn(text)) return FAILED
        return text
    }

    /**
     * What a thrown failure reads as. Only words this app wrote itself are let
     * through; anything else (a transport error, a parse error) is [FAILED].
     */
    fun forFailure(t: Throwable): String = when (val message = t.message) {
        AUNTIE_TIMEOUT_MESSAGE, SIGN_IN, FAILED, DAILY_LIMIT -> message
        else -> FAILED
    }
}
