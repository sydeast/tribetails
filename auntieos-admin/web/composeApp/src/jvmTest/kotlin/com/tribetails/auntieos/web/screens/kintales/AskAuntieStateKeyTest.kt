package com.tribetails.auntieos.web.screens.kintales

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2052: what Ask Auntie holds on the desktop composer must outlive a new
 * tale's first save.
 *
 * A new tale gets its id on its first save, and taking Auntie's draft is what
 * triggers that save. State remembered under the tale's id is forgotten at
 * that moment, so the notes the Auntie typed would be dropped in the same step
 * that replaced them, with "Back to my notes" gone. The composer is a
 * composable with no view model to test, so this reads its source: the state
 * is keyed like the tale itself (visit and identity), never on the tale's id.
 */
class AskAuntieStateKeyTest {
    private val composer = File(
        "src/commonMain/kotlin/com/tribetails/auntieos/web/screens/kintales/KinTaleComposeScreen.kt",
    ).readText()

    @Test
    fun askAuntieStateIsKeyedOnTheVisitNotOnTheTalesId() {
        assertTrue(
            composer.contains("var ask by remember(session._id, identity) { mutableStateOf(AskAuntieState()) }"),
            "Ask Auntie state must be remembered under the visit and identity",
        )
        assertTrue(composer.contains("var lastOpening by remember(session._id, identity)"))
    }

    @Test
    fun neitherIsRememberedUnderTheTalesId() {
        for (name in listOf("ask", "lastOpening")) {
            assertFalse(
                composer.contains("var $name by remember(report._id)"),
                "$name keyed on report._id is forgotten when a new tale is first saved",
            )
        }
    }
    @Test
    fun theDraftReachesTheNoteOnlyThroughUseThisDraft() {
        // The generate path offers the draft; it never assigns the note.
        val generate = composer.substringAfter("fun generateDraft()").substringBefore("fun useAuntieDraft()")
        assertTrue(generate.contains("ask = ask.offer(copy)"))
        assertFalse(generate.contains("bodyCopy ="), "generateDraft must not write the note")
        assertFalse(generate.contains("persistDraft("), "generateDraft must not save")
    }
}
